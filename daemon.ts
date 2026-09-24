import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadWorkspaceLinks, type WorkspaceLinkData, type WorkspaceLinkItem } from "./links.ts";

export type { WorkspaceLinkData, WorkspaceLinkItem };

const SOCKET_PATH = process.env.HERDR_SOCKET_PATH || `${process.env.HOME}/.config/herdr/herdr.sock`;
const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR || os.tmpdir();
const STATE_FILE = path.join(STATE_DIR, "herdr-workspace-prs-state.json");
const PID_FILE = path.join(STATE_DIR, "herdr-workspace-prs.pid");
const LOG_FILE = path.join(STATE_DIR, "herdr-workspace-prs.log");
const POLL_INTERVAL_MS = 15000;
const PR_CACHE_TTL_MS = 30000;
// Hard ceiling: herdr rejects a workspace metadata update past 32 total tokens, and a
// few are already used by other plugins (space_label, space_idle, space_logo_*), plus
// 4 tokens per PR row (repo/num/status/health) — 7 is the safe max that stays under it.
const MAX_PRS_PER_WORKSPACE = 7;
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

// Pull a ticket-style ID (e.g. "CT-5098") out of a pane's terminal title, so a pane
// whose live cwd sits at a shared repo root can still be matched to its worktree(s) below.
function extractTicketHint(title: string): string | null {
  const match = title.match(/[A-Za-z]{2,}-\d+/);
  return match ? match[0].toLowerCase() : null;
}

function getRepoRootAndBranch(cwd: string): { root: string; branch: string } | null {
  try {
    const res = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (res.status !== 0 || !res.stdout) return null;
    const [root, branch] = res.stdout.trim().split("\n");
    if (!root || !branch) return null;
    return { root, branch };
  } catch {
    return null;
  }
}

