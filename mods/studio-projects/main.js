// Projects: folders you always work in. Click one to focus its space, or open a new space there.
// The list is kept in shared state ("studio.projects"), so it survives restarts and stays out of git.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import * as fs from "fs/promises";
import { spaces, panes, theme, run, home, notify, shared, setShared } from "herdr";

const KEY = "studio.projects";
const HOME = home().replace(/\/$/, "");

const base = (p) => p.replace(/\/+$/, "").split("/").pop() || p;
const parent = (p) => p.replace(/\/+$/, "").replace(/\/[^/]*$/, "") || "/";
const abbrev = (p) => (p === HOME ? "~" : p.startsWith(HOME + "/") ? "~" + p.slice(HOME.length) : p);
const expand = (raw) => {
  const s = raw.trim();
  const p = s === "~" ? HOME : s.startsWith("~/") ? HOME + s.slice(1) : s;
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
};
const inside = (cwd, path) => Boolean(cwd) && (cwd === path || cwd.startsWith(path === "/" ? "/" : path + "/"));

export default class Projects extends View {
  init(_props, cx) {
    const saved = shared(KEY);
    this.list = Array.isArray(saved) ? saved.filter((p) => typeof p === "string") : [];
    this.missing = new Set();
    this.adding = false;
    this.root = HOME;
    this.expanded = new Set();
    this.kids = new Map();
    this.ticked = new Set();
    this.showHidden = false;
    this.invalid = false;
    this.hover = null;

    this.pathIn = InputState.new({ placeholder: "Go to a folder, press Enter" });
    this.pathIn.on("submit", (_e, cx) => this.jump(this.pathIn.value(), cx));
    this.checkMissing(cx);
  }

  async checkMissing(cx) {
    const gone = new Set();
    for (const p of this.list) if (!(await fs.exists(p))) gone.add(p);
    this.missing = gone;
    cx.notify();
  }

  save() {
    setShared(KEY, this.list);
  }

  // ---- add view: a folder tree. Each folder expands in place; tick any number of them.

  openAdd(cx) {
    this.adding = true;
    this.ticked = new Set();
    this.expanded = new Set();
    this.kids = new Map(); // path -> [{ name, path }] once read, "error" when unreadable
    this.showHidden = false;
    this.invalid = false;
    this.pathIn.set_value(HOME);
    this.pathIn.focus();
    this.setRoot(HOME, cx);
    cx.notify();
  }

  async setRoot(path, cx) {
    this.root = path;
    this.expanded = new Set([path]);
    await this.load(path, cx);
    cx.notify();
  }

  async load(path, cx) {
    if (this.kids.has(path)) return;
    try {
      const entries = await fs.readdir(path, { withFileTypes: true });
      this.kids.set(path, entries
        .filter((e) => e.isDirectory())
        .map((e) => ({ name: e.name, path: (path === "/" ? "" : path) + "/" + e.name }))
        .sort((a, b) => a.name.localeCompare(b.name)));
    } catch {
      this.kids.set(path, "error");
    }
    cx.notify();
  }

  async jump(raw, cx) {
    const path = expand(raw);
    if (!path.startsWith("/") || !(await fs.exists(path))) {
      this.invalid = true;
      cx.notify();
      return;
    }
    this.invalid = false;
    this.pathIn.set_value(path);
    await this.setRoot(path, cx);
  }

  expandToggle(path, cx) {
    if (this.expanded.has(path)) this.expanded.delete(path);
    else {
      this.expanded.add(path);
      this.load(path, cx);
    }
    cx.notify();
  }

  toggle(path, cx) {
    if (this.list.includes(path)) return;
    if (this.ticked.has(path)) this.ticked.delete(path);
    else this.ticked.add(path);
    cx.notify();
  }

  confirmAdd(cx) {
    const add = [...this.ticked].filter((p) => !this.list.includes(p));
    if (add.length) {
      this.list = [...this.list, ...add];
      this.save();
      this.checkMissing(cx);
    }
    this.adding = false;
    cx.notify();
  }

  // ---- list view

