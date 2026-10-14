package main

import (
	"beaconrelay/roundsvc/pb"
	"context"
	"errors"
	"fmt"
	"google.golang.org/protobuf/proto"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func open(t *testing.T, dir string, delay time.Duration) *Service {
	t.Helper()
	s, err := NewService(dir, delay)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func waitCompleted(t *testing.T, s *Service, id string) Round {
	t.Helper()
	for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		if r, _ := s.GetRound(context.Background(), id); r.Status == "completed" {
			return r
		}
	}
	t.Fatalf("round %s never completed", id)
	return Round{}
}

func allEvents(t *testing.T, s *Service) []Event {
	events, _, err := s.ListEvents(context.Background(), 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	return events
}

func TestConcurrentDuplicatesCreateOneRound(t *testing.T) {
	s := open(t, t.TempDir(), time.Hour)
	defer s.Close()
	ids := make(chan string, 20)
	var wg sync.WaitGroup
	for range 20 {
		wg.Go(func() {
			r, err := s.StartRound(context.Background(), "req", "p1", 1)
			if err != nil {
				t.Error(err)
			}
			ids <- r.RoundID
		})
	}
	wg.Wait()
	close(ids)
	first := <-ids
	for id := range ids {
		if id != first {
			t.Fatalf("duplicate created a second round: %s vs %s", id, first)
		}
	}
	if n := len(allEvents(t, s)); n != 1 {
		t.Fatalf("want 1 accepted event, got %d", n)
	}
}

func TestConflictAndPlayerGuard(t *testing.T) {
	s := open(t, t.TempDir(), time.Hour)
	defer s.Close()
	ctx := context.Background()
	if _, err := s.StartRound(ctx, "a", "p1", 0); err != nil {
		t.Fatal(err)
	}
	if _, err := s.StartRound(ctx, "a", "p1", 2); !errors.Is(err, errConflict) {
		t.Fatalf("changed payload: want conflict, got %v", err)
	}
	if _, err := s.StartRound(ctx, "b", "p1", 0); !errors.Is(err, errInProgress) {
		t.Fatalf("second pending round: want in-progress, got %v", err)
	}
	if _, err := s.StartRound(ctx, "c", "p2", 0); err != nil {
		t.Fatalf("other player must proceed independently: %v", err)
	}
	if _, err := s.StartRound(ctx, "bad id!", "p3", 0); !errors.Is(err, errInvalidRequest) {
		t.Fatalf("invalid id: got %v", err)
	}
	if _, err := s.StartRound(ctx, "d", "p3", 3); !errors.Is(err, errInvalidRequest) {
		t.Fatalf("invalid choice: got %v", err)
	}
	if n := len(allEvents(t, s)); n != 2 {
		t.Fatalf("invalid input must create no state; events=%d", n)
	}
}

func TestCompletionHappensOnceAfterDelay(t *testing.T) {
	delay := 50 * time.Millisecond
	s := open(t, t.TempDir(), delay)
	defer s.Close()
	r, _ := s.StartRound(context.Background(), "a", "p1", 1)
	done := waitCompleted(t, s, r.RoundID)
	created, _ := time.Parse(timeLayout, done.CreatedAt)
	finished, _ := time.Parse(timeLayout, done.CompletedAt)
	if finished.Sub(created) < delay {
		t.Fatalf("completed early: %v", finished.Sub(created))
	}
	if *done.Target != targetFor(r.RoundID) || (*done.Score == 1) != (r.Choice == *done.Target) {
		t.Fatalf("wrong outcome %+v", done)
	}
	// A late duplicate completion (e.g. a stray timer) must be a no-op.
	s.do(context.Background(), func() { s.complete(r.RoundID) })
	events := allEvents(t, s)
	if len(events) != 2 || events[0].Type != "round.accepted" || events[1].Type != "round.completed" {
		t.Fatalf("want exactly accepted+completed, got %+v", events)
	}
	if events[0].Round.Target != nil {
		t.Fatal("accepted snapshot must not expose a target")
	}
}

func TestRestartRecoversPendingAndPreservesHistory(t *testing.T) {
	dir := t.TempDir()
	delay := 100 * time.Millisecond
	s := open(t, dir, delay)
	done, _ := s.StartRound(context.Background(), "done", "p1", 0)
	waitCompleted(t, s, done.RoundID)
	pending, _ := s.StartRound(context.Background(), "pending", "p2", 2)
	before := allEvents(t, s)
	s.Close() // stands in for a kill: nothing is flushed on close that wasn't already synced

	time.Sleep(delay) // pending round is now overdue
	s = open(t, dir, delay)
	defer s.Close()
	recovered := waitCompleted(t, s, pending.RoundID)
	if recovered.CreatedAt != pending.CreatedAt || recovered.RoundID != pending.RoundID {
		t.Fatal("recovery changed identity or timestamps")
	}
	after := allEvents(t, s)
	if len(after) != 4 {
		t.Fatalf("want 4 events after recovery, got %d", len(after))
	}
	for i, e := range before {
		if after[i].Sequence != e.Sequence || after[i].Round.RoundID != e.Round.RoundID || after[i].Round.Status != e.Round.Status {
			t.Fatalf("history changed at %d", i)
		}
	}
	if r, _ := s.StartRound(context.Background(), "pending", "p2", 2); r.RoundID != pending.RoundID {
		t.Fatal("requestId dedup lost across restart")
	}
}

func TestTornTailIsTruncated(t *testing.T) {
	dir := t.TempDir()
	s := open(t, dir, time.Hour)
	s.StartRound(context.Background(), "a", "p1", 0)
	s.Close()
	file := filepath.Join(dir, "events.jsonl")
	f, _ := os.OpenFile(file, os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString(`{"sequence":2,"type":"round.acc`) // crash mid-append
	f.Close()

	s = open(t, dir, time.Hour)
	defer s.Close()
	if n := len(allEvents(t, s)); n != 1 {
		t.Fatalf("torn tail should be dropped, got %d events", n)
	}
	if _, err := s.StartRound(context.Background(), "b", "p2", 0); err != nil {
		t.Fatal(err)
	}
	if events := allEvents(t, s); events[1].Sequence != 2 {
		t.Fatal("append after truncation must continue the sequence")
	}
}

func TestListEventsPaging(t *testing.T) {
	s := open(t, t.TempDir(), time.Hour)
	defer s.Close()
	for _, p := range []string{"p1", "p2", "p3"} {
		s.StartRound(context.Background(), "r_"+p, p, 0)
	}
	page, next, _ := s.ListEvents(context.Background(), 1, 1)
	if len(page) != 1 || page[0].Sequence != 2 || next != 2 {
		t.Fatalf("page=%+v next=%d", page, next)
	}
	page, next, _ = s.ListEvents(context.Background(), 9, 0)
	if len(page) != 0 || next != 9 {
		t.Fatalf("empty page must echo cursor; next=%d", next)
	}
	if _, _, err := s.ListEvents(context.Background(), 0, 101); !errors.Is(err, errInvalidCursor) {
		t.Fatalf("limit>100: got %v", err)
	}
}

func TestCodecWritesZeroChoiceAndRoundTrips(t *testing.T) {
	target, score, done := uint32(0), uint32(1), "t1"
	round := &pb.Round{RoundId: "r", RequestId: "q", PlayerId: "p", Choice: 0, Status: "completed",
		CreatedAt: "t0", Target: &target, Score: &score, CompletedAt: &done}
	page := &pb.EventPage{Events: []*pb.Event{{Sequence: 1, Type: "round.completed", Round: round}}}
	for _, message := range []proto.Message{round, page, &pb.EventPage{}} {
		data, err := explicitCodec{}.Marshal(message)
		if err != nil {
			t.Fatal(err)
		}
		decoded := message.ProtoReflect().New().Interface()
		if err := proto.Unmarshal(data, decoded); err != nil || !proto.Equal(decoded, message) {
			t.Fatalf("round trip changed %T: %v", message, err)
		}
	}
	data, _ := explicitCodec{}.Marshal(round)
	if standard, _ := proto.Marshal(round); len(data) != len(standard)+2 {
		t.Fatalf("choice=0 should add exactly its 2-byte field: %d vs %d", len(data), len(standard))
	}
}

func TestConcurrentPlayersNeverCompleteEarly(t *testing.T) {
	delay := 150 * time.Millisecond
	s := open(t, t.TempDir(), delay)
	defer s.Close()
	ids := make([]string, 10)
	var wg sync.WaitGroup
	for i := range ids {
		wg.Go(func() {
			r, err := s.StartRound(context.Background(), fmt.Sprintf("req%d", i), fmt.Sprintf("p%d", i), uint32(i%3))
			if err != nil {
				t.Error(err)
			}
			ids[i] = r.RoundID
		})
	}
	wg.Wait()
	for _, id := range ids {
		r := waitCompleted(t, s, id)
		created, _ := time.Parse(timeLayout, r.CreatedAt)
		completed, _ := time.Parse(timeLayout, r.CompletedAt)
		if completed.Sub(created) < delay {
			t.Fatalf("%s completed after %v, before the %v delay", id, completed.Sub(created), delay)
		}
		want := uint32(0) // a miss earns nothing
		if r.Choice == *r.Target {
			want = 1
		}
		if *r.Score != want {
			t.Fatalf("%s: score %d, want %d", id, *r.Score, want)
		}
	}
	completions := map[string]int{}
	for _, e := range allEvents(t, s) {
		if e.Type == "round.completed" {
			completions[e.Round.RoundID]++
		}
	}
	for _, id := range ids {
		if completions[id] != 1 {
			t.Fatalf("%s completed %d times", id, completions[id])
		}
	}
}
