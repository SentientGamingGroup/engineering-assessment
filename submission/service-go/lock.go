package main

// DATA_DIR has exactly one owner: the Store holds an OS-level exclusive lock on
// DATA_DIR/lock for its lifetime. A second service on the same directory fails
// instead of appending to the log at its own stale offset. The OS drops the lock
// when the process exits, however abruptly, so a crash never leaves it held.

import (
	"errors"
	"os"
	"path/filepath"
	"time"
)

var errLocked = errors.New("locked by another process")

// lockWait covers a previous owner that is still shutting down (main.go allows
// GracefulStop 2s) when a restarted service starts right away.
const lockWait = 5 * time.Second

func lockDataDir(dataDir string, wait time.Duration) (*os.File, error) {
	path := filepath.Join(dataDir, "lock")
	deadline := time.Now().Add(wait)
	for {
		f, err := lockFile(path)
		if !errors.Is(err, errLocked) {
			return f, err
		}
		if time.Now().After(deadline) {
			return nil, errors.New("already in use by another round service")
		}
		time.Sleep(100 * time.Millisecond)
	}
}
