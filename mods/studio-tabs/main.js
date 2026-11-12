import { View, div, svg, image } from "gpui-kit";
import { h_flex, ScrollHandle } from "gpui-base";
import { spaces, panes, agents, run, openOverlay, theme, window, layout, settings, keys, focused, terminals, exec, readTextFile, appHome, home } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The agents' own helpers listen on ports too: they are not your dev servers.
const TOOLS = new Set(["claude", "codex", "plannotator", "hc", "herdr-core", "herdr-app"]);
const VERSION = /^\d+\.\d+\.\d+$/;

export default class Tabs extends View {
  init(_props, cx) {
    this.barWidth = null; // the tab bar's width, to drop the labels when it gets tight
    this.pressed = null;
    this.scroll = ScrollHandle.new();
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
    // Counters for the Tasks and MRs buttons. The MR count is kept between runs, so it shows at once.
    this.todo = 0;
    this.review = (() => { try { return JSON.parse(localStorage.getItem("review"))?.n ?? 0; } catch { return 0; } })();
    this.me = null;
    this.counting = false;
    this.servers = 0;
    this.readTodo(cx);
    this.countServers(cx);
    cx.timer.every(15000, (cx) => this.countServers(cx));
    this.countReviews(cx);
    cx.timer.every(5000, (cx) => this.readTodo(cx));
    cx.timer.every(300000, (cx) => this.countReviews(cx));
  }

  // Dev servers running: listeners on a TCP port started from a project folder, leaving out the
  // agents' own helpers. The same rule as the Ports pane. Read-only `lsof` and `ps`, every ten seconds
  // while the window is in front.
  countServers(cx) {
    if (!window()?.active || this.scanning) return;
    this.scanning = true;
    cx.spawn(async (cx) => {
      let n = this.servers;
      try {
        const base = home();
        const sockets = await exec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"], { cwd: base, timeout: 15000 });
        const found = new Map();
        let pid = null, cmd = "";
        for (const line of sockets.stdout.split("\n")) {
          const tag = line[0], rest = line.slice(1);
          if (tag === "p") pid = Number(rest);
          else if (tag === "c") cmd = rest;
          else if (tag === "n" && pid !== null) {
            const port = Number(rest.slice(rest.lastIndexOf(":") + 1));
            if (Number.isFinite(port)) found.set(`${pid}:${port}`, { pid, cmd });
          }
        }
        const pids = [...new Set([...found.values()].map((x) => x.pid))];
        if (!pids.length) n = 0;
        else {
          const [cwd, ps] = await Promise.all([
            exec("lsof", ["-a", "-d", "cwd", "-Fpn", "-p", pids.join(",")], { cwd: base, timeout: 15000 }),
            exec("ps", ["-o", "pid=,command=", "-p", pids.join(",")], { cwd: base, timeout: 15000 }),
          ]);
          const folders = new Map(), commands = new Map();
          let at = null;
          for (const line of cwd.stdout.split("\n")) {
            if (line[0] === "p") at = Number(line.slice(1));
            else if (line[0] === "n" && at !== null) folders.set(at, line.slice(1));
          }
          for (const line of ps.stdout.split("\n")) {
            const m = line.match(/^\s*(\d+)\s+(.*)$/);
            if (m) commands.set(Number(m[1]), m[2]);
          }
          n = [...found.values()].filter((x) => {
            const dir = folders.get(x.pid) ?? "";
            const command = commands.get(x.pid) ?? x.cmd;
            const word = command.split(/\s+/)[0].split("/").pop();
            const tool = TOOLS.has(word) || TOOLS.has(x.cmd) || VERSION.test(x.cmd);
            return dir.startsWith(`${base}/`) && !dir.startsWith(`${base}/Library`) && !tool;
          }).length;
        }
      } catch {}
      this.scanning = false;
      if (n !== this.servers) {
        this.servers = n;
        cx.notify();
      }
    });
  }

