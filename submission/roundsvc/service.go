package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"log"
	"regexp"
	"time"
)

const timeLayout = "2006-01-02T15:04:05.000Z"

var idPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// appError carries the exact contract code; grpc.go maps it to a gRPC status.
type appError string

func (e appError) Error() string { return string(e) }

const (
	errInvalidRequest = appError("INVALID_REQUEST")
	errInvalidCursor  = appError("INVALID_CURSOR")
	errNotFound       = appError("ROUND_NOT_FOUND")
	errConflict       = appError("IDEMPOTENCY_CONFLICT")
	errInProgress     = appError("ROUND_IN_PROGRESS")
)

var errClosed = errors.New("service closed")

// Service is the single durable state owner. Every read and write runs on one
// goroutine (run), so duplicates and per-player checks need no locks and the
// log order is exactly the order decisions were made.
type Service struct {
	log     *eventLog
	delay   time.Duration
	now     func() time.Time
	work    chan job
	done    chan struct{}
	stopped chan struct{}

	// Owned by run; never touched from other goroutines.
	events    []Event
	rounds    map[string]Round
	byRequest map[string]string
	pending   map[string]string // playerId -> roundId
	timers    map[string]*time.Timer
	dirty     bool // appended since the last fsync
}

func NewService(dataDir string, delay time.Duration) (*Service, error) {
	eventLog, events, err := openLog(dataDir)
	if err != nil {
		return nil, err
	}
	s := &Service{
		log: eventLog, delay: delay, now: time.Now,
		work: make(chan job), done: make(chan struct{}), stopped: make(chan struct{}),
		rounds: map[string]Round{}, byRequest: map[string]string{},
		pending: map[string]string{}, timers: map[string]*time.Timer{},
	}
	for _, event := range events {
		s.apply(event)
	}
	// Recovery: overdue rounds fire immediately; others keep their original deadline.
	for _, roundID := range s.pending {
		s.schedule(roundID)
	}
	go s.run()
	return s, nil
}

// job is one unit of owner work; done (if set) is closed once its effects are durable.
type job struct {
	fn   func()
	done chan struct{}
}

// maxBatch bounds how many queued jobs share one fsync.
const maxBatch = 128

// run executes jobs one at a time, then group-commits: every job already queued
// joins the batch, the log is fsynced once, and only then are callers released.
// Nothing is acknowledged before it is on disk, but N concurrent writes cost one
// fsync instead of N (a single fsync can take >100 ms on some disks).
func (s *Service) run() {
	defer close(s.stopped)
	for {
		select {
		case first := <-s.work:
			batch := []job{first}
			first.fn()
		drain:
			for len(batch) < maxBatch {
				select {
				case next := <-s.work:
					next.fn()
					batch = append(batch, next)
				default:
					break drain
				}
			}
			if s.dirty {
				if err := s.log.sync(); err != nil {
					// Memory may now be ahead of disk. Fail stop: restart recovers
					// from the log, and no caller in this batch was acknowledged.
					log.Fatalf("fsync event log: %v", err)
				}
				s.dirty = false
			}
			for _, j := range batch {
				if j.done != nil {
					close(j.done)
				}
			}
		case <-s.done:
			for _, timer := range s.timers {
				timer.Stop()
			}
			s.log.close()
			return
		}
	}
}

// do runs fn on the owner goroutine. If ctx expires first the caller sees an
// unknown outcome; fn may still commit, which is why retries reuse requestId.
func (s *Service) do(ctx context.Context, fn func()) error {
	finished := make(chan struct{})
	select {
	case s.work <- job{fn: fn, done: finished}:
	case <-ctx.Done():
		return ctx.Err()
	case <-s.done:
		return errClosed
	}
	select {
	case <-finished:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-s.done:
		return errClosed
	}
}

func (s *Service) Close() {
	select {
	case <-s.done:
	default:
		close(s.done)
	}
	<-s.stopped
}

// apply folds a persisted event into memory. Used for both recovery and live writes.
func (s *Service) apply(event Event) {
	s.events = append(s.events, event)
	r := event.Round
	s.rounds[r.RoundID] = r
	s.byRequest[r.RequestID] = r.RoundID
	if r.Status == "accepted" {
		s.pending[r.PlayerID] = r.RoundID
	} else {
		delete(s.pending, r.PlayerID)
	}
}

