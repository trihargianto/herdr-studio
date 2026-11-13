// Leader: a vim-style which-key popup. Ctrl+B opens it; the next key runs a command (or opens a group),
// `?` lists every shortcut. Pressing Ctrl+B again sends a real Ctrl+B to the terminal (tmux's send-prefix),
// so Neovim's page-back and the shell's cursor-left stay one extra keypress away.
// Esc closes, Backspace goes up a group. Nothing here animates: it is opened dozens of times a day.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import * as fs from "fs/promises";
import { run, hc, focused, appHome, theme, settings, closeOverlay, props, nextCommand } from "herdr";

const go = (direction) => [["pane.go", { direction }]];
const swap = (direction) => [["pane.swap", { direction }]];
const panel = (child) => [["layout.select", { stack: "panel-body", child }], ["layout.show", { id: "panel" }]];
const nth = (cmd) => Array.from({ length: 9 }, (_, i) => ({ key: String(i + 1), label: `Go to ${i + 1}`, run: [[cmd, { index: i + 1 }]] }));

// The leader tree. A group has `items`; anything else has `run`, a list of [command, args].
const TREE = [
  { key: "h", label: "Focus pane left", run: go("left") },
  { key: "j", label: "Focus pane down", run: go("down") },
  { key: "k", label: "Focus pane up", run: go("up") },
  { key: "l", label: "Focus pane right", run: go("right") },
  { key: "H", label: "Swap pane left", run: swap("left") },
  { key: "J", label: "Swap pane down", run: swap("down") },
  { key: "K", label: "Swap pane up", run: swap("up") },
  { key: "L", label: "Swap pane right", run: swap("right") },
  { key: "w", label: "Panes", items: [
    { key: "v", label: "Split right", run: [["pane.split", { direction: "right" }]] },
    { key: "s", label: "Split down", run: [["pane.split", { direction: "down" }]] },
    { key: "z", label: "Zoom pane", run: [["pane.zoom"]] },
    { key: "d", label: "Close pane", run: [["pane.close"]] },
  ] },
  { key: "t", label: "Tabs", items: [
    { key: "n", label: "New tab", run: [["tab.new"]] },
    { key: "j", label: "Next tab", run: [["tab.next"]] },
    { key: "k", label: "Previous tab", run: [["tab.prev"]] },
    { key: "r", label: "Rename tab", run: [["tab.rename"]] },
    { key: "d", label: "Close tab", run: [["tab.close"]] },
    ...nth("tab.select"),
  ] },
  { key: "s", label: "Spaces", items: [
    { key: "n", label: "New space", run: [["space.new"]] },
    { key: "j", label: "Next space", run: [["space.next"]] },
    { key: "k", label: "Previous space", run: [["space.prev"]] },
    { key: "r", label: "Rename space", run: [["space.rename"]] },
    { key: "d", label: "Close space", run: [["space.close"]] },
    ...nth("space.select"),
  ] },
  { key: "a", label: "Agents", items: [
    { key: "j", label: "Next agent", run: [["agent.next"]] },
    { key: "k", label: "Previous agent", run: [["agent.prev"]] },
  ] },
  { key: "p", label: "Panels", items: [
    { key: "m", label: "Monitoring", run: panel("usage") },
    { key: "p", label: "Projects", run: panel("projects") },
    { key: "t", label: "Tasks", run: panel("tasks") },
    { key: "i", label: "Inbox", run: panel("inbox") },
    { key: "a", label: "Panes", run: panel("panes") },
    { key: "s", label: "Send", run: panel("send") },
    { key: "g", label: "Merge requests", run: panel("mrs") },
    { key: "o", label: "Ports", run: panel("ports") },
    { key: "c", label: "Automations", run: panel("automations") },
    { key: "r", label: "Review", run: panel("review") },
  ] },
  { key: "f", label: "Find", items: [
    { key: "f", label: "Quick switcher", run: [["mod.open", { name: "studio-picker" }]] },
    { key: "p", label: "Command palette", run: [["app.palette"]] },
  ] },
  // The tab bar's Neovim button does the work, so the two never drift apart.
  { key: "n", label: "New tab with Neovim", run: [["studio-tabs.neovim"]] },
  { key: "b", label: "Toggle sidebar", run: [["layout.toggle", { id: "sidebar" }]] },
  { key: "e", label: "Toggle right panel", run: [["layout.toggle", { id: "panel" }]] },
  { key: "?", label: "All shortcuts", help: true },
];

