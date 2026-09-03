import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { runPollOnce, type WorkspacePrItem } from "./daemon.ts";

const SOCKET_PATH = process.env.HERDR_SOCKET_PATH || `${process.env.HOME}/.config/herdr/herdr.sock`;
const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR || os.tmpdir();
const STATE_FILE = path.join(STATE_DIR, "herdr-workspace-prs-state.json");
const LEGACY_STATE_FILE = "/tmp/herdr-workspace-prs-state.json";
const ITEM_LINES = 4;
const HEADER_LINES = 2;
const FOOTER_LINES = 1;
const REPO_COLUMN_WIDTH = 10;
const NUMBER_COLUMN_WIDTH = 5;
const STATUS_COLUMN_WIDTH = 8;

function clean(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ");
}

function link(text: string, url: string): string {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

function openUrl(url: string) {
  try {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  } catch {}
}

async function getFocusedWorkspaceId(): Promise<string | null> {
  const providedId = process.env.HERDR_WORKSPACE_ID || process.env.HERDR_ACTIVE_WORKSPACE_ID;
  if (providedId) return providedId;

  return new Promise((resolve) => {
    try {
      const client = net.createConnection(SOCKET_PATH);
      let buffer = "";
      client.on("connect", () => {
        client.write(JSON.stringify({ id: "focus", method: "session.snapshot", params: {} }) + "\n");
      });
      client.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        try {
          const json = JSON.parse(buffer) as { result?: { snapshot?: { focused_workspace_id?: string } } };
          client.end();
          resolve(json.result?.snapshot?.focused_workspace_id || null);
        } catch {
          // Wait for the rest of the JSON response.
        }
      });
      client.on("error", () => resolve(null));
      setTimeout(() => {
        try { client.end(); } catch {}
        resolve(null);
      }, 500);
    } catch {
      resolve(null);
    }
  });
}

interface PickerState {
  workspaces: Record<string, WorkspacePrItem[]>;
  workspaceLabels: Record<string, string>;
}

function loadState(): PickerState {
  for (const file of [STATE_FILE, LEGACY_STATE_FILE]) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as PickerState;
    } catch {
      // Try the compatibility location next.
    }
  }
  return { workspaces: {}, workspaceLabels: {} };
}