  // To-do tasks: read from the file the Tasks pane saves, so the count is right even before that pane has been opened.
  readTodo(cx) {
    if (!window()?.active) return;
    cx.spawn(async (cx) => {
      let n = this.todo;
      try {
        const text = await readTextFile(`${appHome()}/studio-tasks/tasks.json`);
        n = text ? JSON.parse(text).filter((x) => x.status === "todo").length : 0;
      } catch {}
      if (n !== this.todo) {
        this.todo = n;
        cx.notify();
      }
    });
  }

  // Merge requests waiting for your review: others' open, non-draft MRs naming you as reviewer that you haven't approved.
  // The same rule as the MR pane's "to review" count. Read-only `glab` calls every three minutes while the window is in front.
  countReviews(cx) {
    if (this.counting || !window()?.active) return;
    this.counting = true;
    cx.spawn(async (cx) => {
      try {
        const glab = async (args) => {
          const r = await exec("glab", args, { cwd: home(), timeout: 30000 });
          if (r.code !== 0) throw new Error("glab failed");
          return JSON.parse(r.stdout);
        };
        this.me ??= (await glab(["api", "user"])).username;
        const asked = (await glab(["api", `merge_requests?scope=all&state=opened&reviewer_username=${encodeURIComponent(this.me)}&per_page=20`]))
          .filter((m) => m.author?.username !== this.me && !m.draft);
        const done = await Promise.all(asked.slice(0, 12).map(async (m) => {
          try {
            const a = await glab(["api", `projects/${m.project_id}/merge_requests/${m.iid}/approvals`]);
            return (a.approved_by ?? []).some((x) => x.user?.username === this.me);
          } catch {
            return false;
          }
        }));
        const n = asked.length - done.filter(Boolean).length;
        if (n !== this.review) {
          this.review = n;
          cx.notify();
        }
        try { localStorage.setItem("review", JSON.stringify({ n, at: Date.now() })); } catch {}
      } catch {}
      this.counting = false;
    });
  }

