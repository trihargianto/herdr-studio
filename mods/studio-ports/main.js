// Ports and servers: everything listening on a TCP port on this computer, with the folder it
// runs from and the space it belongs to. Yours (started from a project folder) come first;
// system listeners fold away. Runs `lsof` and `ps` (read-only) every ten seconds while the
// window is in front. The only write is `kill <pid>`, after a second click.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, spaces, panes, home, theme, window, settings, layout } from "herdr";

const ICONS = "mods/studio-workspace-chrome";

// "[::1]:3000", "*:3000" and "127.0.0.1:3000" split at the last colon.
function parseName(name) {
  const i = name.lastIndexOf(":");
  const host = name.slice(0, i).replace(/^\[|\]$/g, "");
  return { host, port: Number(name.slice(i + 1)) };
}

// lsof -F output: a `p` line starts a process, `c` names it, each `n` line is one socket.
function parseListeners(out) {
  const found = new Map();
  let pid = null, cmd = "";
  for (const line of out.split("\n")) {
    const tag = line[0], rest = line.slice(1);
    if (tag === "p") pid = Number(rest);
    else if (tag === "c") cmd = rest;
    else if (tag === "n" && pid !== null) {
      const { host, port } = parseName(rest);
      if (!Number.isFinite(port)) continue;
      const key = `${pid}:${port}`;
      const known = found.get(key);
      // One process often listens on both IPv4 and IPv6: one row, the widest host wins.
      const exposed = host === "*" || host === "0.0.0.0" || host === "::";
      if (!known) found.set(key, { pid, cmd, port, exposed });
      else known.exposed ||= exposed;
    }
  }
  return [...found.values()];
}

// Long absolute paths in a command line shrink to their last part.
function shorten(command) {
  return command.split(/\s+/).map((tok) => (tok.startsWith("/") ? tok.split("/").pop() : tok)).join(" ");
}

// The agents' own helpers listen on ports too (claude, codex, plannotator): they are not your servers.
const TOOLS = new Set(["claude", "codex", "plannotator", "hc", "herdr-core", "herdr-app"]);
const firstWord = (command) => command.split(/\s+/)[0].split("/").pop();
const isTool = (p) => TOOLS.has(firstWord(p.command)) || TOOLS.has(p.cmd) || /^\d+\.\d+\.\d+$/.test(p.cmd);

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

