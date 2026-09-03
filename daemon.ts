import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SOCKET_PATH = process.env.HERDR_SOCKET_PATH || `${process.env.HOME}/.config/herdr/herdr.sock`;
const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR || os.tmpdir();
const STATE_FILE = path.join(STATE_DIR, "herdr-workspace-prs-state.json");
const PID_FILE = path.join(STATE_DIR, "herdr-workspace-prs.pid");
const LOG_FILE = path.join(STATE_DIR, "herdr-workspace-prs.log");
const POLL_INTERVAL_MS = 15000;
const PR_CACHE_TTL_MS = 30000;
const MAX_PRS_PER_WORKSPACE = 5;
const REPO_COLUMN_WIDTH = 10;
const NUMBER_COLUMN_WIDTH = 5;
const STATUS_COLUMN_WIDTH = 8;
const COLUMN_PAD = "\u2800"; // Braille blank: visually empty, but Herdr preserves its cell.

function padEnd(value: string, width: number): string {
  return value + COLUMN_PAD.repeat(Math.max(0, width - value.length));
}

function padStart(value: string, width: number): string {
  return COLUMN_PAD.repeat(Math.max(0, width - value.length)) + value;
}

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {}
}

const originUrlCache = new Map<string, string | null>();

interface CachedPr {
  time: number;
  pr: any | null;
}
const prCache = new Map<string, CachedPr>();

// Track currently active token keys per workspace
const workspaceActiveTokens = new Map<string, Set<string>>();

interface GitBranchInfo {
  root: string;
  branch: string;
  owner: string;
  repo: string;
  full: string;
}