  // "\u23181" for tab 1, from the key actually bound to tab.select:1.
  shortcut(n) {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "\u2318" : "Ctrl+", ctrl: mac ? "\u2303" : "Ctrl+", shift: mac ? "\u21e7" : "Shift+", alt: mac ? "\u2325" : "Alt+", option: mac ? "\u2325" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === `tab.select:${n}`);
    return b ? b.keys.split("-").map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("") : null;
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render() {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const active = shown.findIndex(tab => tab.active);
    const selected = shown[active]?.id;
    if (selected !== this.selected || active !== this.selectedIndex) {
      this.selected = selected;
      this.selectedIndex = active;
      if (active >= 0) this.scroll.scroll_to_item(active);
    }
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const program = panes().find(p => p.tab === c.id && p.program?.agent)?.program ?? panes().find(p => p.tab === c.id)?.program;
      const name = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
      return h_flex().id(`tab-${c.id}`).h(30).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        // A rename or status dot on this or an earlier tab can push the active one out.
        .when(i <= active, el => el.on_size_change((_size, cx) => { this.scroll.scroll_to_item(active); cx.notify(); }))
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .cursor_pointer()
        .hover(s => s.bg(c.active ? t.raised : t.hover))
        .active(s => s.bg(t.selected))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(i < 9 && Boolean(this.shortcut(i + 1)), el => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(this.shortcut(i + 1))))
        .when(c.status === "working", el => el.child(svg("mods/studio-workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/studio-pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    // The panes this bar offers. Files and Changes are not among them.
    const enabled = ["inbox", "send", "mrs", "tasks", "ports", "usage", "review"];
    // What the Inbox holds: agents that need you, and ones that finished while you were away.
    const waiting = agents().filter(a => a.status === "blocked" || a.status === "done");
    const blocked = waiting.filter(a => a.status === "blocked").length;
    const finished = waiting.length - blocked;
    const inboxColor = blocked ? t.blocked : t.done;
    this.syncPanel(space, panel, body, enabled);
    // label: text next to the icon; without it the button is icon-only and says what it is on hover.
    const panelButton = (id, label, icon, tip, badge) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(label ? 8 : 7).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .cursor_pointer().tooltip(tip ?? label).accessibility_label(tip ?? label)
        .hover(s => s.bg(on ? t.selected : t.hover)).active(s => s.bg(t.selected)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(14))
        .when(Boolean(label), el => el.child(label))
        .when(Boolean(badge), el => el.child(div().h(16).min_w(16).px(4).flex().items_center().justify_center().rounded(8).bg(badge.color + "33").text_size(10.5).font_semibold().text_color(badge.color).child(String(badge.n))));
    };
    // Words next to the icons while there is room for them.
    const words = this.barWidth === null || this.barWidth >= 1100;
    const named = (text) => (words ? text : null);
    return h_flex().id("tab-bar").size_full().min_w(0).px(10).pl(lightsPadding)
      .on_size_change((size, cx) => {
        if (this.barWidth !== size.width) {
          this.barWidth = size.width;
          cx.notify();
        }
      }).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().track_scroll(this.scroll)
        .on_size_change((_size, cx) => { if (active >= 0) { this.scroll.scroll_to_item(active); cx.notify(); } })
        .children(shown.map(item)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      // A new tab running Neovim, in the folder of the terminal you are in.
      .child(h_flex().id("nvim-new").h(26).px(words ? 8 : 7).gap(5).flex_none().items_center().rounded(6).text_size(12)
        .text_color(t.muted).cursor_pointer().tooltip("New tab with Neovim").accessibility_label("Open Neovim in a new tab")
        .hover(s => s.bg(t.hover).text_color(t.foreground)).active(s => s.bg(t.selected)).on_mouse_down("left", stop)
        .on_click((_e, cx) => {
          const f = focused();
          // The folder the pane reports as you move around. The terminal list's folder is only where
          // the terminal started, so it is the last resort.
          const pane = panes().find(p => p.terminal === f?.terminal);
          const started = terminals().find(x => x.address === f?.terminal)?.cwd;
          const here = pane?.cwd ?? f?.cwd ?? started;
          const remote = (f?.terminal ?? "").includes("/");
          cx.spawn(async (cx) => {
            // The root of the repository the pane is in (a worktree's own root counts). If it isn't
            // inside one, the pane's own folder: a space's recorded folder is only where it was created.
            let folder = here;
            if (here && !remote) {
              let top = null;
              try {
                const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: here, timeout: 10000 });
                if (r.code === 0) top = r.stdout.trim();
              } catch {}
              folder = top || here;
            }
            run("terminal.open", { argv: ["nvim"], place: "tab", name: "Neovim", ...(folder && !remote ? { folder } : {}) });
          });
        })
        .child(svg("mods/studio-workspace-chrome/terminal.svg").size(14))
        .when(words, el => el.child("Neovim")))
      .child(panelButton("review", named("Review"), "mods/studio-workspace-chrome/git-compare.svg", "Review changes in Hunk"))
      .child(panelButton("usage", named("Usage"), "mods/studio-tabs/chart.svg", "Usage"))
      .child(panelButton("ports", named("Ports"), "mods/studio-tabs/plug.svg", this.servers ? `Ports · ${this.servers} ${this.servers === 1 ? "server" : "servers"} running` : "Ports and servers", this.servers ? { n: this.servers, color: t.ansi2 } : null))
      .child(panelButton("tasks", named("Tasks"), "mods/studio-tabs/list-todo.svg", this.todo ? `Tasks · ${this.todo} to do` : "Tasks", this.todo ? { n: this.todo, color: t.muted } : null))
      .child(panelButton("inbox", named("Inbox"), "mods/studio-tabs/inbox.svg", waiting.length ? `Inbox · ${[blocked ? `${blocked} need you` : null, finished ? `${finished} done` : null].filter(Boolean).join(", ")}` : "Inbox", waiting.length ? { n: waiting.length, color: inboxColor } : null))
      .child(panelButton("send", named("Send"), "mods/studio-tabs/send.svg", "Send a message to an agent"))
      .child(panelButton("mrs", named("MRs"), "mods/studio-tabs/git-pull-request.svg", this.review ? `Merge requests · ${this.review} to review` : "Merge requests", this.review ? { n: this.review, color: t.working } : null))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/studio-tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/studio-tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/studio-tabs/win-close.svg").size(16) : svg("mods/studio-pane/close.svg").size(13), () => run("window.close"))));
  }
}
