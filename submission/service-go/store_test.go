package main

import (
	"context"
	"strings"
	"testing"
	"time"

	pb "beaconrelay/service/roundspb"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// GetRound follows the HTTP rule: an ID that can't name a round is NOT_FOUND, like
// an unknown one (HTTP answers 404 for both), not INVALID_ARGUMENT.
func TestMalformedRoundIDIsNotFound(t *testing.T) {
	store, err := OpenStore(t.TempDir(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	srv := &server{store: store}
	for _, id := range []string{"", "a.b", "r_unknown", strings.Repeat("a", 129)} {
		_, err := srv.GetRound(context.Background(), &pb.GetRoundRequest{RoundId: id})
		if status.Code(err) != codes.NotFound {
			t.Errorf("GetRound(%q): got %v, want NOT_FOUND", id, err)
		}
	}
}

// While a Store owns DATA_DIR nothing else can lock it (so the log never has two
// writers); once it closes, the next owner gets it.
func TestDataDirHasOneOwner(t *testing.T) {
	dir := t.TempDir()
	first, err := OpenStore(dir, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if lock, err := lockDataDir(dir, 0); err == nil {
		lock.Close()
		t.Fatal("a second owner locked DATA_DIR while the store held it")
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	second, err := OpenStore(dir, time.Second)
	if err != nil {
		t.Fatalf("reopening after Close: %v", err)
	}
	second.Close()
}

// A restarted service waits for a previous owner that is still shutting down.
func TestLockWaitsForPreviousOwner(t *testing.T) {
	dir := t.TempDir()
	previous, err := lockDataDir(dir, 0)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		time.Sleep(200 * time.Millisecond)
		previous.Close()
	}()
	lock, err := lockDataDir(dir, 2*time.Second)
	if err != nil {
		t.Fatalf("waiting for the previous owner: %v", err)
	}
	lock.Close()
}
