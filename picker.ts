import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { runPollOnce, type WorkspacePrItem } from "./daemon.ts";
import {
  loadWorkspaceLinks,
  type WorkspaceLinkData,
  type WorkspaceLinkItem,
} from "./links.ts";

const SOCKET_PATH = process.env.HERDR_SOCKET_PATH || `${process.env.HOME}/.config/herdr/herdr.sock`;
const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR || os.tmpdir();
const STATE_FILE = path.join(STATE_DIR, "herdr-workspace-prs-state.json");
const SYSTEM_STATE_FILE = path.join(os.tmpdir(), "herdr-workspace-prs-state.json");
const LEGACY_STATE_FILE = "/tmp/herdr-workspace-prs-state.json";
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

interface WorkspaceDetails {
  wsId: string | null;
  label: string;
  cwds: string[];
}

async function getWorkspaceDetails(): Promise<WorkspaceDetails> {
  const providedId = process.env.HERDR_WORKSPACE_ID || process.env.HERDR_ACTIVE_WORKSPACE_ID;

  return new Promise((resolve) => {
    try {
      const client = net.createConnection(SOCKET_PATH);
      let buffer = "";
      client.on("connect", () => {
        client.write(JSON.stringify({ id: "ws-details", method: "session.snapshot", params: {} }) + "\n");
      });
      client.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        for (const line of buffer.split("\n")) {
          if (!line.trim()) continue;
          try {
            const json = JSON.parse(line) as {
              id?: string;
              result?: {
                snapshot?: {
                  focused_workspace_id?: string;
                  workspaces?: Array<{ workspace_id: string; label?: string }>;
                  panes?: Array<{ workspace_id: string; cwd?: string; foreground_cwd?: string }>;
                };
              };
            };
            if (json.id !== "ws-details") continue;
            client.end();
            const snap = json.result?.snapshot;
            const wsId = providedId || snap?.focused_workspace_id || null;
            const ws = snap?.workspaces?.find((w) => w.workspace_id === wsId);
            const label = ws?.label || wsId || "Current Workspace";
            const panes = (snap?.panes || []).filter((p) => p.workspace_id === wsId);
            const cwds = Array.from(new Set(panes.map((p) => p.foreground_cwd || p.cwd).filter(Boolean))) as string[];
            resolve({ wsId, label, cwds });
            return;
          } catch {}
        }
      });
      client.on("error", () => resolve({ wsId: providedId || null, label: "Current Workspace", cwds: [] }));
      setTimeout(() => {
        try { client.end(); } catch {}
        resolve({ wsId: providedId || null, label: "Current Workspace", cwds: [] });
      }, 800);
    } catch {
      resolve({ wsId: providedId || null, label: "Current Workspace", cwds: [] });
    }
  });
}

interface PickerState {
  workspaces: Record<string, WorkspacePrItem[]>;
  workspaceLabels: Record<string, string>;
  workspaceLinks?: Record<string, WorkspaceLinkData>;
}

function loadState(): PickerState {
  for (const file of [STATE_FILE, SYSTEM_STATE_FILE, LEGACY_STATE_FILE]) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as PickerState;
    } catch {
      // Try the compatibility location next.
    }
  }
  return { workspaces: {}, workspaceLabels: {} };
}

interface SelectableItem {
  id: string;
  kind: "pr" | "link";
  url: string;
}