export default class Ports extends View {
  init(_props, cx) {
    this.list = null;
    this.error = null;
    this.loading = false;
    this.at = null;
    this.confirm = null; // a pid whose kill awaits a second click
    this.copied = null;
    this.showHidden = false;
    this.last = 0;
    // Looks every ten seconds, but only while this pane is the one shown (and on the first look after it opens).
    cx.timer.every(2000, (cx) => {
      if (window()?.active && shown("ports") && Date.now() - this.last > 10000) this.refresh(cx);
    });
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    this.last = Date.now();
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const sockets = await exec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"], { cwd: home(), timeout: 15000 });
        const listeners = parseListeners(sockets.stdout);
        const pids = [...new Set(listeners.map((l) => l.pid))];
        const folders = new Map(), commands = new Map();
        if (pids.length) {
          const [cwd, ps] = await Promise.all([
            exec("lsof", ["-a", "-d", "cwd", "-Fpn", "-p", pids.join(",")], { cwd: home(), timeout: 15000 }),
            exec("ps", ["-o", "pid=,command=", "-p", pids.join(",")], { cwd: home(), timeout: 15000 }),
          ]);
          let pid = null;
          for (const line of cwd.stdout.split("\n")) {
            if (line[0] === "p") pid = Number(line.slice(1));
            else if (line[0] === "n" && pid !== null) folders.set(pid, line.slice(1));
          }
          for (const line of ps.stdout.split("\n")) {
            const m = line.match(/^\s*(\d+)\s+(.*)$/);
            if (m) commands.set(Number(m[1]), m[2]);
          }
        }
        this.list = listeners
          .map((l) => {
            const command = commands.get(l.pid) ?? l.cmd;
            // Claude's process is named after its version: call it by what it runs.
            return { ...l, cwd: folders.get(l.pid) ?? "", command, cmd: /^\d+\.\d+\.\d+$/.test(l.cmd) ? firstWord(command) : l.cmd };
          })
          .sort((a, b) => a.port - b.port);
        this.at = Date.now();
        this.error = null;
      } catch (e) {
        this.error = String(e.message ?? e);
      }
      this.loading = false;
      cx.notify();
    });
  }

  kill(proc, cx) {
    if (this.confirm !== proc.pid) {
      this.confirm = proc.pid;
      cx.notify();
      cx.timer.after(3000, (cx) => {
        if (this.confirm === proc.pid) this.confirm = null;
        cx.notify();
      });
      return;
    }
    this.confirm = null;
    cx.spawn(async (cx) => {
      try {
        await exec("kill", [String(proc.pid)], { cwd: home(), timeout: 10000 });
      } catch {}
      this.loading = false;
      // Give it a moment to exit before looking again.
      cx.timer.after(700, (cx) => this.refresh(cx));
    });
  }

  copy(text, key, cx) {
    cx.write_to_clipboard(text);
    this.copied = key;
    cx.notify();
    cx.timer.after(1200, (cx) => {
      if (this.copied === key) this.copied = null;
      cx.notify();
    });
  }

  iconButton(t, id, path, text, action, color) {
    return div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(6)
      .text_color(color ?? t.dim).cursor_pointer().tooltip(text).accessibility_label(text)
      .hover((s) => s.bg(t.raised).text_color(color ?? t.foreground)).active((s) => s.bg(t.selected))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        action(cx);
      })
      .child(svg(path).size(13));
  }

  // The space (and named tab) whose terminal sits in or around the folder the process runs from.
  place(proc, ctx) {
    if (!proc.cwd) return null;
    let best = null, score = 0;
    for (const p of ctx.panes) {
      if (!p.cwd) continue;
      const near = proc.cwd === p.cwd || proc.cwd.startsWith(`${p.cwd}/`) || p.cwd.startsWith(`${proc.cwd}/`);
      const length = Math.min(p.cwd.length, proc.cwd.length);
      if (near && length > score) { best = p; score = length; }
    }
    const where = best && ctx.tabs.get(best.tab);
    if (!where) return null;
    return where.tab.named ? `${where.space.name} / ${where.tab.name}` : where.space.name;
  }

  // canStop: only your own servers get a stop button. Stopping an agent's helper would end the agent.
  row(t, proc, ctx, canStop = false) {
    const url = `http://localhost:${proc.port}`;
    const confirming = this.confirm === proc.pid;
    const folder = proc.cwd.startsWith(`${ctx.home}/`) ? `~${proc.cwd.slice(ctx.home.length)}` : proc.cwd;
    const where = this.place(proc, ctx);
    const mono = settings().font_family ?? "JetBrains Mono";
    return v_flex().id(`port-${proc.pid}-${proc.port}`).w_full().flex_none().px(12).py(10).gap(6).rounded(10).border(1).border_color(t.border).bg(t.chrome)
      .hover((s) => s.bg(t.hover))
      .child(h_flex().gap(8).items_center().h(24)
        .child(div().flex_none().font_family(mono).text_size(15).font_semibold().child(String(proc.port)))
        .child(div().id(`port-name-${proc.pid}-${proc.port}`).flex_1().min_w(0).truncate().font_medium().tooltip(proc.command).child(proc.cmd))
        .when(proc.exposed, (el) => el.child(h_flex().id(`port-exposed-${proc.pid}-${proc.port}`).h(18).px(7).flex_none().items_center().rounded(9)
          .bg(t.ansi3 + "26").text_size(10.5).font_medium().text_color(t.ansi3)
          .tooltip("Listening on all network interfaces, so other machines on your network can reach it").child("network")))
        .child(this.iconButton(t, `port-open-${proc.pid}-${proc.port}`, "mods/studio-ports/external.svg", `Open ${url}`, (cx) => cx.open_url(url)))
        .child(this.iconButton(t, `port-copy-${proc.pid}-${proc.port}`, this.copied === `${proc.pid}-${proc.port}` ? `${ICONS}/check.svg` : "mods/studio-ports/copy.svg",
          this.copied === `${proc.pid}-${proc.port}` ? "Copied" : `Copy ${url}`, (cx) => this.copy(url, `${proc.pid}-${proc.port}`, cx),
          this.copied === `${proc.pid}-${proc.port}` ? t.ansi2 : null))
        .when(canStop, (el) => el.child(confirming
          ? h_flex().id(`port-kill-${proc.pid}-${proc.port}`).h(24).px(9).items_center().flex_none().rounded(6).bg(t.blocked + "26").text_size(11.5).font_medium().text_color(t.blocked)
            .cursor_pointer().accessibility_label(`Confirm: stop ${proc.cmd} on port ${proc.port}`)
            .hover((s) => s.bg(t.blocked + "3a")).active((s) => s.bg(t.blocked + "4d"))
            .on_click((_e, cx) => {
              cx.stop_propagation();
              this.kill(proc, cx);
            })
            .child("Stop?")
          : this.iconButton(t, `port-kill-${proc.pid}-${proc.port}`, "mods/studio-ports/power.svg", `Stop ${proc.cmd} (pid ${proc.pid})`, (cx) => this.kill(proc, cx)))))
      .child(div().id(`port-cmd-${proc.pid}-${proc.port}`).min_w(0).truncate().text_size(11.5).text_color(t.dim).tooltip(proc.command).child(shorten(proc.command)))
      .child(h_flex().gap(6).items_center().text_size(11).text_color(t.dim)
        .when(Boolean(where), (el) => el.child(h_flex().h(18).px(7).flex_none().items_center().rounded(9).bg(t.raised).text_color(t.muted).child(where)))
        .when(Boolean(folder) && folder !== "/", (el) => el.child(div().id(`port-dir-${proc.pid}-${proc.port}`).flex_1().min_w(0).truncate().tooltip(proc.cwd).child(folder)))
        .child(div().flex_none().font_family(mono).text_size(10.5).child(`pid ${proc.pid}`)));
  }

  // A heading that folds a group of rows.
  fold(t, id, text, count, open, action) {
    return h_flex().id(id).h(28).px(2).mt(6).gap(7).items_center().flex_none().rounded(6)
      .text_size(11.5).font_medium().text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected))
      .accessibility_label(`${text}, ${count}. ${open ? "Collapse" : "Expand"}`)
      .on_click((_e, cx) => action(cx))
      .child(div().child(text))
      .child(div().text_color(t.dim).child(String(count)))
      .child(div().flex_1())
      .child(svg(`${ICONS}/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none().text_color(t.dim));
  }

  render() {
    const t = theme();
    const now = Date.now();
    const all = this.list ?? [];
    const base = home();
    // Yours: running from a project folder. The rest is system software.
    const yours = all.filter((p) => p.cwd.startsWith(`${base}/`) && !p.cwd.startsWith(`${base}/Library`));
    const mine = yours.filter((p) => !isTool(p));
    const tools = yours.filter(isTool);
    const other = all.filter((p) => !yours.includes(p));
    const tabs = new Map(spaces().flatMap((s) => s.tabs.map((tab) => [tab.id, { space: s, tab }])));
    const ctx = { home: base, panes: panes().filter((p) => p.terminal && p.cwd), tabs };
    return v_flex().size_full().min_w(0).min_h(0).bg(t.chrome).text_color(t.foreground).text_size(13)
      .child(h_flex().flex_none().px(14).pt(14).pb(10).items_center().gap(8)
        .child(div().text_size(13).font_semibold().child("Ports"))
        .when(this.list, (el) => el.child(div().text_size(11.5).text_color(t.dim).child(`${mine.length} ${mine.length === 1 ? "server" : "servers"}`)))
        .child(div().flex_1())
        .child(div().id("ports-refresh").size(24).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim)
          .tooltip("Refresh").accessibility_label("Refresh ports")
          .when(!this.loading, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).active((s) => s.bg(t.selected))
            .on_click((_e, cx) => this.refresh(cx)))
          .child(this.loading ? svg(`${ICONS}/spinner.svg`).size(13).text_color(t.muted).spin(900) : svg("mods/studio-ports/refresh.svg").size(13))))
      .child(v_flex().id("ports-scroll").flex_1().min_h(0).px(12).pb(14).gap(8).overflow_y_scrollbar()
        .when(Boolean(this.error), (el) => el.child(div().px(4).py(6).text_size(12).text_color(t.blocked).child(this.error)))
        .when(!this.list && !this.error, (el) => el.child(div().px(4).py(8).text_color(t.dim).child("Looking…")))
        .when(Boolean(this.list) && !mine.length, (el) => el.child(v_flex().px(4).py(8).gap(4)
          .child(div().text_color(t.muted).child("No servers running"))
          .child(div().text_size(12).text_color(t.dim).child("Dev servers you start from a project folder show up here."))))
        .children(mine.map((p) => this.row(t, p, ctx, true)))
        // Everything that isn't your own server stays out of sight behind one quiet line.
        .when(tools.length + other.length > 0, (el) => el.child(h_flex().id("ports-hidden").h(28).px(2).mt(6).gap(7).items_center().flex_none().rounded(6)
          .text_size(11.5).text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).active((s) => s.bg(t.selected))
          .accessibility_label(`${this.showHidden ? "Hide" : "Show"} ${tools.length + other.length} agent and system listeners`)
          .on_click((_e, cx) => {
            this.showHidden = !this.showHidden;
            cx.notify();
          })
          .child(div().flex_1().child(this.showHidden ? "Hide agent and system listeners" : `${tools.length + other.length} agent and system listeners hidden`))
          .child(svg(`${ICONS}/chevron-${this.showHidden ? "down" : "right"}.svg`).size(11).flex_none())))
        .when(this.showHidden, (el) => el.children([...tools, ...other].map((p) => this.row(t, p, ctx)))));
  }
}
