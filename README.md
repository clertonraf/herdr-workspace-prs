# herdr-workspace-prs

Local Herdr plugin and daemon that tracks GitHub PRs across workspaces.

## Features

1. **Sidebar PR status**: Displays PRs for repos in each workspace under the workspace name (`repo #number (status)`). Service names use a fixed left column, PR numbers use a fixed offset, and statuses share a right edge. Status colors are green (open), purple (merged), grey (draft), and red (closed).
2. **Popup PR picker**: Press `prefix+p` (for example, `ctrl+space p`) to open a popup for the current workspace. The popup grows with the PR count, stays within 80% of the terminal height, and scrolls with `j`/`k` or arrow keys when the list is larger. Empty workspaces show `No PRs found for this workspace.` immediately. `Enter` opens the selected PR, `o` opens all, and `r` refreshes.
3. **Hyperlinks**: PR URLs in the popup use terminal hyperlinks when the terminal supports OSC 8. `Enter` remains available as a fallback.
4. **Background sync**: A lightweight daemon polls every 15 seconds to pick up branch changes and remote PR status changes.

## Files

- `herdr-plugin.toml`: Plugin manifest.
- `daemon.ts`: Background daemon polling Git branches and GitHub via `gh`.
- `start.ts`: Startup entrypoint that daemonizes the tracker.
- `refresh.ts`: One-shot manual refresh.
- `open.ts`: Calculates popup dimensions and opens the picker.
- `picker.ts`: Interactive popup picker.

## Installation

Requirements:

- Herdr 0.7 or newer
- Bun
- GitHub CLI (`gh`) authenticated with access to the repositories you want to inspect

Install the public plugin:

```sh
herdr plugin install andrewbrannan/herdr-workspace-prs
```

Add the sidebar layout and key binding to `~/.config/herdr/config.toml`:

```toml
[ui.sidebar.spaces]
row_gap = 0
rows = [
  ["state_icon", "workspace"],
  ["branch", "git_status"],
  [{ token = "$pr_1_repo", fg = "#89b4fa" }, { token = "$pr_1_num", fg = "#f9e2af" }, { token = "$pr_1_open", fg = "#a6e3a1" }, { token = "$pr_1_merged", fg = "#cba6f7" }, { token = "$pr_1_draft", fg = "#9399b2" }, { token = "$pr_1_closed", fg = "#f38ba8" }],
  [{ token = "$pr_2_repo", fg = "#89b4fa" }, { token = "$pr_2_num", fg = "#f9e2af" }, { token = "$pr_2_open", fg = "#a6e3a1" }, { token = "$pr_2_merged", fg = "#cba6f7" }, { token = "$pr_2_draft", fg = "#9399b2" }, { token = "$pr_2_closed", fg = "#f38ba8" }],
  [{ token = "$pr_3_repo", fg = "#89b4fa" }, { token = "$pr_3_num", fg = "#f9e2af" }, { token = "$pr_3_open", fg = "#a6e3a1" }, { token = "$pr_3_merged", fg = "#cba6f7" }, { token = "$pr_3_draft", fg = "#9399b2" }, { token = "$pr_3_closed", fg = "#f38ba8" }],
  [{ token = "$pr_4_repo", fg = "#89b4fa" }, { token = "$pr_4_num", fg = "#f9e2af" }, { token = "$pr_4_open", fg = "#a6e3a1" }, { token = "$pr_4_merged", fg = "#cba6f7" }, { token = "$pr_4_draft", fg = "#9399b2" }, { token = "$pr_4_closed", fg = "#f38ba8" }],
  [{ token = "$pr_5_repo", fg = "#89b4fa" }, { token = "$pr_5_num", fg = "#f9e2af" }, { token = "$pr_5_open", fg = "#a6e3a1" }, { token = "$pr_5_merged", fg = "#cba6f7" }, { token = "$pr_5_draft", fg = "#9399b2" }, { token = "$pr_5_closed", fg = "#f38ba8" }],
]

[[keys.command]]
key = "prefix+p"
type = "plugin_action"
command = "herdr-workspace-prs.open"
description = "open workspace PRs"
```

Reload the running server with `herdr server reload-config`, then restart Herdr once so the startup hook launches the tracker. Herdr adds the plugin action during installation; the sidebar layout and key binding remain local user configuration.