async function main() {
  const details = await getWorkspaceDetails();
  let wsId = details.wsId;
  let label = details.label;
  let cwds = details.cwds;

  let state = loadState();
  let prs: WorkspacePrItem[] = (wsId && state.workspaces[wsId]) || [];

  // Direct load from disk using pane cwds, fallback to state
  let linkData: WorkspaceLinkData = cwds.length > 0 ? loadWorkspaceLinks(cwds) : {
    links: [],
    notes: [],
    linksFile: null,
    workspaceRoot: null,
  };
  if (linkData.links.length === 0 && linkData.notes.length === 0 && wsId && state.workspaceLinks?.[wsId]) {
    linkData = state.workspaceLinks[wsId];
  }

  let items: SelectableItem[] = [];
  function updateItems() {
    items = [
      ...prs.map((p, i) => ({ id: `pr-${i}`, kind: "pr" as const, url: p.url })),
      ...linkData.links.map((l, i) => ({ id: `link-${i}`, kind: "link" as const, url: l.url })),
    ];
  }
  updateItems();

  let selectedIndex = 0;
  let scrollOffset = 0;

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

  function statusColor(pr: WorkspacePrItem): string {
    if (pr.isDraft) return "\x1b[90m";
    if (pr.state === "MERGED") return "\x1b[35m";
    if (pr.state === "CLOSED") return "\x1b[31m";
    return "\x1b[32m";
  }

  function render() {
    if (items.length > 0) {
      selectedIndex = Math.max(0, Math.min(selectedIndex, items.length - 1));
    } else {
      selectedIndex = 0;
    }

    const allLines: string[] = [];
    const itemLineRanges: Array<{ start: number; end: number }> = [];

    const isEmpty = prs.length === 0 && linkData.links.length === 0 && linkData.notes.length === 0;
    if (isEmpty) {
      allLines.push("  \x1b[2mNo PRs, links, or notes found for this workspace.\x1b[0m");
      allLines.push("");
      allLines.push("  \x1b[2mPress \x1b[1;37m[e]\x1b[0;2m to add links and notes (LINKS.md)\x1b[0m");
    }

    // 1. PR Section
    if (prs.length > 0) {
      allLines.push("\x1b[1;34mPULL REQUESTS\x1b[0m");
      allLines.push("");
      const repoWidth = Math.max(REPO_COLUMN_WIDTH, ...prs.map((pr) => clean(pr.repo).length));
      const numberWidth = Math.max(NUMBER_COLUMN_WIDTH, ...prs.map((pr) => `#${pr.number}`.length));
      const statusWidth = Math.max(STATUS_COLUMN_WIDTH, ...prs.map((pr) => clean(pr.statusBadge).length));

      for (let i = 0; i < prs.length; i++) {
        const pr = prs[i];
        const itemIndex = i;
        const selected = itemIndex === selectedIndex;
        const prefix = selected ? "\x1b[1;32m❯\x1b[0m" : " ";
        const repo = clean(pr.repo).padEnd(repoWidth);
        const number = `#${pr.number}`.padEnd(numberWidth);
        const status = clean(pr.statusBadge).padStart(statusWidth);
        const color = statusColor(pr);

        const start = allLines.length;
        allLines.push(`${prefix} \x1b[34m${repo}\x1b[0m  \x1b[33m${number}\x1b[0m  ${color}${status}\x1b[0m`);
        allLines.push(`    ${selected ? "\x1b[1m" : "\x1b[2m"}${clean(pr.title)}\x1b[0m`);
        allLines.push(`    ${selected ? "" : "\x1b[2m"}${link(clean(pr.url), pr.url)}\x1b[0m`);
        allLines.push("");
        const end = allLines.length - 1;
        itemLineRanges.push({ start, end });
      }
    }

    // 2. Links Section
    if (linkData.links.length > 0) {
      if (prs.length > 0) allLines.push("");
      allLines.push("\x1b[1;35mLINKS & RESOURCES\x1b[0m");
      allLines.push("");

      for (let i = 0; i < linkData.links.length; i++) {
        const l = linkData.links[i];
        const itemIndex = prs.length + i;
        const selected = itemIndex === selectedIndex;
        const prefix = selected ? "\x1b[1;32m❯\x1b[0m" : " ";

        const start = allLines.length;
        allLines.push(`${prefix} ${selected ? "\x1b[1;37m" : "\x1b[36m"}${clean(l.title)}\x1b[0m`);
        allLines.push(`    ${selected ? "" : "\x1b[2m"}${link(clean(l.url), l.url)}\x1b[0m`);
        allLines.push("");
        const end = allLines.length - 1;
        itemLineRanges.push({ start, end });
      }
    }

    // 3. Notes Section
    if (linkData.notes.length > 0) {
      if (prs.length > 0 || linkData.links.length > 0) allLines.push("");
      allLines.push("\x1b[1;33mNOTES\x1b[0m");
      allLines.push("");
      for (const note of linkData.notes) {
        allLines.push(`  \x1b[2m•\x1b[0m ${clean(note)}`);
      }
    }

    const terminalRows = process.stdout.rows || 24;
    const viewportHeight = Math.max(1, terminalRows - HEADER_LINES - FOOTER_LINES);

    // Keep selected item within viewport
    if (items.length > 0 && selectedIndex >= 0 && selectedIndex < itemLineRanges.length) {
      const range = itemLineRanges[selectedIndex];
      if (range.start < scrollOffset) {
        scrollOffset = range.start;
      } else if (range.end >= scrollOffset + viewportHeight) {
        scrollOffset = range.end - viewportHeight + 1;
      }
    }
    scrollOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, allLines.length - viewportHeight)));

    process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write(`\x1b[1;36mWorkspace PRs & Links\x1b[0m \x1b[2m·\x1b[0m \x1b[1m${clean(label)}\x1b[0m\n\n`);

    const visibleLines = allLines.slice(scrollOffset, scrollOffset + viewportHeight);
    for (const l of visibleLines) {
      process.stdout.write(l + "\n");
    }
    for (let i = visibleLines.length; i < viewportHeight; i++) {
      process.stdout.write("\n");
    }

    const rangeHint = allLines.length > viewportHeight
      ? `[${Math.min(allLines.length, scrollOffset + 1)}-${Math.min(allLines.length, scrollOffset + visibleLines.length)}/${allLines.length}] `
      : "";

    let footer = "";
    if (items.length > 0) {
      footer = `\x1b[2m${rangeHint}[j/k] Move   [Enter] Open   [o] Open all   [e] Edit links   [r] Refresh   [Esc/q] Close\x1b[0m`;
    } else {
      footer = `\x1b[2m[e] Edit links   [r] Refresh   [Esc/q] Close\x1b[0m`;
    }
    process.stdout.write(footer + "\n");
  }

  function editLinks() {
    let targetFile = linkData.linksFile;
    if (!targetFile) {
      const root = linkData.workspaceRoot || (cwds[0] ? path.resolve(cwds[0]) : process.cwd());
      targetFile = path.join(root, "LINKS.md");
    }

    if (!fs.existsSync(targetFile)) {
      try {
        fs.mkdirSync(path.dirname(targetFile), { recursive: true });
        fs.writeFileSync(
          targetFile,
          "# Workspace Links & Notes\n\n- \n\n## Notes\n\n",
          "utf8"
        );
      } catch {}
    }

    restore();
    const editor = process.env.VISUAL || process.env.EDITOR || "vim";
    const parts = editor.trim().split(/\s+/);
    const bin = parts[0];
    const args = [...parts.slice(1), targetFile];
    try {
      spawnSync(bin, args, { stdio: "inherit" });
    } catch {}

    process.stdout.write("\x1b[?25l");
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();

    linkData = loadWorkspaceLinks(cwds.length > 0 ? cwds : [path.dirname(targetFile)]);
    updateItems();
    render();
  }

  render();

  if (process.stdout.isTTY) {
    process.stdout.on("resize", () => render());
  }

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
      if (items.length > 0) {
        selectedIndex = (selectedIndex - 1 + items.length) % items.length;
        render();
      }
      return;
    }

    if (key === "\u001b[B" || key === "j" || key === "J") {
      if (items.length > 0) {
        selectedIndex = (selectedIndex + 1) % items.length;
        render();
      }
      return;
    }

    const number = Number.parseInt(key, 10);
    if (!Number.isNaN(number) && number >= 1 && number <= items.length) {
      selectedIndex = number - 1;
      render();
      return;
    }

    if (key === "\r" || key === "\n") {
      if (items.length === 0) {
        restore();
        process.exit(0);
      }
      openUrl(items[selectedIndex].url);
      setTimeout(() => { restore(); process.exit(0); }, 150);
      return;
    }

    if (key === "o" || key === "O") {
      items.forEach((it) => openUrl(it.url));
      setTimeout(() => { restore(); process.exit(0); }, 200);
      return;
    }

    if (key === "e" || key === "E") {
      editLinks();
      return;
    }

    if (key === "r" || key === "R") {
      try {
        await runPollOnce();
        const fresh = await getWorkspaceDetails();
        wsId = fresh.wsId;
        label = fresh.label;
        cwds = fresh.cwds;
        state = loadState();
        prs = (wsId && state.workspaces[wsId]) || [];
        linkData = cwds.length > 0 ? loadWorkspaceLinks(cwds) : {
          links: [],
          notes: [],
          linksFile: null,
          workspaceRoot: null,
        };
        if (linkData.links.length === 0 && linkData.notes.length === 0 && wsId && state.workspaceLinks?.[wsId]) {
          linkData = state.workspaceLinks[wsId];
        }
        updateItems();
      } catch {}
      render();
    }
  });
}

main().catch((error: unknown) => {
  console.error("Picker error:", error);
  process.exit(1);
});
