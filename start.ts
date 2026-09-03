import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";

const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR || os.tmpdir();
const PID_FILE = path.join(STATE_DIR, "herdr-workspace-prs.pid");
const DAEMON_PATH = path.join(import.meta.dir, "daemon.ts");
const LOG_FILE = path.join(STATE_DIR, "herdr-workspace-prs.log");

function isDaemonRunning(): boolean {
  if (!fs.existsSync(PID_FILE)) return false;
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10);
    if (!pid || isNaN(pid)) return false;
    process.kill(pid, 0); // throws if process does not exist
    return true;
  } catch {
    return false;
  }
}

if (isDaemonRunning()) {
  process.exit(0);
}

fs.mkdirSync(STATE_DIR, { recursive: true });

// Open log stream for child
const out = fs.openSync(LOG_FILE, "a");
const err = fs.openSync(LOG_FILE, "a");

// Spawn detached daemon using current bun executable
const child = spawn(process.execPath, ["run", DAEMON_PATH], {
  detached: true,
  stdio: ["ignore", out, err],
  cwd: import.meta.dir,
});

child.unref();
process.exit(0);