async function main() {
  let wsId = await getFocusedWorkspaceId();
  let state = loadState();
  let prs = (wsId && state.workspaces[wsId]) || [];
  let label = (wsId && state.workspaceLabels[wsId]) || wsId || "Current Workspace";
  let selectedIndex = 0;
  let firstVisibleIndex = 0;

  // Do not block an empty popup on a full GitHub refresh. The daemon polls in
  // the background, and the user can press `r` when an immediate refresh is needed.
  process.stdout.write("\x1b[?25l");

  const restore = () => {
    process.stdout.write("\x1b[?25h\x1b[0m\n");
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    } catch {}
  };

  process.on("exit", restore);
  process.on("SIGINT", () => { restore(); process.exit(0); });
  process.on("SIGTERM", () => { restore(); process.exit(0); });

  function visibleItemCount(): number {
    const terminalRows = process.stdout.rows || 24;
    return Math.max(1, Math.floor(Math.max(1, terminalRows - HEADER_LINES - FOOTER_LINES) / ITEM_LINES));
  }

  function keepSelectionVisible() {
    const count = visibleItemCount();
    const maxFirst = Math.max(0, prs.length - count);
    if (selectedIndex < firstVisibleIndex) firstVisibleIndex = selectedIndex;
    if (selectedIndex >= firstVisibleIndex + count) firstVisibleIndex = selectedIndex - count + 1;
    firstVisibleIndex = Math.max(0, Math.min(firstVisibleIndex, maxFirst));
  }

  function statusColor(pr: WorkspacePrItem): string {
    if (pr.isDraft) return "\x1b[90m";
    if (pr.state === "MERGED") return "\x1b[35m";
    if (pr.state === "CLOSED") return "\x1b[31m";
    return "\x1b[32m";
  }

  function render() {
    keepSelectionVisible();
    process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write(`\x1b[1;36mWorkspace PRs\x1b[0m \x1b[2m·\x1b[0m \x1b[1m${clean(label)}\x1b[0m\n\n`);

    if (prs.length === 0) {
      process.stdout.write("  \x1b[2mNo PRs found for this workspace.\x1b[0m\n\n");
      process.stdout.write("\x1b[2m[r] Refresh   [Esc/q] Close\x1b[0m\n");
      return;
    }

    const repoWidth = Math.max(REPO_COLUMN_WIDTH, ...prs.map((pr) => clean(pr.repo).length));
    const numberWidth = Math.max(NUMBER_COLUMN_WIDTH, ...prs.map((pr) => `#${pr.number}`.length));
    const statusWidth = Math.max(STATUS_COLUMN_WIDTH, ...prs.map((pr) => clean(pr.statusBadge).length));
    const count = visibleItemCount();
    const visiblePrs = prs.slice(firstVisibleIndex, firstVisibleIndex + count);

    for (const [visibleIndex, pr] of visiblePrs.entries()) {
      const index = firstVisibleIndex + visibleIndex;
      const selected = index === selectedIndex;
      const prefix = selected ? "\x1b[1;32m❯\x1b[0m" : " ";
      const repo = clean(pr.repo).padEnd(repoWidth);
      const number = `#${pr.number}`.padEnd(numberWidth);
      const status = clean(pr.statusBadge).padStart(statusWidth);
      const color = statusColor(pr);

      process.stdout.write(
        `${prefix} \x1b[34m${repo}\x1b[0m  \x1b[33m${number}\x1b[0m  ${color}${status}\x1b[0m\n`
      );
      process.stdout.write(`    ${selected ? "\x1b[1m" : "\x1b[2m"}${clean(pr.title)}\x1b[0m\n`);
      process.stdout.write(`    ${selected ? "" : "\x1b[2m"}${link(clean(pr.url), pr.url)}\x1b[0m\n\n`);
    }

    const range = prs.length > count ? `  [${firstVisibleIndex + 1}-${Math.min(firstVisibleIndex + count, prs.length)}/${prs.length}]` : "";
    process.stdout.write(
      `\x1b[2m${range}  [j/k or ↑/↓] Move   [Enter] Open   [o] Open all   [r] Refresh   [Esc/q] Close\x1b[0m\n`
    );
  }

  render();

  // Herdr normally gives plugin panes a TTY. Keep the picker alive even when
  // the launcher reports a pipe so the empty-state popup remains visible.
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  const keepAlive = setInterval(() => {}, 60 * 60 * 1000);
  process.stdin.on("data", async (chunk: Buffer) => {
    const key = chunk.toString();

    if (key === "\u0003" || key === "\u001b" || key === "q" || key === "Q") {
      restore();
      process.exit(0);
    }

    if (key === "\u001b[A" || key === "k" || key === "K") {
      if (prs.length > 0) {
        selectedIndex = (selectedIndex - 1 + prs.length) % prs.length;
        render();
      }
      return;
    }

    if (key === "\u001b[B" || key === "j" || key === "J") {
      if (prs.length > 0) {
        selectedIndex = (selectedIndex + 1) % prs.length;
        render();
      }
      return;
    }

    const number = Number.parseInt(key, 10);
    if (!Number.isNaN(number) && number >= 1 && number <= prs.length) {
      selectedIndex = number - 1;
      render();
      return;
    }

    if (key === "\r" || key === "\n") {
      if (prs.length === 0) {
        restore();
        process.exit(0);
      }
      openUrl(prs[selectedIndex].url);
      setTimeout(() => { restore(); process.exit(0); }, 150);
      return;
    }

    if (key === "o" || key === "O") {
      prs.forEach((pr) => openUrl(pr.url));
      setTimeout(() => { restore(); process.exit(0); }, 200);
      return;
    }

    if (key === "r" || key === "R") {
      try {
        await runPollOnce();
        state = loadState();
        wsId = await getFocusedWorkspaceId();
        prs = (wsId && state.workspaces[wsId]) || [];
        label = (wsId && state.workspaceLabels[wsId]) || wsId || "Current Workspace";
        selectedIndex = Math.min(selectedIndex, Math.max(0, prs.length - 1));
        firstVisibleIndex = Math.min(firstVisibleIndex, Math.max(0, prs.length - 1));
      } catch {}
      render();
    }
  });
}

main().catch((error: unknown) => {
  console.error("Picker error:", error);
  process.exit(1);
});
