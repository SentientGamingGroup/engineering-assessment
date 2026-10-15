// Enforces a single durable state owner per DATA_DIR with a PID lock file.
// A lock left by a crashed process (its PID no longer exists) is taken over, so
// restart after SIGKILL works; a lock held by a live process refuses to start.
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';

const LOCK_FILE = 'owner.lock';
const heldHere = new Set(); // lock files held by this process

const isRunning = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

export function acquireDataLock(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const file = resolve(dataDir, LOCK_FILE);
  if (heldHere.has(file)) throw new Error(`DATA_DIR ${dataDir} is already owned by this process`);
  try {
    const fd = openSync(file, 'wx');
    writeSync(fd, String(process.pid));
    closeSync(fd);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = Number(readFileSync(file, 'utf8'));
    if (owner && owner !== process.pid && isRunning(owner)) {
      throw new Error(`DATA_DIR ${dataDir} is already owned by running process ${owner}`);
    }
    writeFileSync(file, String(process.pid)); // stale lock from a crashed owner
  }
  heldHere.add(file);
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      heldHere.delete(file);
      try { unlinkSync(file); } catch { /* already gone */ }
    },
  };
}