function resolveOriginRepo(root: string): { owner: string; repo: string; full: string } | null {
  let originUrl = originUrlCache.get(root);
  if (originUrl === undefined) {
    try {
      const remoteRes = spawnSync("git", ["-C", root, "config", "--get", "remote.origin.url"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      originUrl = remoteRes.stdout ? remoteRes.stdout.trim() : null;
    } catch {
      originUrl = null;
    }
    originUrlCache.set(root, originUrl);
  }
  if (!originUrl) return null;
  return parseGithubRepo(originUrl);
}

function getGitBranchInfo(cwd: string): GitBranchInfo | null {
  const rb = getRepoRootAndBranch(cwd);
  if (!rb) return null;
  const { root, branch } = rb;
  if (branch === "HEAD" || branch === "main" || branch === "master" || branch === "develop") return null;

  const gh = resolveOriginRepo(root);
  if (!gh) return null;
  return { root, branch, owner: gh.owner, repo: gh.repo, full: gh.full };
}

// Fallback for a pane whose real OS cwd is still a shared base checkout (on main),
// not the worktree it actually edits — happens when an agent process never chdir's
// into the worktree. Scans every repo under the sibling `worktrees/` directory (the
// standard `<parent>/worktrees/<repo>/<branch>` layout) for a directory matching the
// pane's ticket ID, since one ticket can span multiple repos (its own PR in each).
function findWorktreeMatchesAcrossRepos(anchorRoot: string, ticketHint: string): GitBranchInfo[] {
  const worktreesRoot = path.join(path.dirname(anchorRoot), "worktrees");
  let repoDirs: string[];
  try {
    repoDirs = fs
      .readdirSync(worktreesRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }

  const results: GitBranchInfo[] = [];
  const seen = new Set<string>();
  for (const repoDir of repoDirs) {
    const repoWorktreesPath = path.join(worktreesRoot, repoDir);
    let entries: string[];
    try {
      entries = fs
        .readdirSync(repoWorktreesPath, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }

    for (const name of entries) {
      if (!name.toLowerCase().includes(ticketHint)) continue;
      const wtPath = path.join(repoWorktreesPath, name);
      const rb = getRepoRootAndBranch(wtPath);
      if (!rb) continue;
      const gh = resolveOriginRepo(rb.root);
      if (!gh) continue;
      const key = `${gh.full}:${rb.branch}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ root: rb.root, branch: rb.branch, owner: gh.owner, repo: gh.repo, full: gh.full });
    }
  }
  return results;
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
      [
        "gh",
        "pr",
        "list",
        "--repo",
        fullRepo,
        "--head",
        branch,
        "--state",
        "all",
        "--json",
        "number,title,state,isDraft,url,mergeStateStatus,statusCheckRollup",
      ],
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

type PrHealth = "ready" | "ci_fail" | "behind" | "pending";
const HEALTH_EMOJI: Record<PrHealth, string> = {
  ready: "✅", // check mark, all clear to merge
  ci_fail: "❌", // cross mark, a required check failed
  behind: "🔄", // arrows, branch is behind its base
  pending: "⏳", // hourglass, anything else (review required, conflicts, draft, still computing)
};

// GitHub's statusCheckRollup mixes modern CheckRun entries (conclusion) with legacy
// commit-status entries (state) — only count a genuine failure, not a still-running
// or intentionally-skipped check, as a CI error.
function classifyPrHealth(pr: any): PrHealth {
  const checks = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];
  const hasFailure = checks.some((c: any) => {
    const outcome = c.conclusion ?? c.state;
    return outcome === "FAILURE" || outcome === "ERROR" || outcome === "TIMED_OUT" || outcome === "CANCELLED";
  });
  if (hasFailure) return "ci_fail";
  if (pr.mergeStateStatus === "BEHIND") return "behind";
  if (pr.mergeStateStatus === "CLEAN") return "ready";
  return "pending";
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
  health: PrHealth;
  url: string;
  displayLine: string;
}

export async function runPollOnce(): Promise<Record<string, WorkspacePrItem[]>> {
  const snapRes = await sendHerdr("session.snapshot", {});
  const snapshot = snapRes.snapshot;
  if (!snapshot || !Array.isArray(snapshot.workspaces)) return {};

  const workspacesMap: Record<string, WorkspacePrItem[]> = {};
  const workspaceLinksMap: Record<string, WorkspaceLinkData> = {};
  const records: Array<{ workspace: any; prs: WorkspacePrItem[] }> = [];

  // Discover every workspace first. Column widths must be global, not per workspace.
  for (const ws of snapshot.workspaces) {
    const panes = (snapshot.panes || []).filter((p: any) => p.workspace_id === ws.workspace_id);
    const uniqueCwds = Array.from(new Set(panes.map((p: any) => p.foreground_cwd || p.cwd).filter(Boolean))) as string[];
    const prs: WorkspacePrItem[] = [];
    const seenPrKeys = new Set<string>();

    workspaceLinksMap[ws.workspace_id] = loadWorkspaceLinks(uniqueCwds);

    // Fallback anchors for a pane whose own cwd isn't inside any git repo at all
    // (e.g. still at $HOME — the agent process never cd'd anywhere). Reuse whatever
    // repo roots sibling panes in the same workspace already resolve to, since they're
    // grouped there for the same project.
    const workspaceAnchorRoots = new Set<string>();
    for (const p of panes) {
      const cwd = (p as any).foreground_cwd || (p as any).cwd;
      if (!cwd) continue;
      const rb = getRepoRootAndBranch(cwd);
      if (rb) workspaceAnchorRoots.add(rb.root);
    }

    // Iterate panes individually rather than deduped cwds: multiple ticket panes can
    // share one live cwd (the base repo checkout), and only the per-pane title tells
    // them apart once getGitBranchInfo falls back to worktree matching.
    const seenCwdHints = new Set<string>();
    for (const p of panes) {
      const cwd = (p as any).foreground_cwd || (p as any).cwd;
      if (!cwd) continue;
      const title = (p as any).terminal_title_stripped || (p as any).terminal_title || "";
      const ticketHint = extractTicketHint(title);
      const dedupeKey = `${cwd}::${ticketHint || ""}`;
      if (seenCwdHints.has(dedupeKey)) continue;
      seenCwdHints.add(dedupeKey);

      // A ticket can span multiple repos (each with its own PR), so this can yield
      // more than one candidate — direct branch match, or every worktree elsewhere
      // whose directory name matches the pane's ticket ID.
      let candidates: GitBranchInfo[] = [];
      const direct = getGitBranchInfo(cwd);
      if (direct) {
        candidates = [direct];
      } else if (ticketHint) {
        const rb = getRepoRootAndBranch(cwd);
        const anchors = rb ? [rb.root] : Array.from(workspaceAnchorRoots);
        const merged = new Map<string, GitBranchInfo>();
        for (const anchor of anchors) {
          for (const info of findWorktreeMatchesAcrossRepos(anchor, ticketHint)) {
            merged.set(`${info.full}:${info.branch}`, info);
          }
        }
        candidates = Array.from(merged.values());
      }

      for (const gitInfo of candidates) {
        const pr = await fetchPrForBranch(gitInfo.full, gitInfo.branch);
        if (!pr) continue;
        if (pr.state === "MERGED") continue; // done work; not worth a sidebar slot

        const prKey = `${gitInfo.repo}#${pr.number}`;
        if (seenPrKeys.has(prKey)) continue;
        seenPrKeys.add(prKey);

        const statusBadge = getStatusBadge(pr);
        const health = classifyPrHealth(pr);
        prs.push({
          repo: gitInfo.repo,
          repoFull: gitInfo.full,
          branch: gitInfo.branch,
          number: pr.number,
          title: pr.title || "",
          state: pr.state,
          isDraft: !!pr.isDraft,
          statusBadge,
          health,
          url: pr.url,
          displayLine: `${HEALTH_EMOJI[health]} ${gitInfo.repo} #${pr.number} ${statusBadge}`,
        });
      }
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
      currentTokens[`${prefix}_health_${pr.health}`] = HEALTH_EMOJI[pr.health];
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
    const reportedPrKey = /^pr_[1-7]_(repo|num|open|merged|draft|closed|health_ready|health_ci_fail|health_behind|health_pending)$/;
    for (const oldKey of new Set([...prevTokens, ...Object.keys(ws.tokens || {})])) {
      if ((reportedPrKey.test(oldKey) || /^pr_[1-7]$/.test(oldKey)) && !currentKeys.has(oldKey)) {
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
          workspaceLinks: workspaceLinksMap,
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
