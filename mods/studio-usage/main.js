// Usage: the numbers you glance at, not a report. How full each agent's context is, and how much
// of the 5-hour and weekly limits is used, for Claude and for Codex.
// They are read from the status lines the agents already draw on their own screens
// (`hc read`, read-only, one terminal at a time), so they match what you see there.
// Refreshes every minute while the window is in front.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, hc, theme, window, settings, layout } from "herdr";

const ICONS = "mods/studio-workspace-chrome";
const BARS = "[█▓▒░]";

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}~/]+/u, "").trim();
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

function ago(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

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

// One agent's screen to numbers. Claude's status line reads
//   Context ████░░░░░░ 42% │ Usage █░░░░░░░░░ 9% (resets in 3h 21m) | Weekly ██████████ 98% (resets in 4h 51m)
// and Codex's footer
//   … Context 11% used · 5h 23% left · weekly 82% left     (and "5h limit: 23% left · resets at 20:05")
// The last matching line wins: older ones are scrollback. Limits become "used" percentages.
function parse(text) {
  const lines = text.replace(ANSI, "").split("\n");
  const out = {};
  const claude = new RegExp(`Context\\s+${BARS}+\\s*(\\d+)%`);
  const usage = new RegExp(`Usage\\s+${BARS}+\\s*(\\d+)%(?:\\s*\\(resets in ([^)]+)\\))?`);
  const weekly = new RegExp(`Weekly\\s+${BARS}+\\s*(\\d+)%(?:\\s*\\(resets in ([^)]+)\\))?`);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    const c = l.match(claude);
    if (c) {
      out.kind = "claude";
      out.context = Number(c[1]);
      const u = l.match(usage), w = l.match(weekly);
      if (u) { out.five = Number(u[1]); out.fiveReset = u[2] ? `in ${u[2]}` : null; }
      if (w) { out.week = Number(w[1]); out.weekReset = w[2] ? `in ${w[2]}` : null; }
      return out;
    }
    const x = l.match(/Context (\d+)% used(?:\s*·\s*5h (\d+)% left)?(?:\s*·\s*weekly (\d+)% left)?/);
    if (x) {
      out.kind = "codex";
      out.context = Number(x[1]);
      if (x[2] != null) out.five = 100 - Number(x[2]);
      if (x[3] != null) out.week = 100 - Number(x[3]);
      // The warning line above the footer carries when the 5-hour window resets.
      for (const m of lines) {
        const r = m.match(/5h limit: (\d+)% left(?: · resets at ([0-9:]+))?/);
        if (r) { if (out.five == null) out.five = 100 - Number(r[1]); if (r[2]) out.fiveReset = `at ${r[2]}`; }
      }
      return out;
    }
  }
  return null;
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

export default class Usage extends View {
  init(_props, cx) {
    this.data = load("limits", null); // last good reading, shown at once on open
    this.loading = false;
    this.last = 0;
    // Reads once a minute, but only while this pane is the one shown (and at once when it opens).
    cx.timer.every(3000, (cx) => {
      if (!shown("usage")) return;
      if (window()?.active && Date.now() - this.last > 60000) this.refresh(cx);
      else cx.notify();
    });
  }

  // Reads a few terminals at a time: every `hc read` is a process of its own.
  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    this.last = Date.now();
    cx.notify();
    const list = agents().map((a) => ({ address: a.address, title: clean(a.title) || a.program?.name || "Agent", icon: a.program, status: a.status, seq: a.seq }));
    cx.spawn(async (cx) => {
      const seen = [];
      const queue = [...list];
      const worker = async () => {
        for (let a = queue.shift(); a; a = queue.shift()) {
          try {
            const r = await hc(["read", a.address]);
            const got = r.code === 0 ? parse(r.stdout) : null;
            if (got) seen.push({ ...a, ...got });
          } catch {}
        }
      };
      await Promise.all(Array.from({ length: 4 }, worker));
      // The account's limits are the same in every session of one agent: take the freshest reading.
      const freshest = (kind, key) => seen.filter((s) => s.kind === kind && s[key] != null).sort((a, b) => b.seq - a.seq)[0] ?? null;
      const account = (kind) => {
        const five = freshest(kind, "five"), week = freshest(kind, "week");
        return { five: five?.five ?? null, fiveReset: five?.fiveReset ?? null, week: week?.week ?? null, weekReset: week?.weekReset ?? null };
      };
      if (seen.length || !this.data) {
        this.data = {
          at: Date.now(),
          claude: account("claude"),
          codex: account("codex"),
          contexts: seen.map((s) => ({ address: s.address, title: s.title, kind: s.kind, context: s.context, icon: s.icon, status: s.status })),
        };
        save("limits", this.data);
      }
      this.loading = false;
      cx.notify();
    });
  }

  // Green to amber to red as it fills.
  tone(t, pct) {
    return pct >= 90 ? t.blocked : pct >= 70 ? t.ansi3 : t.ansi2;
  }

  iconButton(t, id, path, text, action) {
    return div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim)
      .tooltip(text).accessibility_label(text)
      .when(!this.loading, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).active((s) => s.bg(t.selected))
        .on_click((_e, cx) => action(cx)))
      .child(this.loading ? svg(`${ICONS}/spinner.svg`).size(13).text_color(t.muted).spin(900) : svg(path).size(13));
  }

  // One limit: what is used, how full that is, and when it resets.
  meter(t, name, pct, reset) {
    if (pct == null) {
      return v_flex().gap(6).child(h_flex().items_baseline().child(div().flex_1().text_size(12).text_color(t.muted).child(name)).child(div().text_size(12).text_color(t.dim).child("not shown")));
    }
    const color = this.tone(t, pct);
    return v_flex().gap(6)
      .child(h_flex().items_baseline().gap(8)
        .child(div().flex_1().text_size(12).text_color(t.muted).child(name))
        .child(div().text_size(18).font_semibold().text_color(pct >= 70 ? color : t.foreground).child(`${pct}%`))
        .child(div().text_size(11).text_color(t.dim).child("used")))
      .child(h_flex().h(5).rounded(3).overflow_hidden().bg(t.raised).child(div().h_full().w(`${Math.min(100, pct)}%`).bg(color)))
      .when(Boolean(reset), (el) => el.child(div().text_size(11).text_color(t.dim).child(`Resets ${reset}`)));
  }

  account(t, name, accent, data) {
    const none = data.five == null && data.week == null;
    return v_flex().flex_none().p(14).gap(14).rounded(10).border(1).border_color(t.border).bg(t.chrome)
      .child(h_flex().items_center().gap(8)
        .child(div().size(8).rounded(2).bg(accent))
        .child(div().text_size(13).font_semibold().child(name)))
      .when(none, (el) => el.child(div().text_size(12).text_color(t.dim).whitespace_normal().child(`No ${name} session is showing its limits right now.`)))
      .when(!none, (el) => el.child(this.meter(t, "5 hours", data.five, data.fiveReset)).child(this.meter(t, "Weekly", data.week, data.weekReset)));
  }

  render() {
    const t = theme();
    const now = Date.now();
    const d = this.data;
    const mono = settings().font_family ?? "JetBrains Mono";
    const contexts = [...(d?.contexts ?? [])].sort((a, b) => b.context - a.context);
    return v_flex().size_full().min_w(0).min_h(0).bg(t.chrome).text_color(t.foreground).text_size(13)
      .child(h_flex().flex_none().px(14).pt(14).pb(10).items_center().gap(8)
        .child(div().text_size(13).font_semibold().child("Usage"))
        .child(div().flex_1())
        .when(Boolean(d?.at), (el) => el.child(div().text_size(11).text_color(t.dim).child(ago(now - d.at))))
        .child(this.iconButton(t, "usage-refresh", "mods/studio-usage/refresh.svg", "Refresh", (cx) => this.refresh(cx))))
      .child(v_flex().id("usage-scroll").flex_1().min_h(0).px(12).pb(14).gap(10).overflow_y_scrollbar()
        .when(!d, (el) => el.child(div().px(4).py(8).text_color(t.dim).child("Reading the agents' status lines…")))
        .when(Boolean(d), (el) => el.child(this.account(t, "Claude", t.ansi3, d.claude)))
        .when(Boolean(d), (el) => el.child(this.account(t, "Codex", t.ansi4, d.codex)))
        .when(Boolean(d) && contexts.length > 0, (el) => el.child(v_flex().flex_none().p(14).gap(12).rounded(10).border(1).border_color(t.border).bg(t.chrome)
          .child(h_flex().items_center().gap(8)
            .child(div().flex_1().text_size(13).font_semibold().child("Context"))
            .child(div().text_size(11).text_color(t.dim).child("how full each session is")))
          .children(contexts.map((c) => v_flex().id(`ctx-${c.address}`).gap(5)
            .child(h_flex().gap(8).items_center()
              .child(c.icon?.icon ? (c.icon.tint ? svg(c.icon.icon).size(14).flex_none().text_color(t.foreground) : image(c.icon.icon).size(14).flex_none()) : div().size(14).flex_none())
              .child(div().id(`ctx-title-${c.address}`).flex_1().min_w(0).truncate().text_size(12.5).tooltip(c.title).child(c.title))
              .child(div().flex_none().h(16).px(4).flex().items_center().rounded(4).bg(t.raised).text_color(t.dim).font_family(mono).text_size(10.5).child(c.address))
              .child(div().flex_none().w(34).text_right().text_size(12).font_medium().text_color(c.context >= 70 ? this.tone(t, c.context) : t.muted).child(`${c.context}%`)))
            .child(h_flex().h(4).rounded(2).overflow_hidden().bg(t.raised).child(div().h_full().w(`${Math.min(100, c.context)}%`).bg(this.tone(t, c.context))))))))
        .when(Boolean(d) && contexts.length === 0, (el) => el.child(div().px(4).py(6).text_size(12).text_color(t.dim).whitespace_normal()
          .child("No agent is showing a context meter. Run Claude with its status line, or Codex, in a terminal.")))
        .when(Boolean(d), (el) => el.child(div().px(4).pt(2).text_size(11).text_color(t.dim).whitespace_normal()
          .child("Read from the agents' own status lines, once a minute."))));
  }
}