// Every leader chord, flat, for the help list: ["t", "n"] with its label.
function chords(items = TREE, prefix = [], group = "") {
  const out = [];
  for (const it of items) {
    if (it.items) out.push(...chords(it.items, [...prefix, it.key], it.label));
    else if (!it.help) out.push({ keys: [...prefix, it.key], label: it.label, group: group || "Leader" });
  }
  return out;
}

const SYMBOL = { cmd: "⌘", shift: "⇧", alt: "⌥", ctrl: "⌃", left: "←", right: "→", up: "↑", down: "↓", enter: "↵", tab: "⇥", backspace: "⌫", escape: "Esc", space: "Space", pagedown: "PgDn", pageup: "PgUp" };
const prettyKey = (k) => k.split("-").map((p, i, a) => SYMBOL[p] ?? (i === a.length - 1 && p === "" ? "-" : p.length === 1 ? p.toUpperCase() : p)).join(" ").replace(/\s+/g, "");

const ABOUT = {
  "app.quit": "Quit", "app.hide": "Hide the app", "app.palette": "Command palette", "app.settings": "Settings", "app.help": "Herdr help",
  "app.zoom_in": "Zoom in", "app.zoom_out": "Zoom out", "app.zoom_reset": "Reset zoom", "app.theme": "Theme",
  "pane.go": "Focus pane", "pane.swap": "Swap pane", "pane.split": "Split pane", "pane.close": "Close pane", "pane.zoom": "Zoom pane",
  "tab.new": "New tab", "tab.close": "Close tab", "tab.next": "Next tab", "tab.prev": "Previous tab", "tab.select": "Go to tab", "tab.rename": "Rename tab",
  "space.new": "New space", "space.next": "Next space", "space.prev": "Previous space", "space.select": "Go to space", "space.rename": "Rename space", "space.close": "Close space",
  "agent.next": "Next agent", "agent.prev": "Previous agent", "layout.switch": "Switch layout", "layout.toggle": "Toggle", "layout.select": "Show panel", "layout.show": "Show", "layout.hide": "Hide",
  "mod.open": "Open", "terminal.search": "Find in terminal", "terminal.copy": "Copy", "terminal.paste": "Paste", "terminal.paste_image": "Paste image", "terminal.scroll": "Scroll",
  "window.minimize": "Minimize", "window.maximize": "Maximize",
};
function about(action) {
  if (typeof action === "object" && action) {
    const base = ABOUT[action.command] ?? action.command;
    const a = Object.values(action.args ?? {}).join(" ");
    return a ? `${base} · ${a}` : base;
  }
  const text = String(action);
  if (text.startsWith("send:")) return "Send keys to the terminal";
  const [cmd, ...rest] = text.split(":");
  const base = ABOUT[cmd] ?? cmd;
  return rest.length ? `${base} · ${rest.join(":")}` : base;
}

const SECTION = { global: "Everywhere", terminal: "In a terminal" };
const sectionName = (s) => SECTION[s] ?? (s.startsWith("layout:") ? `Layout · ${s.slice(7)}` : s.startsWith("mod:") ? `Panel · ${s.slice(4)}` : s);

