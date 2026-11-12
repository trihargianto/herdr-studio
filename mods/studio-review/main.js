// Review: opens Hunk (https://www.hunk.dev/) on the repository of the terminal you are in, and
// lists the Hunk windows that are open so you can jump to a file or a comment inside one.
// Runs `git` (read-only, in the focused terminal's folder) and `hunk` (`session list`/`navigate`
// against the local daemon). A Hunk window opens only when you press a button.
// Local repositories only: Hunk's daemon lives on this computer.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, focused, panes, spaces, terminals, run, theme, window, settings, layout } from "herdr";

const ICONS = "mods/studio-workspace-chrome";

const base = (path) => path.replace(/\/+$/, "").split("/").pop();

function load(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

async function git(cwd, args) {
  const r = await exec("git", args, { cwd, timeout: 15000 });
  return r.code === 0 ? r.stdout.trim() : null;
}

// A pane in the side panel does work only while it is the one shown: a hidden pane's timers still run,
// so each tick asks first. (The tab bar keeps its own counters, which are always needed.)
function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}
function shown(id) {
  const root = layout();
  const panel = findNode(root, "panel");
  return Boolean(panel && !panel.hidden && findNode(root, "panel-body")?.active === id);
}

export default class Review extends View {
  init(_props, cx) {
    this.repo = null; // { root, branch, base, changed, staged, ahead } for the focused terminal
    this.note = null;
    this.sessions = [];
    this.open = null; // the expanded Hunk window's id
    this.place = load("place", "right"); // "right" beside the focused pane, or "tab"
    this.cwd = undefined;
    this.last = 0;
    // The repository follows the terminal you are in and Hunk windows are polled gently, both only
    // while this pane is the one shown (and at once when it opens).
    cx.timer.every(2000, (cx) => {
      if (!window()?.active || !shown("review")) return;
      const now = Date.now();
      if (now - this.last > 10000) {
        this.last = now;
        this.refreshRepo(cx);
        this.refreshSessions(cx);
      } else if ((focused()?.cwd ?? null) !== this.cwd) {
        this.refreshRepo(cx);
      }
    });
  }

