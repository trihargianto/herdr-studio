// Panels: the side panels that don't have their own button in the tab bar, as a small menu under the
// Panels button. Click one, or j/k (↓/↑) and Enter. Esc closes. The tab bar passes the list in props:
// { items: [{ id, label, icon, tip, badge: { n, color } | null }], active: id | null }.
// No motion: it opens dozens of times a day.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, theme, closeOverlay, props } from "herdr";

export default class PanelMenu extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.items = Array.isArray(p.items) ? p.items : [];
    this.active = p.active ?? null;
    this.at = Math.max(0, this.items.findIndex((i) => i.id === this.active));
    // A hidden field holds the keyboard (as in the leader); typed letters move the selection.
    this.catcher = InputState.new({});
    this.catcher.on("change", (_e, cx) => {
      const typed = this.catcher.value();
      if (!typed) return;
      this.catcher.set_value("");
      for (const ch of typed) {
        if (ch === "j") this.move(1);
        else if (ch === "k") this.move(-1);
        else if (ch === "l" || ch === "o") return this.pick(this.items[this.at]);
      }
      cx.notify();
    });
    this.catcher.focus();
  }

  move(d) {
    const n = this.items.length;
    if (n) this.at = (this.at + d + n) % n;
  }

  close() {
    const id = props()?.overlay;
    if (id) closeOverlay(id);
  }

  // Runs after the menu is gone: work left on a closed popup never runs.
  pick(item) {
    if (!item) return;
    this.close();
    const open = item.id === this.active;
    Promise.resolve().then(() => {
      // Picking the open panel again puts the panel away, like its button used to.
      if (open) return run("layout.hide", { id: "panel" });
      run("layout.select", { stack: "panel-body", child: item.id });
      run("layout.show", { id: "panel" });
    });
  }

  render() {
    const t = theme();
    return v_flex().id("panel-menu").w_full().p(6).gap(1).bg(t.popover).text_size(12.5).text_color(t.foreground)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "escape") return this.close();
        if (k === "down") this.move(1);
        else if (k === "up") this.move(-1);
        else if (k === "enter") return this.pick(this.items[this.at]);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .children(this.items.map((it, i) => h_flex().id(`pm-${it.id}`).h(30).px(8).gap(9).items_center().rounded(6).cursor_pointer()
        .when(i === this.at, (el) => el.bg(t.selected))
        .hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected))
        .tooltip(it.tip ?? it.label).accessibility_label(`${it.tip ?? it.label}${it.id === this.active ? ", open" : ""}`)
        .on_click(() => this.pick(it))
        .child(svg(it.icon).size(14).flex_none().text_color(it.id === this.active ? t.foreground : t.muted))
        .child(div().flex_1().min_w(0).truncate().child(it.label))
        .when(Boolean(it.badge), (el) => el.child(div().h(16).min_w(16).px(4).flex().items_center().justify_center().rounded(8)
          .bg(it.badge.color + "33").text_size(10.5).font_semibold().text_color(it.badge.color).child(String(it.badge.n))))
        .when(it.id === this.active, (el) => el.child(div().size(6).rounded(3).bg(t.accent)))))
      .child(div().w(1).h(1).overflow_hidden().child(Input.new(this.catcher).w(1).h(1)))
      .child(h_flex().pt(6).px(8).gap(10).border_t(1).border_color(t.border).text_size(10.5).text_color(t.dim)
        .child("j k move").child("↵ open").child("Esc close"));
  }
}