export default class Leader extends View {
  init(_props, cx) {
    const given = props() ?? {};
    this.mode = given.help ? "help" : "leader"; // "leader" or "help"
    this.path = Array.isArray(given.path) ? given.path : []; // the group keys pressed so far
    this.keys = null; // the live keys.json, read when help opens
    this.filter = "";
    this.terminal = focused()?.terminal ?? null; // where a doubled Ctrl+B goes
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Filter shortcuts…" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value().toLowerCase(); cx.notify(); });
    // A hidden field holds the keyboard (a bare element can't be focused reliably, a text field can, as in
    // the picker); every character typed into it is a leader key, and it is emptied again at once.
    this.catcher = InputState.new({});
    this.catcher.on("change", (_e, cx) => {
      const typed = this.catcher.value();
      if (!typed) return;
      this.catcher.set_value("");
      if (this.mode === "leader") for (const ch of typed) this.char(ch, cx);
    });
    if (this.mode === "help") this.loadHelp(cx);
    else this.catcher.focus();
    // Ctrl+B pressed again arrives as a command when the keymap routes it here.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "pass") this.pass();
      }
    });
  }

  close() {
    closeOverlay(props().overlay);
  }

  // Closes first so the keyboard goes back to the pane, then runs in the same breath. (A timer on this popup
  // would die with it, so the commands never ran.)
  exec(steps) {
    this.close();
    Promise.resolve().then(() => { for (const [name, args] of steps) run(name, args); });
  }

  pass() {
    this.close();
    const terminal = this.terminal;
    if (terminal) Promise.resolve().then(() => hc(["keys", terminal, "ctrl+b"])).catch(() => {});
  }

  // Moves through the chord in place: one popup for the whole chord keeps the keyboard. (Closing a popup
  // hands the keyboard back to the pane under it, so a fresh popup per level would never hear the next key.)
  enter(path, cx) {
    this.path = path;
    this.catcher.focus();
    cx.notify();
  }

  openHelp(cx) {
    this.mode = "help";
    this.loadHelp(cx);
    cx.notify();
  }

  loadHelp(cx) {
    this.input.focus();
    cx.spawn(async (cx) => {
      try {
        this.keys = JSON.parse(await fs.readFile(`${appHome()}/keys.json`, "utf8"));
      } catch {
        this.keys = {};
      }
      cx.notify();
    });
  }

  level() {
    let items = TREE;
    for (const k of this.path) items = items.find((i) => i.key === k)?.items ?? items;
    return items;
  }

  press(e, cx) {
    const mod = e.modifiers;
    const k = e.key;
    if (k === "escape") return this.close();
    if (mod.control && k === "b") return this.pass();
    if (this.mode === "help") return false; // the filter field takes the typing
    if (k === "backspace") {
      if (this.path.length) this.enter(this.path.slice(0, -1), cx);
      else this.close();
      return true;
    }
    return false; // anything else: the field below takes it, and `char` reads it
  }

  // One typed character in leader mode: "H" for shift+h, "?" for shift+/.
  char(ch, cx) {
    const hit = this.level().find((i) => i.key === ch);
    if (!hit) return;
    if (hit.help) this.openHelp(cx);
    else if (hit.items) this.enter([...this.path, hit.key], cx);
    else this.exec(hit.run);
  }

  cap(t, label, wide) {
    const mono = settings().font_family ?? "JetBrains Mono";
    return div().flex_none().min_w(wide ? 26 : 22).h(22).px(6).flex().items_center().justify_center().rounded(5)
      .bg(t.raised).border_1().border_color(t.border).font_family(mono).text_size(11.5).font_medium().text_color(t.foreground).child(label);
  }

  renderLeader(t) {
    const items = this.level();
    const crumbs = ["Ctrl+B", ...this.path];
    const col = (it) => h_flex().id(`lead-${it.key}`).w("50%").min_w(0).h(30).px(6).gap(10).items_center()
      .child(this.cap(t, it.key, false))
      .child(div().flex_1().min_w(0).truncate().text_color(it.items ? t.accent : t.foreground).child(it.label))
      .when(Boolean(it.items), (el) => el.child(div().text_color(t.dim).child("›")));
    return v_flex().flex_none().gap(10)
      .child(h_flex().items_center().gap(6)
        .children(crumbs.map((c, i) => h_flex().gap(6).items_center().child(this.cap(t, c, i === 0)).when(i < crumbs.length - 1, (el) => el.child(div().text_color(t.dim).child("›")))))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child(this.path.length ? "⌫ back · Esc close" : "Esc close")))
      .child(v_flex().id("lead-list").h(300).flex_none().overflow_y_scrollbar()
        .child(h_flex().flex_wrap().w_full().children(items.map(col))))
      .child(div().text_size(11).text_color(t.dim).child("Ctrl+B again sends Ctrl+B to the terminal"));
  }

  renderHelp(t) {
    const q = this.filter;
    const groups = [];
    const add = (name, rows) => {
      const shown = rows.filter((r) => !q || `${name} ${r.keys} ${r.label}`.toLowerCase().includes(q));
      if (shown.length) groups.push({ name, rows: shown });
    };
    // Leader chords, grouped by their first key.
    const byGroup = new Map();
    for (const c of chords()) {
      const keys = ["⌃B", ...c.keys].join(" ");
      if (!byGroup.has(c.group)) byGroup.set(c.group, []);
      byGroup.get(c.group).push({ keys, label: c.label });
    }
    const flat = byGroup.get("Leader") ?? [];
    byGroup.delete("Leader");
    add("Leader · Ctrl+B, then", flat);
    for (const [g, rows] of byGroup) add(`Leader · ${g}`, rows);
    for (const [section, map] of Object.entries(this.keys ?? {})) {
      add(sectionName(section), Object.entries(map).map(([k, a]) => ({ keys: prettyKey(k), label: about(a) })));
    }
    return v_flex().flex_none().gap(10)
      .child(h_flex().h(36).flex_none().px(10).items_center().rounded(9).border_1().border_color(t.accent).bg(t.background)
        .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground)))
      .child(v_flex().id("help-list").h(480).flex_none().gap(14).overflow_y_scrollbar()
        .when(!this.keys, (el) => el.child(div().px(4).text_color(t.dim).child("Reading keys…")))
        .when(Boolean(this.keys) && groups.length === 0, (el) => el.child(div().px(4).text_color(t.dim).child("No shortcut matches")))
        .children(groups.map((g) => v_flex().id(`help-${g.name}`).flex_none().gap(2)
          .child(div().px(6).pb(4).text_size(11).font_semibold().text_color(t.muted).child(g.name))
          .children(g.rows.map((r, i) => h_flex().id(`help-${g.name}-${i}`).min_w(0).h(26).px(6).gap(10).items_center().rounded(4)
            .hover((s) => s.bg(t.hover))
            .child(div().flex_none().w(150).truncate().font_family(settings().font_family ?? "JetBrains Mono").text_size(12).text_color(t.foreground).child(r.keys))
            .child(div().flex_1().min_w(0).truncate().text_color(t.muted).tooltip(r.label).child(r.label)))))))
      .child(div().text_size(11).text_color(t.dim).child("Type to filter · Esc close"));
  }

  render() {
    const t = theme();
    return v_flex().id("leader").track_focus(this.handle).w_full().min_h(0).p(14).gap(10)
      .bg(t.popover).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => {
        if (this.press(e, cx) !== false) {
          cx.stop_propagation();
          cx.notify();
        }
      })
      .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().child(this.mode === "help" ? "Shortcuts" : "Leader")))
      .child(this.mode === "help" ? this.renderHelp(t) : this.renderLeader(t))
      .when(this.mode === "leader", (el) => el.child(div().w(1).h(1).overflow_hidden().child(Input.new(this.catcher).w(1).h(1))));
  }
}
