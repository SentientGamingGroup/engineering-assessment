package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// Round is the immutable public snapshot. Pointer/omitempty fields stay absent
// while a round is accepted so a pending target/score is never exposed.
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

// eventLog is an append-only JSON-lines file. Appends are fsynced (see sync)
// before any caller is acknowledged, so an accepted reply survives process death.
type eventLog struct {
	file *os.File
	size int64
}

// openLog loads every complete event. A torn final line (no trailing newline)
// can only come from a crash mid-append; that write was never acknowledged, so
// it is truncated. A malformed complete line is real corruption and fails startup.
func openLog(dir string) (*eventLog, []Event, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, nil, err
	}
	file, err := os.OpenFile(filepath.Join(dir, "events.jsonl"), os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return nil, nil, err
	}
	data, err := io.ReadAll(file)
	if err != nil {
		file.Close()
		return nil, nil, err
	}
	complete := bytes.LastIndexByte(data, '\n') + 1
	var events []Event
	for line, rest := []byte(nil), data[:complete]; len(rest) > 0; {
		line, rest, _ = bytes.Cut(rest, []byte{'\n'})
		var event Event
		if err := json.Unmarshal(line, &event); err != nil {
			file.Close()
			return nil, nil, fmt.Errorf("corrupt event %d: %w", len(events)+1, err)
		}
		if event.Sequence != uint32(len(events)+1) {
			file.Close()
			return nil, nil, fmt.Errorf("event sequence gap at %d", event.Sequence)
		}
		events = append(events, event)
	}
	if complete < len(data) {
		if err := file.Truncate(int64(complete)); err != nil {
			file.Close()
			return nil, nil, err
		}
	}
	log := &eventLog{file: file, size: int64(complete)}
	if _, err := file.Seek(log.size, io.SeekStart); err != nil {
		file.Close()
		return nil, nil, err
	}
	return log, events, nil
}

func (l *eventLog) append(event Event) error {
	line, err := json.Marshal(event)
	if err != nil {
		return err
	}
	line = append(line, '\n')
	if _, err = l.file.Write(line); err != nil {
		// Roll back a partial write so the next append cannot follow a torn line.
		l.file.Truncate(l.size)
		l.file.Seek(l.size, io.SeekStart)
		return err
	}
	l.size += int64(len(line))
	return nil
}

// sync makes every appended event durable. The owner calls it once per batch
// (group commit) before acknowledging any request in that batch.
func (l *eventLog) sync() error { return l.file.Sync() }

func (l *eventLog) close() error { return l.file.Close() }