  spaceFor(path) {
    const tabSpace = new Map();
    for (const s of spaces()) for (const t of s.tabs) tabSpace.set(t.id, s.id);
    const hits = new Set();
    for (const p of panes()) if (inside(p.cwd, path) && tabSpace.has(p.tab)) hits.add(tabSpace.get(p.tab));
    const matches = spaces().filter((s) => !s.machine && hits.has(s.id));
    return matches.find((s) => s.active) ?? matches[0] ?? null;
  }

  async open(path) {
    const hit = this.spaceFor(path);
    if (hit) return run("space.select", { id: hit.id });
    if (!(await fs.exists(path))) {
      notify({ title: "Folder not found", body: abbrev(path), level: "warning" });
      return;
    }
    run("space.new", { name: base(path), folder: path });
  }

  remove(path, cx) {
    this.list = this.list.filter((p) => p !== path);
    this.missing.delete(path);
    this.save();
    cx.notify();
  }

  header(t, title, right) {
    return h_flex().flex_none().px(14).pt(14).pb(6).items_center().gap(8)
      .child(div().font_semibold().text_size(13).child(title))
      .child(div().flex_1())
      .child(right);
  }

  iconButton(id, label, text, t, onClick) {
    return div().id(id).w(22).h(22).flex().items_center().justify_center().rounded(4)
      .cursor_pointer().text_color(t.muted).tooltip(label).accessibility_label(label)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).active((s) => s.bg(t.selected))
      .on_click(onClick).child(text);
  }

  row(path, t, cx) {
    const open = Boolean(this.spaceFor(path));
    const gone = this.missing.has(path);
    return h_flex().id(`project-${path}`).w_full().min_w(0).h(44).flex_none()
      .px(7).gap(8).items_center().rounded(3).cursor_pointer()
      .hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected))
      .tooltip(gone ? `${path}\nFolder not found` : path)
      .accessibility_label(`${base(path)}, ${abbrev(path)}${open ? ", space open" : ""}`)
      .on_hover((on, cx2) => {
        if (on) this.hover = path;
        else if (this.hover === path) this.hover = null;
        cx2.notify();
      })
      .on_click(() => this.open(path))
      .child(div().w(8).h(8).flex_none().rounded(4).when(open, (el) => el.bg(t.ansi2)))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().truncate().text_color(gone ? t.dim : t.foreground).child(base(path)))
        .child(div().truncate().text_size(11).text_color(t.dim).child(abbrev(path))))
      .child(div().flex_none().w(22).h(22)
        .when(this.hover === path, (el) => el.child(this.iconButton(`project-x-${path}`, `Remove ${base(path)}`, "×", t, (_e, cx2) => {
          cx2.stop_propagation();
          this.remove(path, cx2);
        }))));
  }

  renderList(t, cx) {
    return v_flex().size_full().min_w(0).min_h(0).bg(t.chrome).text_color(t.foreground).text_size(12.5)
      .child(this.header(t, "Projects", this.iconButton("projects-add", "Add projects", "+", t, (_e, cx) => this.openAdd(cx))))
      .child(v_flex().id("projects-scroll").flex_1().min_h(0).px(12).pb(14).gap(2).overflow_y_scrollbar()
        .children(this.list.map((p) => this.row(p, t, cx)))
        .when(!this.list.length, (el) => el.child(div().px(2).py(14).text_color(t.muted).child("No projects yet. Press + to add some"))));
  }

  check(on, disabled, t) {
    return div().w(14).h(14).flex_none().flex().items_center().justify_center().rounded(3)
      .border_1().border_color(on ? t.accent : t.border).when(on, (el) => el.bg(disabled ? t.dim : t.accent))
      .text_size(10).text_color(t.chrome).child(on ? "✓" : "");
  }

  // The visible tree, flattened to rows with a depth.
  flat() {
    const out = [];
    const walk = (path, name, depth) => {
      out.push({ path, name, depth });
      if (!this.expanded.has(path)) return;
      const kids = this.kids.get(path);
      if (kids === undefined) out.push({ path, depth: depth + 1, note: "Loading…" });
      else if (kids === "error") out.push({ path, depth: depth + 1, note: "Can't read this folder" });
      else {
        const shown = kids.filter((k) => this.showHidden || !k.name.startsWith("."));
        if (!shown.length) out.push({ path, depth: depth + 1, note: "No subfolders" });
        for (const k of shown) walk(k.path, k.name, depth + 1);
      }
    };
    walk(this.root, abbrev(this.root), 0);
    return out;
  }

  treeRow(r, t, cx) {
    const indent = 6 + r.depth * 14;
    if (r.note) {
      return div().id(`note-${r.path}-${r.depth}`).h(24).flex_none().pl(indent + 36).flex().items_center()
        .text_size(11).text_color(t.dim).child(r.note);
    }
    const already = this.list.includes(r.path);
    const on = already || this.ticked.has(r.path);
    const open = this.expanded.has(r.path);
    return h_flex().id(`node-${r.path}`).w_full().min_w(0).h(28).flex_none().pl(indent).pr(6).gap(4).items_center()
      .rounded(3).cursor_pointer().hover((s) => s.bg(t.hover))
      .accessibility_label(`${r.name}${open ? ", expanded" : ""}${already ? ", already added" : ""}`)
      .on_click((_e, cx) => this.expandToggle(r.path, cx))
      .child(div().w(16).flex_none().flex().items_center().justify_center().text_color(t.muted).text_size(11)
        .child(open ? "▾" : "▸"))
      .child(div().id(`tick-${r.path}`).w(20).h(20).flex_none().flex().items_center().justify_center()
        .when(!already, (el) => el.cursor_pointer())
        .tooltip(already ? "Already in Projects" : on ? "Untick" : "Add as a project")
        .on_click((_e, cx2) => {
          cx2.stop_propagation();
          this.toggle(r.path, cx2);
        })
        .child(this.check(on, already, t)))
      .child(div().flex_1().min_w(0).truncate().text_color(already ? t.dim : t.foreground).tooltip(r.path).child(r.name));
  }

  renderAdd(t, cx) {
    const n = this.ticked.size;
    const atTop = this.root === "/";
    return v_flex().size_full().min_w(0).min_h(0).bg(t.chrome).text_color(t.foreground).text_size(12.5)
      .child(this.header(t, "Add projects", this.iconButton("projects-cancel", "Cancel", "×", t, (_e, cx) => { this.adding = false; cx.notify(); })))
      .child(v_flex().flex_none().px(12).pb(8).gap(4)
        .child(h_flex().gap(4).items_center()
          .child(this.iconButton("projects-up", "Up one folder", "↑", t, (_e, cx) => { if (!atTop) this.jump(parent(this.root), cx); }))
          .child(div().flex_1().min_w(0).child(Input.new(this.pathIn).w_full().text_size(12.5).text_color(t.foreground)))
          .child(this.iconButton("projects-home", "Home", "~", t, (_e, cx) => this.jump(HOME, cx))))
        .child(h_flex().items_center().gap(8)
          .child(div().flex_1().text_size(11).text_color(this.invalid ? t.ansi1 : t.dim)
            .child(this.invalid ? "Not a folder" : "Expand folders with the arrow, tick to add"))
          .child(div().id("projects-hidden").px(6).h(20).flex().items_center().rounded(4).cursor_pointer().text_size(11)
            .text_color(this.showHidden ? t.foreground : t.dim).hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { this.showHidden = !this.showHidden; cx.notify(); })
            .child(this.showHidden ? "Hidden: shown" : "Hidden: off"))))
      .child(v_flex().id("projects-tree").flex_1().min_h(0).px(8).gap(1).overflow_y_scrollbar()
        .children(this.flat().map((r) => this.treeRow(r, t, cx))))
      .child(h_flex().flex_none().p(12).child(
        div().id("projects-confirm").flex_1().h(30).flex().items_center().justify_center().rounded(5)
          .bg(n ? t.accent : t.raised).text_color(n ? t.chrome : t.dim).font_semibold()
          .when(n > 0, (el) => el.cursor_pointer().on_click((_e, cx) => this.confirmAdd(cx)))
          .child(n ? `Add ${n} ${n === 1 ? "project" : "projects"}` : "Add projects")));
  }

  render(cx) {
    const t = theme();
    return this.adding ? this.renderAdd(t, cx) : this.renderList(t, cx);
  }
}
