import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, panes, focused, theme, run, window, keys, home, settings } from "herdr";

const ICONS = "mods/studio-workspace-chrome";

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

export default class WorkspaceStatus extends View {
  init() {
    // The address just copied, shown as "Copied" for a moment.
    this.copied = null;
  }

  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint(t) {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "\u2318" : "Ctrl+", ctrl: mac ? "\u2303" : "Ctrl+", shift: mac ? "\u21e7" : "Shift+", alt: mac ? "\u2325" : "Alt+", option: mac ? "\u2325" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  // The focused terminal's herdr address: click copies it for a prompt.
  address(t, address) {
    const copied = this.copied === address;
    return h_flex().id("status-address").flex_none().h(18).px(5).gap(3).items_center().rounded(4)
      .bg(copied ? t.done + "26" : t.raised).text_color(copied ? t.done : t.muted)
      .font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
      .cursor_pointer().tooltip(copied ? "Copied" : `Copy ${address}`).accessibility_label(`Copy address ${address}`)
      .hover((s) => s.text_color(t.foreground))
      .active((s) => s.bg(t.selected))
      .on_click((_e, cx) => {
        cx.write_to_clipboard(address);
        this.copied = address;
        cx.notify();
        cx.timer.after(1200, (cx) => {
          if (this.copied === address) this.copied = null;
          cx.notify();
        });
      })
      .when(copied, (el) => el.child(svg(`${ICONS}/check.svg`).size(10).flex_none()))
      .child(address);
  }

  render() {
    const t = theme();
    const space = spaces().find((s) => s.active);
    const f = focused();
    const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
    const branch = pane?.branch ?? space?.branch;
    const cwd = folder(f?.cwd ?? pane?.cwd);
    const blocked = agents().filter((a) => a.status === "blocked");
    const label = (icon, text) => h_flex().gap(6).items_center().min_w(0).child(svg(`${ICONS}/${icon}.svg`).size(13).flex_none()).child(div().truncate().child(text));
    return h_flex().size_full().px(14).gap(14).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(f?.terminal), (el) => el.child(this.address(t, f.terminal)))
      .when(Boolean(cwd), (el) => el.child(div().id("status-cwd").min_w(0).truncate().text_color(t.dim).tooltip(f?.cwd ?? cwd).child(cwd)))
      .when(Boolean(branch), (el) => el.child(label("branch", branch)))
      .child(div().flex_1())
      .when(blocked.length > 0, (el) => el.child(h_flex().id("status-needs").h(20).px(7).gap(5).items_center().rounded(5).flex_none()
        .bg(t.blocked + "1a").text_color(t.blocked).font_medium().cursor_pointer()
        .accessibility_label(`${blocked.length} need you. Go to the first`)
        .hover((s) => s.bg(t.blocked + "2a")).active((s) => s.bg(t.blocked + "33"))
        .on_click(() => run("agent.focus", { terminal: blocked[0].address }))
        .child(`${blocked.length} ${blocked.length === 1 ? "needs" : "need"} you`)))
      .child(div().id("palette").flex_none().text_color(t.dim).cursor_pointer().on_click(() => run("app.palette")).child(this.hint(t)));
  }
}
