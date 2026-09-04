import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { WorkspacePrItem } from "./daemon.ts";
import type { WorkspaceLinkData } from "./links.ts";

const SOCKET_PATH = process.env.HERDR_SOCKET_PATH || `${process.env.HOME}/.config/herdr/herdr.sock`;
const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR || os.tmpdir();
const STATE_FILE = path.join(STATE_DIR, "herdr-workspace-prs-state.json");
const SYSTEM_STATE_FILE = path.join(os.tmpdir(), "herdr-workspace-prs-state.json");
const LEGACY_STATE_FILE = "/tmp/herdr-workspace-prs-state.json";
const PLUGIN_ID = process.env.HERDR_PLUGIN_ID || "herdr-workspace-prs";
const ENTRYPOINT = "picker";

interface State {
  workspaces: Record<string, WorkspacePrItem[]>;
  workspaceLinks?: Record<string, WorkspaceLinkData>;
}

function loadState(): State {
  for (const file of [STATE_FILE, SYSTEM_STATE_FILE, LEGACY_STATE_FILE]) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as State;
    } catch {
      // Try the compatibility location next.
    }
  }
  return { workspaces: {} };
}

function request(method: string, params: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(SOCKET_PATH);
    let buffer = "";
    const id = `workspace-prs-${Date.now()}`;

    client.on("connect", () => {
      client.write(JSON.stringify({ id, method, params }) + "\n");
    });
    client.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const response = JSON.parse(line) as { id?: string; result?: unknown; error?: { message?: string } };
          if (response.id !== id) continue;
          client.end();
          if (response.error) reject(new Error(response.error.message || "Herdr request failed"));
          else resolve(response.result);
          return;
        } catch {
          // Wait for the rest of a split JSON response.
        }
      }
    });
    client.on("error", reject);
  });
}

async function main() {
  const workspaceId = process.env.HERDR_WORKSPACE_ID || process.env.HERDR_ACTIVE_WORKSPACE_ID;
  const state = loadState();
  const prs = workspaceId ? state.workspaces[workspaceId] || [] : [];
  const linkData = workspaceId && state.workspaceLinks ? state.workspaceLinks[workspaceId] : undefined;
  const links = linkData?.links || [];
  const notes = linkData?.notes || [];

  let terminalHeight = 40;
  const paneId = process.env.HERDR_PANE_ID || process.env.HERDR_ACTIVE_PANE_ID;
  try {
    const result = (await request("pane.layout", paneId ? { pane_id: paneId } : {})) as {
      layout?: { area?: { height?: number } };
    };
    terminalHeight = result.layout?.area?.height || terminalHeight;
  } catch {
    // The popup can still use the fallback and its own scrolling.
  }

  let contentLines = 0;
  if (prs.length > 0) contentLines += 2 + prs.length * 4;
  if (links.length > 0) contentLines += 2 + links.length * 3;
  if (notes.length > 0) contentLines += 2 + notes.length;
  if (prs.length === 0 && links.length === 0 && notes.length === 0) contentLines = 3;

  const desiredHeight = contentLines + 5;
  const maxHeight = Math.max(8, Math.min(terminalHeight - 4, Math.floor(terminalHeight * 0.85)));
  const height = Math.min(desiredHeight, maxHeight);

  await request("plugin.pane.open", {
    plugin_id: PLUGIN_ID,
    entrypoint: ENTRYPOINT,
    placement: "popup",
    width: "75%",
    height,
    focus: true,
    env: workspaceId ? { HERDR_WORKSPACE_ID: workspaceId } : {},
  });
}

main().catch((error: unknown) => {
  console.error(`Could not open Workspace PRs: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
