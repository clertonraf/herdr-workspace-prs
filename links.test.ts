import { describe, expect, it } from "bun:test";
import { inferLinkTitle, parseLinksAndNotes, getCommonPath } from "./links.ts";

describe("inferLinkTitle", () => {
  it("infers Linear titles from issue URLs", () => {
    expect(inferLinkTitle("https://linear.app/team/issue/ENG-1234/some-slug")).toBe("Linear: ENG-1234");
    expect(inferLinkTitle("https://linear.app/team")).toBe("Linear");
  });

  it("infers GitHub titles from PR and issue URLs", () => {
    expect(inferLinkTitle("https://github.com/my-org/my-repo/pull/42")).toBe("GitHub: my-org/my-repo#42");
    expect(inferLinkTitle("https://github.com/my-org/my-repo/issues/99")).toBe("GitHub: my-org/my-repo#99");
    expect(inferLinkTitle("https://github.com/my-org/my-repo")).toBe("GitHub: my-org/my-repo");
  });

  it("infers common domains", () => {
    expect(inferLinkTitle("https://workspace.slack.com/archives/C123/p456")).toBe("Slack");
    expect(inferLinkTitle("https://www.notion.so/my-page-123")).toBe("Notion");
    expect(inferLinkTitle("https://app.datadoghq.com/dashboard/abc")).toBe("Datadog");
    expect(inferLinkTitle("https://docs.google.com/document/d/123/edit")).toBe("Google Doc");
    expect(inferLinkTitle("https://example.com/test")).toBe("example.com");
  });
});

describe("parseLinksAndNotes", () => {
  it("parses markdown links and bare URLs from dedicated LINKS.md", () => {
    const md = `
# Workspace Links & Notes

- [Linear Ticket](https://linear.app/org/issue/ENG-500)
- https://workspace.slack.com/archives/C123/p999
- Bare link with punctuation: https://app.datadoghq.com/dash/1.

## Notes
- Deployment requires running migration first
- Do not merge until reviewed by team
    `;

    const { links, notes } = parseLinksAndNotes(md);
    expect(links).toHaveLength(3);
    expect(links[0]).toEqual({ title: "Linear Ticket", url: "https://linear.app/org/issue/ENG-500" });
    expect(links[1]).toEqual({ title: "Slack", url: "https://workspace.slack.com/archives/C123/p999" });
    expect(links[2]).toEqual({ title: "Datadog", url: "https://app.datadoghq.com/dash/1" });

    expect(notes).toHaveLength(2);
    expect(notes[0]).toBe("Deployment requires running migration first");
    expect(notes[1]).toBe("Do not merge until reviewed by team");
  });

  it("parses bullet notes in dedicated file even without a ## Notes heading", () => {
    const md = `
# Workspace
- [Linear](https://linear.app/team/issue/ENG-1)
- Test Redis migration with test client
    `;
    const { links, notes } = parseLinksAndNotes(md);
    expect(links).toHaveLength(1);
    expect(links[0].title).toBe("Linear");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toBe("Test Redis migration with test client");
  });

  it("ignores placeholder URLs and trims backticks/punctuation", () => {
    const md = `
# Links
- \`https://service.internal/health\`
- https://<workspace>.<service>.local
- [Documentation](\`https://docs.internal/spec\`)
    `;
    const { links } = parseLinksAndNotes(md);
    expect(links).toHaveLength(2);
    expect(links[0].url).toBe("https://service.internal/health");
    expect(links[1].url).toBe("https://docs.internal/spec");
  });
});

describe("getCommonPath", () => {
  it("finds the common path of multiple directories", () => {
    const paths = [
      "/tmp/workspace/src/repo1",
      "/tmp/workspace/src/repo2",
      "/tmp/workspace",
    ];
    expect(getCommonPath(paths)).toBe("/tmp/workspace");
  });
});