function parseGithubRepo(url: string): { owner: string; repo: string; full: string } | null {
  const match = url.trim().match(/github\.com[:/]([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], full: `${match[1]}/${match[2]}` };
}

function getGitBranchInfo(cwd: string): GitBranchInfo | null {
  try {
    const res = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (res.status !== 0 || !res.stdout) return null;
    const lines = res.stdout.trim().split("\n");
    if (lines.length < 2) return null;
    const [root, branch] = lines;
    if (!root || !branch || branch === "HEAD" || branch === "main" || branch === "master" || branch === "develop") {
      return null;
    }

    let originUrl = originUrlCache.get(root);
    if (originUrl === undefined) {
      const remoteRes = spawnSync("git", ["-C", root, "config", "--get", "remote.origin.url"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      originUrl = remoteRes.stdout ? remoteRes.stdout.trim() : null;
      originUrlCache.set(root, originUrl);
    }
    if (!originUrl) return null;

    const gh = parseGithubRepo(originUrl);
    if (!gh) return null;

    return { root, branch, owner: gh.owner, repo: gh.repo, full: gh.full };
  } catch {
    return null;
  }
}

async function fetchPrForBranch(fullRepo: string, branch: string): Promise<any | null> {
  const cacheKey = `${fullRepo}:${branch}`;
  const now = Date.now();
  const cached = prCache.get(cacheKey);
  if (cached && now - cached.time < PR_CACHE_TTL_MS) {
    return cached.pr;
  }

  try {
    const proc = Bun.spawn(
      ["gh", "pr", "list", "--repo", fullRepo, "--head", branch, "--state", "all", "--json", "number,title,state,isDraft,url"],
      { stdout: "pipe", stderr: "ignore" }
    );
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    const list = JSON.parse(text || "[]");

    let picked: any | null = null;
    if (Array.isArray(list) && list.length > 0) {
      list.sort((a, b) => {
        const score = (p: any) => (p.state === "OPEN" ? 3 : p.state === "MERGED" ? 2 : 1);
        const diff = score(b) - score(a);
        if (diff !== 0) return diff;
        return b.number - a.number;
      });
      picked = list[0];
    }
    prCache.set(cacheKey, { time: now, pr: picked });
    return picked;
  } catch (e: any) {
    log(`gh error for ${fullRepo} ${branch}: ${e?.message}`);
    return null;
  }
}

function getStatusBadge(pr: any): string {
  if (pr.isDraft) return "(draft)";
  const s = String(pr.state).toLowerCase();
  if (s === "open") return "(open)";
  if (s === "merged") return "(merged)";
  if (s === "closed") return "(closed)";
  return `(${s})`;
}

let reqCounter = 0;
async function sendHerdr(method: string, params: any = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(SOCKET_PATH);
    let buf = "";
    const id = `req_${++reqCounter}`;
    client.on("connect", () => {
      client.write(JSON.stringify({ id, method, params }) + "\n");
    });
    client.on("data", (chunk) => {
      buf += chunk.toString();
      try {
        const msg = JSON.parse(buf);
        if (msg.id === id) {
          client.end();
          if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      } catch {}
    });
    client.on("error", (err) => {
      reject(err);
    });
  });
}

export interface WorkspacePrItem {
  repo: string;
  repoFull: string;
  branch: string;
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  statusBadge: string;
  url: string;
  displayLine: string;
}

export async function runPollOnce(): Promise<Record<string, WorkspacePrItem[]>> {
  const snapRes = await sendHerdr("session.snapshot", {});
  const snapshot = snapRes.snapshot;
  if (!snapshot || !Array.isArray(snapshot.workspaces)) return {};

  const workspacesMap: Record<string, WorkspacePrItem[]> = {};
  const records: Array<{ workspace: any; prs: WorkspacePrItem[] }> = [];

  // Discover every workspace first. Column widths must be global, not per workspace.
  for (const ws of snapshot.workspaces) {
    const panes = (snapshot.panes || []).filter((p: any) => p.workspace_id === ws.workspace_id);
    const uniqueCwds = Array.from(new Set(panes.map((p: any) => p.foreground_cwd || p.cwd).filter(Boolean))) as string[];
    const prs: WorkspacePrItem[] = [];
    const seenPrKeys = new Set<string>();

    for (const cwd of uniqueCwds) {
      const gitInfo = getGitBranchInfo(cwd);
      if (!gitInfo) continue;

      const pr = await fetchPrForBranch(gitInfo.full, gitInfo.branch);
      if (!pr) continue;

      const prKey = `${gitInfo.repo}#${pr.number}`;
      if (seenPrKeys.has(prKey)) continue;
      seenPrKeys.add(prKey);

      const statusBadge = getStatusBadge(pr);
      prs.push({
        repo: gitInfo.repo,
        repoFull: gitInfo.full,
        branch: gitInfo.branch,
        number: pr.number,
        title: pr.title || "",
        state: pr.state,
        isDraft: !!pr.isDraft,
        statusBadge,
        url: pr.url,
        displayLine: `${gitInfo.repo} #${pr.number} ${statusBadge}`,
      });
    }

    workspacesMap[ws.workspace_id] = prs;
    records.push({ workspace: ws, prs });
  }

  const visiblePrs = records.flatMap(({ prs }) => prs.slice(0, MAX_PRS_PER_WORKSPACE));
  const repoWidth = Math.max(REPO_COLUMN_WIDTH, ...visiblePrs.map((pr) => pr.repo.length));
  const numberWidth = Math.max(NUMBER_COLUMN_WIDTH, ...visiblePrs.map((pr) => `#${pr.number}`.length));
  const statusWidth = Math.max(STATUS_COLUMN_WIDTH, ...visiblePrs.map((pr) => pr.statusBadge.length));

  for (const { workspace: ws, prs } of records) {
    const wsId = ws.workspace_id;
    const currentTokens: Record<string, string> = {};
    const count = Math.min(prs.length, MAX_PRS_PER_WORKSPACE);

    for (let i = 0; i < count; i++) {
      const pr = prs[i];
      const prefix = `pr_${i + 1}`;
      currentTokens[`${prefix}_repo`] = padEnd(pr.repo, repoWidth);
      currentTokens[`${prefix}_num`] = padEnd(`#${pr.number}`, numberWidth);

      if (pr.isDraft) {
        currentTokens[`${prefix}_draft`] = padStart("(draft)", statusWidth);
      } else if (pr.state === "MERGED") {
        currentTokens[`${prefix}_merged`] = padStart("(merged)", statusWidth);
      } else if (pr.state === "CLOSED") {
        currentTokens[`${prefix}_closed`] = padStart("(closed)", statusWidth);
      } else {
        currentTokens[`${prefix}_open`] = padStart("(open)", statusWidth);
      }
    }

    const prevTokens = workspaceActiveTokens.get(wsId) || new Set<string>();
    const currentKeys = new Set(Object.keys(currentTokens));
    const keysToReport: Record<string, string | null> = {};
    let hasChanges = false;

    for (const [key, value] of Object.entries(currentTokens)) {
      if (ws.tokens?.[key] !== value) hasChanges = true;
      keysToReport[key] = value;
    }

    // Clear keys from this daemon, including stale status keys after a restart.
    const reportedPrKey = /^pr_[1-5]_(repo|num|open|merged|draft|closed)$/;
    for (const oldKey of new Set([...prevTokens, ...Object.keys(ws.tokens || {})])) {
      if ((reportedPrKey.test(oldKey) || /^pr_[1-5]$/.test(oldKey)) && !currentKeys.has(oldKey)) {
        hasChanges = true;
        keysToReport[oldKey] = null;
      }
    }

    if (hasChanges && Object.keys(keysToReport).length > 0) {
      log(`Updating workspace ${wsId} (${ws.label}) with ${prs.length} PR(s)`);
      workspaceActiveTokens.set(wsId, currentKeys);

      // Send in batches of at most 16 keys (Herdr's report limit).
      const entries = Object.entries(keysToReport);
      while (entries.length > 0) {
        const batch = Object.fromEntries(entries.splice(0, 16));
        try {
          await sendHerdr("workspace.report_metadata", {
            workspace_id: wsId,
            source: "workspace-prs",
            tokens: batch,
          });
        } catch (e: any) {
          log(`Failed to report metadata for ${wsId}: ${e?.message}`);
        }
      }
    }
  }

  try {
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify(
        {
          updatedAt: Date.now(),
          workspaces: workspacesMap,
          workspaceLabels: Object.fromEntries(snapshot.workspaces.map((w: any) => [w.workspace_id, w.label])),
        },
        null,
        2
      )
    );
  } catch (e: any) {
    log(`Failed to write state file: ${e?.message}`);
  }

  return workspacesMap;
}

async function main() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid));
  log(`Starting workspace-prs daemon (PID ${process.pid})`);

  const cleanup = () => {
    log("Exiting daemon, cleaning up PID file...");
    try {
      if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
    } catch {}
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("SIGHUP", cleanup);

  let polling = false;
  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      await runPollOnce();
    } catch (e: any) {
      log(`Poll error: ${e?.message}`);
    } finally {
      polling = false;
    }
  };

  await poll();
  setInterval(poll, POLL_INTERVAL_MS);
}

if (import.meta.main) {
  main().catch((err) => {
    log(`Fatal daemon crash: ${err?.stack || err}`);
    process.exit(1);
  });
}
