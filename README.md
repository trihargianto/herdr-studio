# Herdr Studio

A personal layout for the [Herdr](https://herdr.dev) desktop app: a sidebar with spaces and an agent
dashboard, taller tabs, quiet pane headers, and a row of side panes for the things you do around
coding agents (tasks, messages, merge requests, ports, usage, diff review).

It is made of one layout (`layouts/studio.json`) and a set of mods (`mods/studio-*`), all written
for Herdr's native UI toolkit. A small script, `dev.py`, checks them and copies them into Herdr's
config folder.

## What you get

| Where | What it does |
| --- | --- |
| Sidebar, top | **Spaces**: coloured avatars, a status badge per space (needs you, working, done), the repo's branch when it is unusual, `Ctrl+1` to `Ctrl+9` hints. The panel sizes itself to its rows. |
| Sidebar, bottom | **Agents**: counts by status that double as filters, sections in order of urgency, each agent's title, time in state, address (click to copy) and branch. Peek and Pin on hover. |
| Tab bar | Tabs with `Cmd+1` to `Cmd+9` hints, then a **Neovim** button (a new tab running `nvim` at the repo root of the pane you are in) and the side panes below. Counters on **Ports** (dev servers), **Tasks** (to do), **Inbox** (needs you or done) and **MRs** (waiting for your review). |
| Pane header | Program, folder, branch and the terminal's Herdr address (click to copy). |
| Side pane: **Review** | Opens [Hunk](https://www.hunk.dev/) on the repo you are in (working changes, staged, last commit, branch vs base), and lists open Hunk windows so you can jump to a file or comment. |
| Side pane: **Usage** | Context fullness per agent session, and the 5-hour and weekly limits for Claude and Codex, read from the agents' own status lines. |
| Side pane: **Ports** | Dev servers listening on a port, with their folder and space. Open, copy the URL, or stop one. |
| Side pane: **Tasks** | A to-do list with Markdown details and links. "Send to agent" writes the task as a brief file and sends the chosen agent a one-line pointer. |
| Side pane: **Inbox** | Agents that need you or just finished, with the end of their screen and a reply box. |
| Side pane: **Send** | Type a message and send it to the active agent, or pick another. |
| Side pane: **MRs** | Your open GitLab merge requests and ones waiting for your review, with pipeline state, Retry, Open and Copy link. |

## Requirements

- **Herdr** (the desktop app) with its `herdr-app` command on your `PATH`. Run `herdr-app status` to check.
- **Python 3** to run `dev.py`.
- **macOS.** Ports uses `lsof` and `ps`; the rest is portable, but it has only been tried on macOS.

Optional, each for one pane:

| Tool | Needed for |
| --- | --- |
| `glab` ([GitLab CLI](https://gitlab.com/gitlab-org/cli)), signed in with `glab auth login` | the **MRs** pane and its counter |
| `hunk` ([hunk.dev](https://www.hunk.dev/)) | the **Review** pane |
| `nvim` | the **Neovim** button |
| `git` | **Review**, spaces' branch labels, repo-root detection |
| Claude Code with a status line that prints `Context … Usage … Weekly …`, and/or Codex | numbers in the **Usage** pane |

A pane whose tool is missing shows a short message instead of data. Nothing else breaks.

## Install

```sh
git clone git@github.com:trihargianto/herdr-studio.git
cd herdr-studio
python3 dev.py
```

`dev.py`:
1. runs `herdr-app check` on every mod that changed, and refuses to publish one that fails;
2. copies `layouts/` and `mods/` into `~/.config/herdr-app/`;
3. switches Herdr to the `studio` layout;
4. keeps watching the folder and republishes whenever you save a file.

Leave it running while you edit. Press `Ctrl-C` to stop watching: the layout stays installed.
To publish once and exit, run `python3 dev.py --once`.

`dev.py` only touches the files it records in `.published.json`. It will not overwrite a file in
Herdr's config folder that it did not put there, and it stops with a message if one is in the way.

## Configure

Most of it works as soon as it is installed. These are the places to adjust things.

**Layout.** `layouts/studio.json`: sidebar width (`sidebar`, 232 px), tab bar and title bar height
(44 px), pane gaps and corner radius, and the side panel's width (`panel`, 320 px). The side panes
are the children of the `panel-body` stack.

**Colours and fonts.** These come from your Herdr theme (Settings in Herdr, or `settings.json`). The
mods only use theme colours, so a different theme changes everything.

**Key hints.** The `Cmd+1` and `Ctrl+1` hints are read from your `keys.json`, so they match your
real bindings.

**Where things are saved.**

| What | Where |
| --- | --- |
| Tasks | `~/.config/herdr-app/studio-tasks/tasks.json` |
| Briefs sent to agents | `~/.config/herdr-app/studio-tasks/briefs/` |
| Small per-pane settings (Space or All, folded sections, where Hunk opens) | each pane's own local storage, inside Herdr |

**Polling.** Side panes refresh only while they are the pane shown, and only while the Herdr window
is in front. The counters in the tab bar always run: Ports every 15 s, Tasks every 5 s, MRs every
5 minutes. The intervals are constants near the top of each mod's `init`.

## How the panes find your repo

A pane looks at the terminal you last focused and uses the folder that terminal's pane reports
(`panes()` in Herdr's API), which follows `cd`. It then asks git for the repository root. Herdr's
terminal list and a space's stored folder only record where something started, so they are not used.

## Layout of this repository

| Path | What it is |
| --- | --- |
| `layouts/studio.json` | Window structure, sizes, pane frames, the side panel's stack |
| `layouts/studio.svg` | The preview Herdr's settings screen shows |
| `mods/studio-spaces` | Spaces list |
| `mods/studio-dashboard` | Agents panel (the sidebar's lower half) |
| `mods/studio-tabs` | Tab bar, side pane buttons, counters, Neovim button |
| `mods/studio-pane` | Pane headers |
| `mods/studio-workspace-chrome` | Sidebar top row and footer |
| `mods/studio-workspace-status` | Bottom status bar |
| `mods/studio-review`, `studio-usage`, `studio-ports`, `studio-tasks`, `studio-inbox`, `studio-send`, `studio-mrs` | The side panes |
| `mods/studio-agents` | An earlier copy of the agents list. Not used by the layout. |
| `dev.py` | Checks and publishes to Herdr, and watches for edits |
| `AGENTS.md`, `DESIGN.md` | Notes for coding agents and the design rules used here |

Herdr writes `gpui-kit.d.ts` and `jsconfig.json` into every mod folder so editors can complete the
API. They are generated, so they are not in git.

## Develop

1. Edit a mod or the layout in this folder, never in `~/.config/herdr-app/`.
2. With `dev.py` running, a save is checked and published within a second or two. A mod that fails
   `herdr-app check` is not published, and the reason is printed.
3. `herdr-app status` shows errors from files and mods. `herdr-app shot file.png` saves a screenshot
   of the window, which helps when adjusting spacing.

Note that `herdr-app check` renders only a mod's first, empty state. A mod can pass it and still
fail once real data arrives, so open the pane in Herdr after changing it.

## Switch back or uninstall

Return to Herdr's own layout at any time:

```sh
herdr-app do layout.switch '{"name":"main"}'
```

To remove Studio completely, stop `dev.py`, then delete the files listed in `.published.json` from
`~/.config/herdr-app/` (the `studio` layout and the `studio-*` mod folders). Your tasks stay in
`~/.config/herdr-app/studio-tasks/` unless you delete that too.

## Back up

The whole theme is this repository. Your tasks live outside it, in
`~/.config/herdr-app/studio-tasks/`, so copy that folder separately if you want them kept.

## Credits and licence

Several mods (spaces, tabs, pane header, chrome, status bar) began as copies of Herdr's shipped mods
and were reworked, so they carry Herdr's design. No licence is set for this repository yet.
