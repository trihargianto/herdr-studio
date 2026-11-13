import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { panes, spaces, theme, settings, run, nextCommand } from "herdr";

const STATUS = { working: "Working", blocked: "Needs you", done: "Done", idle: "Idle" };

export default class PaneNavigator extends View {
  init(_props, cx) {
    // Keyboard (vim-style): Ctrl+B l (or pane.go) moves here; j/k pick a pane, Enter goes, h/Esc leave.
    this.handle = cx.focus_handle();
    this.sel = null; // the highlighted pane id; null: the focused one
    this.order = []; // pane ids in the order drawn, kept by render
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") { this.sel = null; this.handle.focus(); cx.notify(); }
      }
    });
  }

  onKey(e, cx) {
    const m = e.modifiers;
    if (m.control || m.platform || m.alt) return;
    const ids = this.order;
    if (!ids.length) return;
    const focusedId = panes().find((p) => p.focused)?.pane;
    let i = Math.max(0, ids.indexOf(this.sel ?? focusedId));
    const k = e.key;
    if (k === "j" || k === "down") i = Math.min(ids.length - 1, i + 1);
    else if (k === "k" || k === "up") i = Math.max(0, i - 1);
    else if (k === "g" && m.shift) i = ids.length - 1;
    else if (k === "g") i = 0;
    else if (k === "enter" || k === "l" || k === "o") { run("pane.focus", { pane: ids[i] }); cx.stop_propagation(); return; }
    else if (k === "h" || k === "escape") { run("pane.go", { direction: "left" }); cx.stop_propagation(); return; }
    else return;
    this.sel = ids[i];
    cx.stop_propagation();
    cx.notify();
  }

  row(p, t, kbd) {
    const title = p.mod || (p.program?.agent ? p.program.name : "Terminal");
    const address = p.terminal ?? p.pane;
    const task = p.program?.agent
      ? (p.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, "").trim()
      : "";
    const activity = p.program?.agent
      ? (task && task.toLowerCase() !== title.toLowerCase() ? task : STATUS[p.status] || "No task reported")
      : p.terminal
        ? (p.program?.shell ? "Idle" : p.program?.name ? `Running · ${p.program.name}` : "Activity unknown")
        : null;
    const detail = [title, p.title, `Address: ${address}`, `Pane: ${p.pane}`, p.cwd || p.mod, STATUS[p.status]].filter(Boolean).join("\n");
    return h_flex().id(`pane-row-${p.pane}`).w_full().min_w(0).h(activity ? 44 : 26).flex_none()
      .px(7).gap(7).items_center().rounded(3)
      .when(p.focused && !kbd, el => el.bg(t.selected))
      .when(kbd && p.pane === this.kbdSel, el => el.bg(t.selected).border_1().border_color(t.accent))
      .cursor_pointer().tooltip(detail)
      .hover(s => s.bg(t.hover)).active(s => s.bg(t.selected))
      .accessibility_label(`Go to ${title}, address ${address}${activity ? `, ${activity}` : ""}${p.focused ? ", current pane" : ""}`)
      .on_click(() => run("pane.focus", { pane: p.pane }))
      .child(div().id(`pane-address-${p.pane}`).max_w(130).min_w(0).truncate().px(5).py(2).rounded(4).bg(t.raised)
        .font_family(settings().font_family ?? "JetBrains Mono").text_size(13).font_medium().text_color(t.muted)
        .tooltip(`Address: ${address}\nPane: ${p.pane}`).child(address))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().truncate().text_color(p.focused ? t.foreground : t.muted).child(title))
        .when(Boolean(activity), el => el.child(div().id(`pane-task-${p.pane}`).truncate()
          .text_size(11).text_color(t.dim).tooltip(activity).child(activity))));
  }

  render() {
    const t = theme();
    const all = panes();
    const kbd = this.handle.is_focused();
    this.kbdSel = this.sel ?? all.find((p) => p.focused)?.pane ?? null;
    const order = [];
    const byTab = new Map();
    for (const p of all) {
      if (!byTab.has(p.tab)) byTab.set(p.tab, []);
      byTab.get(p.tab).push(p);
    }
    const rows = [];
    const listed = new Set();
    for (const space of spaces()) {
      const count = space.tabs.reduce((n, tab) => n + (byTab.get(tab.id)?.length ?? 0), 0);
      if (!count) continue;
      const label = `${space.name}${space.machine ? ` · ${space.machine}` : ""}`;
      const tabs = [];
      for (const tab of space.tabs) {
        const group = byTab.get(tab.id) ?? [];
        if (!group.length) continue;
        for (const p of group) { listed.add(p.pane); order.push(p.pane); }
        const name = tab.named ? tab.name : `Tab ${tab.index}`;
        tabs.push(v_flex().id(`pane-tab-${tab.id}`).flex_none().min_w(0)
          .child(div().id(`pane-tab-name-${tab.id}`).h(26).px(7).flex().items_center()
            .text_color(t.muted).tooltip(name).child(div().truncate().child(name)))
          .child(v_flex().ml(12).pl(5).min_w(0).border_l(1).border_color(t.border)
            .children(group.map(p => this.row(p, t, kbd)))));
      }
      rows.push(v_flex().id(`pane-space-${space.id}`).flex_none().min_w(0)
        .child(div().id(`pane-space-name-${space.id}`).h(28).px(7).flex().items_center()
          .tooltip(label).child(div().truncate().child(label)))
        .child(v_flex().ml(12).pl(5).min_w(0).border_l(1).border_color(t.border).children(tabs)));
    }

    // A pane can arrive before its space metadata during a remote update.
    for (const p of all) if (!listed.has(p.pane)) { rows.push(this.row(p, t, kbd)); order.push(p.pane); }
    this.order = order;
    return v_flex().id("panes-root").track_focus(this.handle).on_key_down((e, cx) => this.onKey(e, cx))
      .size_full().min_w(0).min_h(0).bg(t.chrome).text_color(t.foreground).text_size(12.5)
      .child(h_flex().flex_none().px(14).pt(14).pb(6).items_center().gap(8)
        .child(div().font_semibold().text_size(13).child("Panes"))
        .child(div().text_size(11).text_color(t.dim).child(`${all.length} ${all.length === 1 ? "pane" : "panes"}`)))
      .child(v_flex().id("pane-navigator-scroll").flex_1().min_h(0).px(12).pb(14).gap(2).overflow_y_scrollbar()
        .children(rows)
        .when(!all.length, el => el.child(div().px(2).py(14).text_color(t.muted).child("No panes open"))))
      .when(kbd, el => el.child(h_flex().flex_none().px(14).py(8).gap(10).border_t(1).border_color(t.border).text_size(10.5).text_color(t.dim)
        .child("j k move").child("↵ go").child("g G top/end").child("h back")));
  }
}
