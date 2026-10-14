package main

// Store is the single owner of round state and the durable event log, enforced
// across processes by an exclusive lock on DATA_DIR (lock.go).
//
// Every state change is one JSON line appended to DATA_DIR/events.jsonl and
// fsynced before memory changes and before any caller sees the result. Startup
// replays the log to rebuild state; a torn final line (crash mid-write) is cut
// off. One mutex serializes all operations, so concurrent duplicates cannot
// create two rounds and sequences stay gap-free.
//
// Tradeoff: reads (GetRound, ListEvents and so the WebSocket poll) also wait out a
// write's fsync. A separate writer lock would let them skip the disk wait, but at
// this workload (tens of rounds) one lock is simpler to reason about, and the
// gateway's same-payload retry absorbs an occasional slow fsync.

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

var (
	ErrInvalidRequest = errors.New("INVALID_REQUEST")
	ErrConflict       = errors.New("IDEMPOTENCY_CONFLICT")
	ErrInProgress     = errors.New("ROUND_IN_PROGRESS")
	ErrNotFound       = errors.New("ROUND_NOT_FOUND")
)

const (
	typeAccepted  = "round.accepted"
	typeCompleted = "round.completed"
)

// Round is an immutable snapshot; JSON names match the public contract.
type Round struct {
	RoundID     string  `json:"roundId"`
	RequestID   string  `json:"requestId"`
	PlayerID    string  `json:"playerId"`
	Choice      uint32  `json:"choice"`
	Status      string  `json:"status"`
	CreatedAt   string  `json:"createdAt"`
	Target      *uint32 `json:"target,omitempty"`
	Score       *uint32 `json:"score,omitempty"`
	CompletedAt string  `json:"completedAt,omitempty"`
}

type Event struct {
	Sequence uint32 `json:"sequence"`
	Type     string `json:"type"`
	Round    Round  `json:"round"`
}

func TargetFor(roundID string) uint32 {
	sum := sha256.Sum256([]byte(roundID))
	return uint32(sum[0] % 3)
}

func isoMillis(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000") + "Z" }

type Store struct {
	mu              sync.Mutex
	lock            *os.File
	file            *os.File
	size            int64
	delay           time.Duration
	events          []Event
	rounds          map[string]Round
	byRequest       map[string]string
	pendingByPlayer map[string]string
	timers          map[string]*time.Timer
	closed          bool
}

func OpenStore(dataDir string, delay time.Duration) (*Store, error) {
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return nil, err
	}
	// Own DATA_DIR before reading the log, so nothing else can append to it.
	lock, err := lockDataDir(dataDir, lockWait)
	if err != nil {
		return nil, err
	}
	path := filepath.Join(dataDir, "events.jsonl")
	s := &Store{
		lock:            lock,
		delay:           delay,
		rounds:          map[string]Round{},
		byRequest:       map[string]string{},
		pendingByPlayer: map[string]string{},
		timers:          map[string]*time.Timer{},
	}
	opened := false
	defer func() {
		if !opened {
			if s.file != nil {
				s.file.Close()
			}
			lock.Close()
		}
	}()
	data, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	for start := 0; ; {
		end := bytes.IndexByte(data[start:], '\n')
		if end < 0 {
			s.size = int64(start) // anything after the last newline is a torn write
			break
		}
		var ev Event
		if err := json.Unmarshal(data[start:start+end], &ev); err != nil ||
			ev.Sequence != uint32(len(s.events)+1) ||
			(ev.Type != typeAccepted && ev.Type != typeCompleted) ||
			(ev.Type == typeCompleted && (ev.Round.Target == nil || ev.Round.Score == nil)) {
			return nil, fmt.Errorf("corrupt event log at sequence %d", len(s.events)+1)
		}
		s.apply(ev)
		start += end + 1
	}
	if s.file, err = os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o644); err != nil {
		return nil, err
	}
	if err := s.file.Truncate(s.size); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, roundID := range s.pendingByPlayer {
		s.schedule(s.rounds[roundID]) // overdue rounds complete immediately
	}
	opened = true
	return s, nil
}

func (s *Store) apply(ev Event) {
	s.events = append(s.events, ev)
	s.rounds[ev.Round.RoundID] = ev.Round
	if ev.Type == typeAccepted {
		s.byRequest[ev.Round.RequestID] = ev.Round.RoundID
		s.pendingByPlayer[ev.Round.PlayerID] = ev.Round.RoundID
	} else {
		delete(s.pendingByPlayer, ev.Round.PlayerID)
	}
}

