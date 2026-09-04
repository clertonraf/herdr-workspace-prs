import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface WorkspaceLinkItem {
  title: string;
  url: string;
}

export interface WorkspaceLinkData {
  links: WorkspaceLinkItem[];
  notes: string[];
  linksFile: string | null;
  workspaceRoot: string | null;
}

export function inferLinkTitle(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host.includes("github.com")) {
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts.length >= 4 && parts[2] === "pull") return `GitHub: ${parts[0]}/${parts[1]}#${parts[3]}`;
      if (parts.length >= 4 && parts[2] === "issues") return `GitHub: ${parts[0]}/${parts[1]}#${parts[3]}`;
      if (parts.length >= 2) return `GitHub: ${parts[0]}/${parts[1]}`;
      return "GitHub";
    }
    if (host.includes("gitlab.com")) {
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts.length >= 4 && parts[2] === "merge_requests") return `GitLab: ${parts[0]}/${parts[1]}!${parts[3]}`;
      if (parts.length >= 4 && parts[2] === "issues") return `GitLab: ${parts[0]}/${parts[1]}#${parts[3]}`;
      return "GitLab";
    }
    if (host.includes("linear.app")) {
      const match = u.pathname.match(/\/issue\/([A-Za-z0-9_-]+)/);
      if (match) return `Linear: ${match[1]}`;
      return "Linear";
    }
    if (host.includes("jira") || u.pathname.includes("/browse/")) {
      const match = u.pathname.match(/\/browse\/([A-Za-z0-9_-]+)/);
      if (match) return `Jira: ${match[1]}`;
      return "Jira";
    }
    if (host.includes("slack.com")) return "Slack";
    if (host.includes("notion.so") || host.includes("notion.site")) return "Notion";
    if (host.includes("figma.com")) return "Figma";
    if (host.includes("datadoghq.com")) return "Datadog";
    if (host.includes("docs.google.com")) {
      if (u.pathname.includes("/document/")) return "Google Doc";
      if (u.pathname.includes("/spreadsheets/")) return "Google Sheet";
      if (u.pathname.includes("/presentation/")) return "Google Slides";
      return "Google Docs";
    }
    return host;
  } catch {
    return url;
  }
}

export function parseLinksAndNotes(
  content: string
): { links: WorkspaceLinkItem[]; notes: string[] } {
  const lines = content.split("\n");
  const links: WorkspaceLinkItem[] = [];
  const notes: string[] = [];
  const seenUrls = new Set<string>();
  let inNotesSection = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const headingMatch = line.match(/^(#+)\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const heading = headingMatch[2].trim().toLowerCase();
      if (level >= 2 && (/^(notes?|todos?|memos?)(\s*:)?$/.test(heading) || /workspace\s+notes?$/.test(heading))) {
        inNotesSection = true;
      } else {
        inNotesSection = false;
      }
      continue;
    }

    const mdLinkRegex = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
    let match: RegExpExecArray | null;
    const lineMatchedUrls = new Set<string>();
    while ((match = mdLinkRegex.exec(line)) !== null) {
      const url = match[2].replace(/[.,;:!?`'"*_~]+$/, "").trim();
      if (!url || url.includes("<") || url.includes(">")) continue;
      const title = match[1].trim() || inferLinkTitle(url);
      if (!seenUrls.has(url)) {
        seenUrls.add(url);
        links.push({ title, url });
      }
      lineMatchedUrls.add(url);
    }

    const bareUrlRegex = /(https?:\/\/[^\s)\]]+)/g;
    while ((match = bareUrlRegex.exec(line)) !== null) {
      const rawUrl = match[1].replace(/[.,;:!?`'"*_~]+$/, "").trim();
      if (!rawUrl || rawUrl.includes("<") || rawUrl.includes(">")) continue;
      if (!lineMatchedUrls.has(rawUrl) && !seenUrls.has(rawUrl)) {
        seenUrls.add(rawUrl);
        links.push({ title: inferLinkTitle(rawUrl), url: rawUrl });
      }
      lineMatchedUrls.add(rawUrl);
    }

    // Extract notes: lines in a notes section without URLs, or bullets without URLs
    const hasUrl = lineMatchedUrls.size > 0 || /https?:\/\//.test(line);
    const isBullet = /^[-*+]\s+/.test(line);
    if (!hasUrl && (inNotesSection || isBullet)) {
      const cleanNote = line.replace(/^[-*+]\s+/, "").replace(/^\d+\.\s+/, "").trim();
      if (cleanNote && !/^[-*_]{3,}$/.test(cleanNote)) {
        notes.push(cleanNote);
      }
    }
  }

  return { links, notes };
}

export function getCommonPath(paths: string[]): string | null {
  if (paths.length === 0) return null;
  const resolved = paths.map((p) => path.resolve(p));
  const parts = resolved.map((p) => p.split(path.sep));
  const common: string[] = [];
  for (let i = 0; i < parts[0].length; i++) {
    const seg = parts[0][i];
    if (parts.every((p) => p[i] === seg)) {
      common.push(seg);
    } else {
      break;
    }
  }
  const res = common.join(path.sep) || path.sep;
  return res;
}

export function findWorkspaceRootAndFiles(cwds: string[]): {
  workspaceRoot: string | null;
  linksFile: string | null;
} {
  const home = os.homedir();
  const validCwds = Array.from(
    new Set(
      cwds
        .filter((c) => c && c !== home && c !== path.sep && fs.existsSync(c))
        .map((c) => path.resolve(c))
    )
  );
  if (validCwds.length === 0) {
    return { workspaceRoot: null, linksFile: null };
  }

  const candidateRoots: string[] = [];
  const common = getCommonPath(validCwds);
  if (common && common !== home && common !== path.dirname(home) && common !== path.sep) {
    candidateRoots.push(common);
  }

  const sortedCwds = [...validCwds].sort((a, b) => a.length - b.length);
  for (const c of sortedCwds) {
    if (!candidateRoots.includes(c)) candidateRoots.push(c);
  }

  // Only look for LINKS.md / links.md
  for (const root of candidateRoots) {
    for (const name of ["LINKS.md", "links.md"]) {
      const p = path.join(root, name);
      if (fs.existsSync(p)) return { workspaceRoot: root, linksFile: p };
    }
  }

  return {
    workspaceRoot: candidateRoots[0] || null,
    linksFile: null,
  };
}

export function loadWorkspaceLinks(cwds: string[]): WorkspaceLinkData {
  const { workspaceRoot, linksFile } = findWorkspaceRootAndFiles(cwds);
  if (!linksFile || !fs.existsSync(linksFile)) {
    return { links: [], notes: [], linksFile: null, workspaceRoot };
  }
  try {
    const content = fs.readFileSync(linksFile, "utf8");
    const { links, notes } = parseLinksAndNotes(content);
    return { links, notes, linksFile, workspaceRoot };
  } catch {
    return { links: [], notes: [], linksFile, workspaceRoot };
  }
}