  refreshRepo(cx) {
    const f = focused();
    const cwd = f?.cwd ?? null;
    this.cwd = cwd;
    if (!cwd || (f?.terminal ?? "").includes("/")) {
      this.repo = null;
      this.remote = Boolean(cwd);
      cx.notify();
      return;
    }
    this.remote = false;
    // The terminal you are in first; if it isn't in a repository, the others in this space.
    const tabIds = new Set((spaces().find((s) => s.active)?.tabs ?? []).map((tab) => tab.id));
    // The folder a program runs in (an agent's worktree) is in the terminal list, not the pane's own folder.
    // The folder the pane reports as you move around. The terminal list's folder is only where the
    // terminal started, so it is the last resort.
    const started = new Map(terminals().map((x) => [x.address, x.cwd]));
    const folderOf = (p) => p.cwd ?? started.get(p.terminal);
    const inTab = panes().filter((p) => p.terminal && tabIds.has(p.tab));
    const mine = inTab.find((p) => p.terminal === f?.terminal);
    const candidates = [...new Set([mine ? folderOf(mine) : cwd, cwd, ...inTab.map(folderOf)].filter(Boolean))].slice(0, 6);
    cx.spawn(async (cx) => {
      try {
        let root = null;
        for (const c of candidates) {
          root = await git(c, ["rev-parse", "--show-toplevel"]);
          if (root) break;
        }
        if (!root) {
          this.repo = null;
        } else {
          const [branch, status, head] = await Promise.all([
            git(root, ["symbolic-ref", "--short", "-q", "HEAD"]),
            git(root, ["status", "--porcelain=v1"]),
            git(root, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]),
          ]);
          let baseRef = head;
          // No origin/HEAD recorded: fall back to a branch that exists.
          for (const guess of baseRef ? [] : ["origin/develop", "origin/main", "origin/master"]) {
            if (await git(root, ["rev-parse", "--verify", "-q", guess])) { baseRef = guess; break; }
          }
          const ahead = baseRef ? Number(await git(root, ["rev-list", "--count", `${baseRef}..HEAD`])) || 0 : 0;
          let changed = 0, staged = 0;
          for (const line of (status ?? "").split("\n").filter(Boolean)) {
            const x = line[0], y = line[1];
            if (x !== " " && x !== "?") staged++;
            if (y !== " " || x === "?") changed++;
          }
          this.repo = { root, branch: branch ?? "detached", base: baseRef, changed, staged, ahead };
        }
      } catch {
        this.repo = null;
      }
      cx.notify();
    });
  }

  refreshSessions(cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await exec("hunk", ["session", "list", "--json"], { timeout: 15000 });
        // No daemon running means no Hunk window is open.
        this.sessions = r.code === 0 ? JSON.parse(r.stdout).sessions ?? [] : [];
      } catch {
        this.sessions = [];
      }
      cx.notify();
    });
  }

  launch(label, argv, cx) {
    const repo = this.repo;
    if (!repo) return;
    this.note = null;
    run("terminal.open", { argv, folder: repo.root, place: this.place, name: `Hunk · ${label}` });
    this.note = { ok: true, text: `Opened ${label.toLowerCase()} in Hunk` };
    cx.notify();
    // The window registers with the daemon a moment after it starts.
    cx.timer.after(1800, (cx) => this.refreshSessions(cx));
  }

  // Jump inside an open Hunk window without switching to it.
  jump(session, args, cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await exec("hunk", ["session", "navigate", session.sessionId, ...args, "--json"], { timeout: 15000 });
        this.note = r.code === 0 ? { ok: true, text: "Moved in Hunk" } : { ok: false, text: (r.stderr || r.stdout || "Hunk didn't move").trim().split("\n")[0] };
      } catch {
        this.note = { ok: false, text: "Hunk didn't move" };
      }
      cx.notify();
    });
  }

  // The pane showing this Hunk window, found by its folder and program.
  paneOf(session) {
    return panes().find((p) => p.terminal && (p.cwd === session.cwd || p.cwd === session.repoRoot) && /hunk/i.test(`${p.program?.key ?? ""} ${p.program?.name ?? ""} ${p.title ?? ""}`)) ?? null;
  }

  button(t, id, label, action) {
    return div().id(id).h(26).px(10).flex().items_center().flex_none().rounded(7).text_size(12).font_medium().cursor_pointer()
      .accessibility_label(label).border(1).border_color(t.border).bg(t.chrome).text_color(t.foreground)
      .hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        action(cx);
      })
      .child(label);
  }

  // A launch row: what it opens, how much there is to review, and a quiet hint of the command.
  launcher(t, id, title, hint, count, argv, enabled) {
    const mono = settings().font_family ?? "JetBrains Mono";
    return h_flex().id(id).h(48).px(12).gap(10).items_center().flex_none().rounded(10).border(1).border_color(t.border).bg(t.chrome)
      .accessibility_label(`${title}${count != null ? `, ${count}` : ""}. ${enabled ? "Open in Hunk" : "Nothing to review"}`)
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected))
        .on_click((_e, cx) => this.launch(title, argv, cx)))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().truncate().text_color(enabled ? t.foreground : t.dim).font_medium().child(title))
        .child(div().id(`${id}-hint`).truncate().text_size(11).text_color(t.dim).font_family(mono).tooltip(`hunk ${argv.slice(1).join(" ")}`).child(hint)))
      .when(count != null, (el) => el.child(div().flex_none().h(20).min_w(20).px(6).flex().items_center().justify_center().rounded(10)
        .bg(count > 0 ? t.raised : "#00000000").text_size(11.5).font_medium().text_color(count > 0 ? t.foreground : t.dim).child(String(count))))
      .child(svg(`${ICONS}/chevron-right.svg`).size(12).flex_none().text_color(enabled ? t.dim : t.dim + "55"));
  }

  windowCard(t, s) {
    const open = this.open === s.sessionId;
    const pane = this.paneOf(s);
    const adds = (s.files ?? []).reduce((n, f) => n + (f.additions ?? 0), 0);
    const dels = (s.files ?? []).reduce((n, f) => n + (f.deletions ?? 0), 0);
    return v_flex().id(`hunk-${s.sessionId}`).w_full().flex_none().rounded(10).border(1).border_color(open ? t.input : t.border).bg(open ? t.surface : t.chrome)
      .when(!open, (el) => el.hover((c) => c.bg(t.hover)).active((c) => c.bg(t.selected)))
      .child(v_flex().id(`hunk-head-${s.sessionId}`).px(12).py(10).gap(4).cursor_pointer()
        .accessibility_label(`${s.title}, ${s.fileCount} files. ${open ? "Collapse" : "Show files"}`)
        .on_click((_e, cx) => {
          this.open = open ? null : s.sessionId;
          cx.notify();
        })
        .child(div().id(`hunk-title-${s.sessionId}`).truncate().font_medium().tooltip(s.title).child(s.title))
        .child(h_flex().gap(8).items_center().text_size(11.5).text_color(t.dim)
          .child(div().child(`${s.fileCount} ${s.fileCount === 1 ? "file" : "files"}`))
          .child(div().text_color(t.ansi2).child(`+${adds}`))
          .child(div().text_color(t.ansi1).child(`−${dels}`))
          .child(div().flex_1().min_w(0).truncate().text_right().child(base(s.repoRoot ?? s.cwd ?? "")))))
      .when(open, (el) => el.child(v_flex().px(12).pb(12).gap(8)
        .child(v_flex().gap(1).children((s.files ?? []).slice(0, 14).map((f, i) => h_flex().id(`hunk-file-${s.sessionId}-${i}`).h(26).px(6).gap(8).items_center().rounded(6)
          .text_size(11.5).cursor_pointer().accessibility_label(`Go to ${f.path} in Hunk`)
          .hover((c) => c.bg(t.hover)).active((c) => c.bg(t.selected))
          .on_click((_e, cx) => this.jump(s, ["--file", f.path, "--hunk", "1"], cx))
          .child(div().id(`hunk-file-name-${s.sessionId}-${i}`).flex_1().min_w(0).truncate().text_color(t.muted).tooltip(f.path).child(f.path))
          .child(div().flex_none().text_color(t.ansi2).child(`+${f.additions ?? 0}`))
          .child(div().flex_none().text_color(t.ansi1).child(`−${f.deletions ?? 0}`)))))
        .when((s.files ?? []).length > 14, (el) => el.child(div().px(6).text_size(11).text_color(t.dim).child(`and ${(s.files ?? []).length - 14} more in Hunk`)))
        .child(h_flex().gap(6)
          .when(Boolean(pane), (el) => el.child(this.button(t, `hunk-focus-${s.sessionId}`, "Go to window", () => run("pane.focus", { pane: pane.pane }))))
          .child(this.button(t, `hunk-next-${s.sessionId}`, "Next comment", (cx) => this.jump(s, ["--next-comment"], cx)))
          .child(this.button(t, `hunk-prev-${s.sessionId}`, "Previous", (cx) => this.jump(s, ["--prev-comment"], cx))))));
  }

  segment(t, id, label, on, action) {
    return div().id(id).h(22).px(10).flex().items_center().rounded(5).text_size(11.5).cursor_pointer()
      .accessibility_label(label).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.dim)
      .when(!on, (el) => el.hover((s) => s.text_color(t.foreground)))
      .on_click((_e, cx) => {
        action();
        cx.notify();
      })
      .child(label);
  }

  render() {
    const t = theme();
    const r = this.repo;
    return v_flex().size_full().min_w(0).min_h(0).bg(t.chrome).text_color(t.foreground).text_size(13)
      .child(h_flex().flex_none().px(14).pt(14).pb(10).items_center().gap(8)
        .child(div().text_size(13).font_semibold().child("Review"))
        .child(div().text_size(11.5).text_color(t.dim).child("in Hunk"))
        .child(div().flex_1())
        .child(div().id("review-refresh").size(24).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).cursor_pointer()
          .tooltip("Refresh").accessibility_label("Refresh review")
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).active((s) => s.bg(t.selected))
          .on_click((_e, cx) => {
            this.refreshRepo(cx);
            this.refreshSessions(cx);
          })
          .child(svg("mods/studio-review/refresh.svg").size(13))))
      .child(v_flex().id("review-scroll").flex_1().min_h(0).px(12).pb(14).gap(10).overflow_y_scrollbar()
        .when(this.remote, (el) => el.child(div().px(4).py(6).text_size(12).text_color(t.dim).whitespace_normal().child("This terminal is on another machine. Hunk reviews repositories on this computer only.")))
        .when(!r && !this.remote, (el) => el.child(div().px(4).py(6).text_size(12).text_color(t.dim).whitespace_normal().child("The terminal you are in isn't inside a git repository.")))
        .when(Boolean(r), (el) => el.child(h_flex().px(2).gap(8).items_center()
          .child(div().flex_none().text_size(13).font_medium().child(base(r.root)))
          .child(div().id("review-branch").flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).tooltip(r.branch).child(r.branch))))
        .when(Boolean(r), (el) => el.child(this.launcher(t, "open-working", "Working changes", "hunk diff --watch", r.changed, ["hunk", "diff", "--watch"], r.changed > 0)))
        .when(Boolean(r), (el) => el.child(this.launcher(t, "open-staged", "Staged", "hunk diff --staged", r.staged, ["hunk", "diff", "--staged"], r.staged > 0)))
        .when(Boolean(r), (el) => el.child(this.launcher(t, "open-commit", "Last commit", "hunk show", null, ["hunk", "show"], true)))
        .when(Boolean(r) && Boolean(r.base), (el) => el.child(this.launcher(t, "open-branch", `Branch vs ${r.base}`, `hunk diff ${r.base}...HEAD`, r.ahead, ["hunk", "diff", `${r.base}...HEAD`], r.ahead > 0)))
        .when(Boolean(r), (el) => el.child(h_flex().px(2).gap(8).items_center()
          .child(div().text_size(11.5).text_color(t.dim).child("Open"))
          .child(h_flex().p(2).gap(2).rounded(7).border(1).border_color(t.border)
            .child(this.segment(t, "place-right", "Beside", this.place === "right", () => { this.place = "right"; save("place", "right"); }))
            .child(this.segment(t, "place-tab", "New tab", this.place === "tab", () => { this.place = "tab"; save("place", "tab"); })))))
        .when(Boolean(this.note), (el) => el.child(div().px(2).text_size(11.5).text_color(this.note.ok ? t.ansi2 : t.blocked).child(this.note.text)))
        .child(h_flex().h(26).px(2).mt(6).gap(8).items_center().text_size(11.5).font_medium().text_color(t.muted)
          .child(div().child("Open in Hunk"))
          .child(div().text_color(t.dim).child(String(this.sessions.length))))
        .when(!this.sessions.length, (el) => el.child(div().px(2).text_size(12).text_color(t.dim).whitespace_normal().child("No Hunk window is open. Pick one above.")))
        .children(this.sessions.map((s) => this.windowCard(t, s))));
  }
}