// append persists then applies one event. Caller holds s.mu.
func (s *Store) append(eventType string, round Round) error {
	ev := Event{Sequence: uint32(len(s.events) + 1), Type: eventType, Round: round}
	line, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	line = append(line, '\n')
	if _, err := s.file.WriteAt(line, s.size); err != nil {
		_ = s.file.Truncate(s.size)
		return err
	}
	if err := s.file.Sync(); err != nil {
		_ = s.file.Truncate(s.size)
		return err
	}
	s.size += int64(len(line))
	s.apply(ev)
	return nil
}

func (s *Store) StartRound(requestID, playerID string, choice uint32) (Round, error) {
	if !validID(requestID) || !validID(playerID) || choice > 2 {
		return Round{}, ErrInvalidRequest
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if roundID, ok := s.byRequest[requestID]; ok { // duplicates resolve before the player guard
		existing := s.rounds[roundID]
		if existing.PlayerID != playerID || existing.Choice != choice {
			return Round{}, ErrConflict
		}
		return existing, nil
	}
	if _, busy := s.pendingByPlayer[playerID]; busy {
		return Round{}, ErrInProgress
	}
	round := Round{
		RoundID: newRoundID(), RequestID: requestID, PlayerID: playerID, Choice: choice,
		Status: "accepted", CreatedAt: isoMillis(time.Now()),
	}
	if err := s.append(typeAccepted, round); err != nil {
		return Round{}, err
	}
	s.schedule(round)
	return round, nil
}

func (s *Store) GetRound(roundID string) (Round, error) {
	if !validRoundID(roundID) {
		return Round{}, ErrNotFound // names no round: the same answer as HTTP's 404
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	round, ok := s.rounds[roundID]
	if !ok {
		return Round{}, ErrNotFound
	}
	return round, nil
}

// ListEvents returns up to limit events strictly after `after` and the next cursor.
func (s *Store) ListEvents(after, limit uint32) ([]Event, uint32) {
	s.mu.Lock()
	defer s.mu.Unlock()
	total := uint64(len(s.events))
	from := min(uint64(after), total)
	to := min(from+uint64(limit), total)
	page := append([]Event(nil), s.events[from:to]...)
	if len(page) == 0 {
		return page, after
	}
	return page, page[len(page)-1].Sequence
}

// schedule arms completion at createdAt+delay. Caller holds s.mu.
func (s *Store) schedule(round Round) {
	created, _ := time.Parse(time.RFC3339Nano, round.CreatedAt)
	due := created.Add(s.delay)
	s.timers[round.RoundID] = time.AfterFunc(max(time.Until(due), 0), func() { s.complete(round.RoundID, due) })
}

func (s *Store) complete(roundID string, due time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.timers, roundID)
	round, ok := s.rounds[roundID]
	if s.closed || !ok || round.Status != "accepted" {
		return // completes exactly once
	}
	now := time.Now()
	if now.Before(due) { // never complete early, even if the timer fires a hair early
		s.timers[roundID] = time.AfterFunc(due.Sub(now), func() { s.complete(roundID, due) })
		return
	}
	target := TargetFor(roundID)
	score := uint32(0)
	if round.Choice == target {
		score = 1
	}
	round.Status, round.Target, round.Score, round.CompletedAt = "completed", &target, &score, isoMillis(now)
	if err := s.append(typeCompleted, round); err != nil {
		log.Printf("completing %s failed, retrying: %v", roundID, err)
		s.timers[roundID] = time.AfterFunc(100*time.Millisecond, func() { s.complete(roundID, due) })
		return
	}
}

func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	for _, timer := range s.timers {
		timer.Stop()
	}
	return errors.Join(s.file.Close(), s.lock.Close()) // the lock last: DATA_DIR is free once the log is closed
}

func newRoundID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return "r_" + hex.EncodeToString(b[:])
}

func validID(id string) bool      { return matchesID(id, 64) }
func validRoundID(id string) bool { return matchesID(id, 128) }

// matchesID reports whether id matches [A-Za-z0-9_-]{1,max}.
func matchesID(id string, max int) bool {
	if len(id) == 0 || len(id) > max {
		return false
	}
	for _, c := range []byte(id) {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-') {
			return false
		}
	}
	return true
}
