// Quick send: pick an agent (the focused one by default), type, press Enter.
// Runs `hc send` only when you press Enter or Send. Recent messages are kept to reuse.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { agents, focused, hc, theme, settings } from "herdr";

const ICONS = "mods/studio-workspace-chrome";
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
const LONG = 500;

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}~/]+/u, "").trim();

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

function icon(p, size, color) {
  if (!p?.icon) return div().size(size).flex_none();
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).size(size).flex_none();
}

function nameOf(a) {
  const prog = a.program?.name;
  const live = clean(a.title);
  const telling = live && live !== prog && live.toLowerCase() !== a.program?.key && !/^[~/]/.test(live) && !live.includes("@");
  return telling ? live : prog || "Agent";
}

export default class Send extends View {
  init(_props, cx) {
    this.manual = null; // an address picked by hand; null follows the focused agent
    this.picking = false;
    this.sending = false;
    this.note = null;
    this.typing = false;
    this.length = 0;
    this.recent = load("recent", []);
    this.input = InputState.new({ placeholder: "Message to the agent…" });
    this.input.on("change", (_e, cx) => {
      const length = this.input.value().length;
      // Redraw only when the long-message hint or the Send button would change.
      if ((length > LONG) !== (this.length > LONG) || Boolean(length) !== Boolean(this.length)) {
        this.length = length;
        cx.notify();
      } else this.length = length;
    });
    this.input.on("submit", (_e, cx) => this.send(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
  }

  target(list) {
    const picked = this.manual && list.find((a) => a.address === this.manual);
    return picked ?? list.find((a) => a.address === focused()?.terminal) ?? null;
  }

  send(cx) {
    const text = this.input.value().trim();
    const target = this.target(agents());
    if (!text || !target || this.sending) return;
    const address = target.address;
    this.sending = true;
    this.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        // A blocked agent is waiting on a dialog: --force types into it, which is the point.
        const r = await hc(["send", address, text, ...(target.status === "blocked" ? ["--force"] : [])]);
        if (r.code === 0) {
          this.input.set_value("");
          this.length = 0;
          this.note = { ok: true, text: `Sent to ${address}` };
          this.recent = [text, ...this.recent.filter((m) => m !== text)].slice(0, 8);
          save("recent", this.recent);
        } else {
          this.note = { ok: false, text: (r.stderr || r.stdout || "Not sent").trim().split("\n")[0] };
        }
      } catch {
        this.note = { ok: false, text: "Not sent" };
      }
      this.sending = false;
      cx.notify();
    });
  }

  mark(t, status) {
    if (status === "working") return svg(`${ICONS}/spinner.svg`).size(12).flex_none().text_color(t.working).spin(900);
    if (status === "blocked") return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10).font_bold()
      .text_color(t.blocked).flex().items_center().justify_center().child("!");
    const box = h_flex().size(12).flex_none().items_center().justify_center();
    return status === "done"
      ? box.child(div().size(7).rounded(4).bg(t.done))
      : box.child(div().size(7).rounded(4).border(1.5).border_color(t.idle ?? t.dim));
  }

  address(t, address) {
    return div().flex_none().h(16).px(4).flex().items_center().rounded(4).bg(t.raised).text_color(t.dim)
      .font_family(settings().font_family ?? "JetBrains Mono").text_size(10.5).child(address);
  }

  render() {
    const t = theme();
    const list = agents();
    const target = this.target(list);
    const ready = Boolean(target) && this.length > 0 && !this.sending;
    const sorted = [...list].sort((x, y) => (RANK[y.status] ?? 0) - (RANK[x.status] ?? 0));
    const following = !this.manual || !list.some((a) => a.address === this.manual);
    return v_flex().size_full().min_w(0).min_h(0).bg(t.chrome).text_color(t.foreground).text_size(13)
      .child(h_flex().flex_none().h(41).px(14).pt(4).items_center()
        .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Send")))
      .child(v_flex().id("send-scroll").flex_1().min_h(0).px(10).pb(10).gap(10).overflow_y_scrollbar()
        .child(v_flex().gap(4)
          .child(div().px(2).text_size(11).text_color(t.dim).child(following ? "To · the focused agent" : "To"))
          .child(h_flex().id("send-target").h(34).px(9).gap(8).items_center().rounded(7).border(1)
            .border_color(this.picking ? t.accent : t.border).bg(t.surface).cursor_pointer()
            .accessibility_label(target ? `Sending to ${nameOf(target)}, ${target.address}. Change` : "Choose an agent")
            .hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected))
            .on_click((_e, cx) => {
              this.picking = !this.picking;
              cx.notify();
            })
            .when(Boolean(target), (el) => el
              .child(icon(target.program, 16, t.foreground))
              .child(div().id("send-target-name").flex_1().min_w(0).truncate().tooltip(nameOf(target)).child(nameOf(target)))
              .child(this.address(t, target.address)))
            .when(!target, (el) => el.child(div().flex_1().text_color(t.dim).child("Choose an agent")))
            .child(svg(`${ICONS}/chevron-${this.picking ? "down" : "right"}.svg`).size(11).flex_none().text_color(t.dim)))
          .when(this.picking, (el) => el.child(v_flex().id("send-picker").h(Math.min(220, 8 + Math.max(sorted.length, 1) * 31)).flex_none().p(4).gap(1).rounded(7).bg(t.popover)
            .border(1).border_color(t.border).overflow_y_scrollbar()
            .when(!sorted.length, (el) => el.child(div().p(6).text_color(t.dim).child("No agents yet")))
            .children(sorted.map((a) => h_flex().id(`pick-${a.address}`).h(30).px(7).gap(8).items_center().rounded(5).flex_none()
              .cursor_pointer().accessibility_label(`${nameOf(a)}, ${a.address}`)
              .when(target?.address === a.address, (el) => el.bg(t.selected))
              .hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected))
              .on_click((_e, cx) => {
                this.manual = a.address;
                this.picking = false;
                this.note = null;
                cx.notify();
              })
              .child(icon(a.program, 14, t.foreground))
              .child(div().flex_1().min_w(0).truncate().text_size(12.5).child(nameOf(a)))
              .child(this.address(t, a.address))
              .child(this.mark(t, a.status))))))
          .when(!following, (el) => el.child(div().id("send-follow").self_start().px(2).text_size(11).text_color(t.dim).cursor_pointer()
            .hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => {
              this.manual = null;
              cx.notify();
            })
            .child("Follow the focused agent"))))
        .child(v_flex().gap(6)
          .child(div().id("send-input").min_h(34).px(9).py(6).flex().items_center().rounded(7).border(1)
            .border_color(this.typing ? t.accent : t.border).cursor_text()
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .child(Input.new(this.input).w_full().text_size(12.5).text_color(t.foreground)))
          .when(this.length > LONG, (el) => el.child(div().px(2).text_size(11.5).text_color(t.blocked)
            .child("Long messages can be dropped by Codex. Put the brief in a file and send a short pointer.")))
          .child(h_flex().items_center().gap(8)
            .child(div().flex_1().min_w(0).truncate().px(2).text_size(11.5).text_color(this.note?.ok ? t.ansi2 : t.blocked)
              .child(this.note?.text ?? ""))
            .child(div().id("send-go").h(28).px(12).flex().items_center().flex_none().rounded(7).text_size(12.5).font_medium()
              .accessibility_label("Send")
              .bg(ready ? t.solid : t.raised).text_color(ready ? t.solid_foreground : t.dim)
              .when(ready, (el) => el.cursor_pointer().hover((s) => s.bg(t.solid)).active((s) => s.bg(t.selected).text_color(t.foreground)))
              .on_click((_e, cx) => this.send(cx))
              .child(this.sending ? "Sending…" : "Send"))))
        .when(this.recent.length > 0, (el) => el.child(v_flex().gap(2)
          .child(div().px(2).pb(2).text_size(11).text_color(t.dim).child("Recent"))
          .children(this.recent.map((m, i) => div().id(`recent-${i}`).px(7).py(5).rounded(6).text_size(12).text_color(t.muted)
            .cursor_pointer().truncate().tooltip(m).accessibility_label(`Reuse: ${m}`)
            .hover((s) => s.bg(t.hover).text_color(t.foreground)).active((s) => s.bg(t.selected))
            .on_click((_e, cx) => {
              this.input.set_value(m);
              this.length = m.length;
              this.input.focus();
              cx.notify();
            })
            .child(m))))));
  }
}