func (s *Service) commit(kind string, round Round) error {
	event := Event{Sequence: uint32(len(s.events) + 1), Type: kind, Round: round}
	if err := s.log.append(event); err != nil {
		return err
	}
	s.dirty = true
	s.apply(event)
	return nil
}

func (s *Service) StartRound(ctx context.Context, requestID, playerID string, choice uint32) (Round, error) {
	if !idPattern.MatchString(requestID) || !idPattern.MatchString(playerID) || choice > 2 {
		return Round{}, errInvalidRequest
	}
	var round Round
	var result error
	err := s.do(ctx, func() {
		// requestId duplicates resolve before the player guard (contract order).
		if id, ok := s.byRequest[requestID]; ok {
			round = s.rounds[id]
			if round.PlayerID != playerID || round.Choice != choice {
				result = errConflict
			}
			return
		}
		if _, busy := s.pending[playerID]; busy {
			result = errInProgress
			return
		}
		round = Round{
			RoundID: newRoundID(), RequestID: requestID, PlayerID: playerID, Choice: choice,
			Status: "accepted", CreatedAt: s.now().UTC().Format(timeLayout),
		}
		if result = s.commit("round.accepted", round); result == nil {
			s.schedule(round.RoundID)
		}
	})
	if err != nil {
		return Round{}, err
	}
	return round, result
}

func (s *Service) GetRound(ctx context.Context, roundID string) (Round, error) {
	var round Round
	var ok bool
	if err := s.do(ctx, func() { round, ok = s.rounds[roundID] }); err != nil {
		return Round{}, err
	}
	if !ok {
		return Round{}, errNotFound
	}
	return round, nil
}

// ListEvents returns up to limit events strictly after the cursor. Sequence n
// lives at index n-1, so the slice is direct. limit 0 means the default 100.
func (s *Service) ListEvents(ctx context.Context, after, limit uint32) ([]Event, uint32, error) {
	if limit == 0 {
		limit = 100
	}
	if limit > 100 {
		return nil, 0, errInvalidCursor
	}
	var page []Event
	err := s.do(ctx, func() {
		if int(after) < len(s.events) {
			end := min(len(s.events), int(after)+int(limit))
			page = append([]Event(nil), s.events[after:end]...)
		}
	})
	if err != nil {
		return nil, 0, err
	}
	next := after
	if len(page) > 0 {
		next = page[len(page)-1].Sequence
	}
	return page, next, nil
}

// schedule arms completion at createdAt+delay. Runs on the owner goroutine.
func (s *Service) schedule(roundID string) {
	created, _ := time.Parse(timeLayout, s.rounds[roundID].CreatedAt)
	wait := time.Until(created.Add(s.delay))
	s.timers[roundID] = time.AfterFunc(max(wait, 0), func() {
		select {
		case s.work <- job{fn: func() { s.complete(roundID) }}:
		case <-s.done:
		}
	})
}

// complete is idempotent: only an accepted round produces a completed event.
func (s *Service) complete(roundID string) {
	delete(s.timers, roundID)
	round := s.rounds[roundID]
	if round.Status != "accepted" {
		return
	}
	created, _ := time.Parse(timeLayout, round.CreatedAt)
	completedAt := s.now().UTC().Truncate(time.Millisecond)
	if earliest := created.Add(s.delay); completedAt.Before(earliest) {
		completedAt = earliest // never complete before the configured delay
	}
	target := targetFor(roundID)
	score := uint32(0)
	if round.Choice == target {
		score = 1
	}
	round.Status, round.Target, round.Score = "completed", &target, &score
	round.CompletedAt = completedAt.Format(timeLayout)
	if err := s.commit("round.completed", round); err != nil {
		log.Printf("complete %s: %v; retrying", roundID, err)
		s.timers[roundID] = time.AfterFunc(250*time.Millisecond, func() {
			select {
			case s.work <- job{fn: func() { s.complete(roundID) }}:
			case <-s.done:
			}
		})
	}
}

// targetFor is the intentionally public toy rule from the brief.
func targetFor(roundID string) uint32 {
	sum := sha256.Sum256([]byte(roundID))
	return uint32(sum[0] % 3)
}

func newRoundID() string {
	var b [16]byte
	rand.Read(b[:])
	return "r_" + base64.RawURLEncoding.EncodeToString(b[:])
}
