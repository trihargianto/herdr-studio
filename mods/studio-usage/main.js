// Monitoring: the numbers you glance at, not a report. How full each agent's context is, and how much
// of the 5-hour and weekly limits is used, for Claude and for Codex.
// They are read from the status lines the agents already draw on their own screens
// (`hc read`, read-only, one terminal at a time), so they match what you see there.
// Refreshes every minute while the window is in front. CPU and memory per space and pane
// come from one `ps` every few seconds (a pane's shell and everything it started).

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, hc, exec, home, panes, spaces, theme, window, settings, layout } from "herdr";

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

function resetIn(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// Sky blue and orange stay apart for every common kind of colour blindness (the Okabe-Ito pair).
const CPU_COLOR = "#56B4E9", MEM_COLOR = "#E69F00";

const CTX_ROW = 30, CTX_GAP = 12, CTX_SHOWN = 3; // Context rows are short: three fit the scroll view
const CARD = 86, GAP = 8; // a card's fixed height; two of them fill a section's scroll view

const mem = (kb) => (kb >= 1048576 ? `${(kb / 1048576).toFixed(1)} GB` : kb >= 1024 ? `${Math.round(kb / 1024)} MB` : `${kb} KB`);
const cpu = (v) => `${v >= 100 ? Math.round(v) : v.toFixed(1)}%`;

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

// "in 3h 21m", "in 4d 2h" or "at 20:05" to a moment in time, so a saved reading can keep counting down.
function resetMoment(text, now) {
  if (!text) return null;
  const at = text.match(/^at (\d{1,2}):(\d{2})$/);
  if (at) {
    const d = new Date(now);
    d.setHours(Number(at[1]), Number(at[2]), 0, 0);
    return d.getTime() <= now ? d.getTime() + 86400000 : d.getTime();
  }
  const get = (u) => Number(text.match(new RegExp(`(\\d+)\\s*${u}`))?.[1] ?? 0);
  const ms = ((get("d") * 24 + get("h")) * 60 + get("m")) * 60000;
  return ms ? now + ms : null;
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
    // Each agent's account limits, kept after its sessions close: { five|week: { pct, resetAt, readAt } }.
    this.acct = load("account-limits", {});
    this.loading = false;
    this.last = 0;
    this.mon = null; // { at, spaces: [...], panes: [...] }
    this.monBusy = false;
    this.pids = new Map(); // terminal address -> its shell's pid
    this.folded = load("monitor-folded", {}); // section title -> true when folded
    this.heights = load("monitor-heights", {}); // section title -> the height the person dragged it to
    this.drag = null; // { title, y, h } while a list's bottom edge is held
    this.sys = null; // { cores, ramKb }, read once
    // Reads once a minute, but only while this pane is the one shown (and at once when it opens).
    cx.timer.every(3000, (cx) => {
      if (!shown("usage")) return;
      this.monitor(cx);
      if (window()?.active && Date.now() - this.last > 60000) this.refresh(cx);
      else cx.notify();
    });
  }

  // CPU and memory per pane (its shell plus every process under it), then per space.
  monitor(cx) {
    if (this.monBusy) return;
    this.monBusy = true;
    const tabInfo = new Map();
    const local = [];
    for (const sp of spaces()) {
      if (sp.machine) continue;
      local.push(sp);
      for (const t of sp.tabs) tabInfo.set(t.id, { space: sp, tab: t });
    }
    const terms = panes().filter((p) => p.terminal && tabInfo.has(p.tab));
    cx.spawn(async (cx) => {
      try {
        for (const p of terms) {
          if (this.pids.has(p.terminal)) continue;
          const r = await hc(["get", p.terminal, "--json"]);
          const pid = r.code === 0 ? JSON.parse(r.stdout).pid : null;
          if (pid) this.pids.set(p.terminal, pid);
        }
        if (!this.sys) {
          const r = await exec("sysctl", ["-n", "hw.ncpu", "hw.memsize"], { cwd: home(), timeout: 5000 });
          const [cores, bytes] = r.stdout.trim().split(/\s+/).map(Number);
          if (cores && bytes) this.sys = { cores, ramKb: bytes / 1024 };
        }
        const out = await exec("ps", ["-axo", "pid=,ppid=,pcpu=,rss="], { cwd: home(), timeout: 15000 });
        // The whole computer, as Activity Monitor counts "Memory Used": app (anonymous) + wired + compressed.
        let sysMemKb = null;
        try {
          const vm = (await exec("vm_stat", [], { cwd: home(), timeout: 5000 })).stdout;
          const page = Number(vm.match(/page size of (\d+)/)?.[1]);
          const pages = (k) => Number(vm.match(new RegExp(`${k}:\\s+(\\d+)`))?.[1]);
          const n = pages("Anonymous pages") + pages("Pages wired down") + pages("Pages occupied by compressor");
          if (page && n) sysMemKb = (n * page) / 1024;
        } catch {}
        const proc = new Map();
        const kids = new Map();
        for (const line of out.stdout.split("\n")) {
          const [pid, ppid, c, rss] = line.trim().split(/\s+/).map(Number);
          if (!pid) continue;
          proc.set(pid, { c, rss });
          if (!kids.has(ppid)) kids.set(ppid, []);
          kids.get(ppid).push(pid);
        }
        const total = (root) => {
          let c = 0, rss = 0;
          const stack = [root];
          const seen = new Set();
          while (stack.length) {
            const id = stack.pop();
            if (seen.has(id)) continue;
            seen.add(id);
            const x = proc.get(id);
            if (x) { c += x.c; rss += x.rss; }
            stack.push(...(kids.get(id) ?? []));
          }
          return { cpu: c, mem: rss };
        };
        const rows = terms.map((p) => {
          const { space, tab } = tabInfo.get(p.tab);
          const u = this.pids.has(p.terminal) ? total(this.pids.get(p.terminal)) : { cpu: 0, mem: 0 };
          return { id: p.terminal, name: clean(p.title) || p.program?.name || "Terminal", sub: `${space.name} · ${tab.named ? tab.name : `Tab ${tab.index}`}`, icon: p.program, space: space.id, ...u };
        });
        const bySpace = local.map((sp) => ({
          id: sp.id, name: sp.name, sub: `${rows.filter((r) => r.space === sp.id).length === 1 ? "1 pane" : `${rows.filter((r) => r.space === sp.id).length} panes`}`,
          cpu: rows.filter((r) => r.space === sp.id).reduce((a, r) => a + r.cpu, 0),
          mem: rows.filter((r) => r.space === sp.id).reduce((a, r) => a + r.mem, 0),
        }));
        this.mon = {
          at: Date.now(), spaces: bySpace, panes: rows,
          cpu: rows.reduce((a, r) => a + r.cpu, 0), mem: rows.reduce((a, r) => a + r.mem, 0),
          sysCpu: [...proc.values()].reduce((a, x) => a + x.c, 0), sysMem: sysMemKb,
        };
      } catch {}
      this.monBusy = false;
      cx.notify();
    });
  }

  // Reads a few terminals at a time: every `hc read` is a process of its own.
  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    this.last = Date.now();
    cx.notify();
    const list = agents().map((a) => ({ address: a.address, program: a.program?.key ?? a.program?.name, title: clean(a.title) || a.program?.name || "Agent", icon: a.program, status: a.status, seq: a.seq }));
    cx.spawn(async (cx) => {
      const seen = [];
      const queue = [...list];
      const worker = async () => {
        for (let a = queue.shift(); a; a = queue.shift()) {
          try {
            const r = await hc(["read", a.address]);
            const got = r.code === 0 ? parse(r.stdout) : null;
            // Antigravity's custom statusline prints Claude's shape (Context and Weekly bars, no 5-hour
            // limit), so the agent's own name tells them apart.
            const agy = /antigravity|^agy$/i.test(`${a.icon?.key ?? ""} ${a.program ?? ""}`);
            if (got) seen.push({ ...a, ...got, kind: agy ? "antigravity" : got.kind, five: agy ? null : got.five, fiveReset: agy ? null : got.fiveReset });
          } catch {}
        }
      };
      await Promise.all(Array.from({ length: 4 }, worker));
      // The account's limits are the same in every session of one agent: take the freshest reading.
      const freshest = (kind, key) => seen.filter((s) => s.kind === kind && s[key] != null).sort((a, b) => b.seq - a.seq)[0] ?? null;
      // A window with no fresh reading keeps its last one. Its reset moment is saved, not "in 3h".
      const now = Date.now();
      const account = (kind) => {
        const prev = this.acct[kind] ?? {};
        const out = { ...prev };
        for (const [key, resetKey] of [["five", "fiveReset"], ["week", "weekReset"]]) {
          const r = freshest(kind, key);
          if (r) out[key] = { pct: r[key], resetAt: resetMoment(r[resetKey], now) ?? (prev[key]?.resetAt > now ? prev[key].resetAt : null), readAt: now };
        }
        return out;
      };
      this.acct = { claude: account("claude"), codex: account("codex"), antigravity: account("antigravity") };
      save("account-limits", this.acct);
      if (seen.length || !this.data) {
        this.data = {
          at: Date.now(),
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

  // One limit: what is used, how full that is, and when it resets. A reading whose window has
  // reset since is no longer true, so it says so instead of showing the old number.
  meter(t, name, w, now) {
    if (!w) {
      return v_flex().gap(6).child(h_flex().items_baseline().child(div().flex_1().text_size(12).text_color(t.muted).child(name)).child(div().text_size(12).text_color(t.dim).child("not shown")));
    }
    const over = w.resetAt != null && w.resetAt <= now;
    if (over) {
      return v_flex().gap(6).child(h_flex().items_baseline().gap(8)
        .child(div().flex_1().text_size(12).text_color(t.muted).child(name))
        .child(div().text_size(12).text_color(t.dim).child("Reset since the last reading")));
    }
    const pct = w.pct;
    const color = this.tone(t, pct);
    return v_flex().gap(6)
      .child(h_flex().items_baseline().gap(8)
        .child(div().flex_1().text_size(12).text_color(t.muted).child(name))
        .child(div().text_size(18).font_semibold().text_color(pct >= 70 ? color : t.foreground).child(`${pct}%`))
        .child(div().text_size(11).text_color(t.dim).child("used")))
      .child(h_flex().h(5).rounded(3).overflow_hidden().bg(t.raised).child(div().h_full().w(`${Math.min(100, pct)}%`).bg(color)))
      .when(w.resetAt != null, (el) => el.child(div().text_size(11).text_color(t.dim).child(`Resets in ${resetIn(w.resetAt - now)}`)));
  }

  account(t, name, accent, data, now, weeklyOnly = false) {
    const wins = weeklyOnly ? [data?.week] : [data?.five, data?.week];
    const none = wins.every((w) => !w);
    const newest = Math.max(0, ...wins.map((w) => w?.readAt ?? 0));
    const old = newest > 0 && now - newest > 120000;
    return v_flex().flex_none().p(14).gap(14).rounded(10).border(1).border_color(t.border).bg(t.chrome)
      .child(h_flex().items_center().gap(8)
        .child(div().size(8).rounded(2).bg(accent))
        .child(div().flex_1().text_size(13).font_semibold().child(name))
        .when(old, (el) => el.child(div().text_size(11).text_color(t.dim).child(`as of ${ago(now - newest)} ago`))))
      .when(none, (el) => el.child(div().text_size(12).text_color(t.dim).whitespace_normal().child(`No ${name} session has shown its limits yet.`)))
      .when(!none, (el) => el.when(!weeklyOnly, (m) => m.child(this.meter(t, "5 hours", data.five, now))).child(this.meter(t, "Weekly", data.week, now)));
  }

  // A section title that folds its list on click; the choice is remembered per title.
  foldHeader(t, title, count) {
    const folded = Boolean(this.folded[title]);
    return h_flex().id(`mon-fold-${title}`).px(4).h(24).items_center().gap(6).rounded(5).cursor_pointer()
      .hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected))
      .accessibility_label(`${title}, ${count}, ${folded ? "folded" : "expanded"}`)
      .on_click((_e, cx) => {
        this.folded = { ...this.folded, [title]: !folded };
        save("monitor-folded", this.folded);
        cx.notify();
      })
      .child(div().w(12).flex_none().text_size(10).text_color(t.dim).child(folded ? "▸" : "▾"))
      .child(div().text_size(11).font_semibold().text_color(t.muted).child(title))
      .child(div().text_size(11).text_color(t.dim).child(String(count)));
  }

  // A metric's half of a row: its name and value, then a bar scaled to the biggest in the list.
  metric(t, label, color, value, frac) {
    const mono = settings().font_family ?? "JetBrains Mono";
    return v_flex().flex_1().min_w(0).gap(5)
      .child(h_flex().items_baseline().gap(6)
        .child(div().text_size(10).font_semibold().text_color(t.dim).child(label))
        .child(div().flex_1())
        .child(div().font_family(mono).text_size(12).font_medium().text_color(t.foreground).child(value)))
      .child(h_flex().h(4).rounded(2).overflow_hidden().bg(t.chrome)
        .child(div().h_full().rounded(2).w(`${Math.max(2, Math.round(frac * 100))}%`).bg(color)));
  }

  // The bottom edge of a list: drag it to make the list taller or shorter, with no upper limit.
  // The move and release are read on the whole scroll view (see render), so a fast drag cannot slip off.
  resizeHandle(t, title, height) {
    const held = this.drag?.title === title;
    return h_flex().id(`mon-resize-${title}`).flex_none().h(12).items_center().justify_center().cursor_row_resize()
      .tooltip("Drag to resize").accessibility_label(`Resize ${title} list`)
      .on_mouse_down("left", (e, cx) => { this.drag = { title, y: e.position.y, h: height }; cx.notify(); })
      .child(div().w(36).h(3).rounded(2).bg(held ? t.muted : t.border));
  }

  // One list, busiest first. "Load" adds a row's share of all CPU in use to its share of all memory in
  // use, so a pane that is busy and one that is big both rise, with no switch to flip.
  usageList(t, title, items) {
    const sum = (k) => Math.max(1e-9, items.reduce((a, r) => a + r[k], 0));
    const cpuAll = sum("cpu"), memAll = sum("mem");
    const load = (r) => r.cpu / cpuAll + r.mem / memAll;
    const sorted = [...items].sort((a, b) => load(b) - load(a) || a.name.localeCompare(b.name));
    const topCpu = Math.max(1, ...items.map((r) => r.cpu)), topMem = Math.max(1, ...items.map((r) => r.mem));
    const folded = Boolean(this.folded[title]);
    const n = sorted.length;
    const height = this.heights[title] ?? (n > 2 ? CARD * 2 + GAP : n * CARD + Math.max(0, n - 1) * GAP);
    return v_flex().flex_none().gap(6)
      .child(this.foldHeader(t, title, items.length))
      .when(!folded, (el) => el.child(v_flex().id(`mon-list-${title}`).gap(GAP).min_h(0)
        .h(height).overflow_y_scrollbar()
        .children(sorted.map((r) => v_flex().id(`mon-${title}-${r.id}`).flex_none().h(CARD).gap(10).px(12).py(11).rounded(10).bg(t.raised)
        .child(h_flex().gap(8).items_center()
          .when(Boolean(r.icon?.icon), (el) => el.child(r.icon.tint ? svg(r.icon.icon).size(14).flex_none().text_color(t.foreground) : image(r.icon.icon).size(14).flex_none()))
          .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_medium().tooltip(`${r.name}\n${r.sub}`).child(r.name))
          .child(div().flex_none().max_w(110).truncate().text_size(11).text_color(t.dim).child(r.sub)))
        .child(h_flex().gap(14)
          .child(this.metric(t, "CPU", CPU_COLOR, cpu(r.cpu), r.cpu / topCpu))
          .child(this.metric(t, "MEM", MEM_COLOR, mem(r.mem), r.mem / topMem))))))
        .child(this.resizeHandle(t, title, height)));
  }

  // The totals: the whole computer, with the share Herdr's panes take marked inside the bar.
  tile(t, label, color, value, of, frac, mine, mineFrac) {
    const mono = settings().font_family ?? "JetBrains Mono";
    const pct = (f) => `${Math.max(1, Math.min(100, Math.round(f * 100)))}%`;
    return v_flex().flex_1().min_w(0).gap(6).p(12).rounded(10).bg(t.raised)
      .child(h_flex().items_center().gap(6)
        .child(div().size(7).rounded(2).bg(color))
        .child(div().text_size(10).font_semibold().text_color(t.dim).child(label)))
      .child(div().font_family(mono).text_size(22).font_semibold().text_color(t.foreground).child(value))
      .child(div().text_size(11).text_color(t.dim).truncate().child(of))
      // The computer's use is the paler fill; Herdr's panes are the solid part of it.
      .child(h_flex().h(6).rounded(3).overflow_hidden().bg(t.chrome)
        .child(div().h_full().w(pct(Math.max(frac, mineFrac))).bg(t.dim)
          .child(div().h_full().w(`${Math.min(100, Math.round((mineFrac / Math.max(frac, mineFrac, 1e-9)) * 100))}%`).bg(color))))
      .child(div().text_size(11).text_color(t.muted).truncate().child(`Herdr panes · ${mine}`));
  }

  monitorCard(t) {
    const m = this.mon;
    if (!m) return div().px(4).py(8).text_size(12).text_color(t.dim).child("Reading processes…");
    const sys = this.sys;
    const cap = sys ? sys.cores * 100 : 100;
    const cpuAll = Math.min(1, m.sysCpu / cap), cpuMine = Math.min(1, m.cpu / cap);
    const ram = sys?.ramKb ?? 0;
    const memAll = ram && m.sysMem ? Math.min(1, m.sysMem / ram) : 0, memMine = ram ? Math.min(1, m.mem / ram) : 0;
    const pct1 = (f) => (f >= 0.1 ? `${Math.round(f * 100)}%` : `${(f * 100).toFixed(1)}%`);
    return v_flex().flex_none().gap(14)
      .child(h_flex().gap(8)
        .child(this.tile(t, "CPU · WHOLE MAC", CPU_COLOR, pct1(cpuAll), sys ? `${sys.cores} cores` : "", cpuAll, pct1(cpuMine), cpuMine))
        .child(this.tile(t, "MEMORY · WHOLE MAC", MEM_COLOR, m.sysMem ? mem(m.sysMem) : "n/a", ram ? `${Math.round(memAll * 100)}% of ${mem(ram)}` : "", memAll, mem(m.mem), memMine)))
      .child(this.usageList(t, "Spaces", m.spaces))
      .child(this.usageList(t, "Panes", m.panes))
      .child(div().px(4).text_size(11).text_color(t.dim).whitespace_normal()
        .child("Tiles show the whole Mac, like Activity Monitor. Cards below are Herdr's panes only, busiest first: a pane counts its shell and everything it started. CPU on cards is 100% per busy core."));
  }

  render() {
    const t = theme();
    const now = Date.now();
    const d = this.data;
    const mono = settings().font_family ?? "JetBrains Mono";
    const contexts = [...(d?.contexts ?? [])].sort((a, b) => b.context - a.context);
    return v_flex().size_full().min_w(0).min_h(0).bg(t.chrome).text_color(t.foreground).text_size(13)
      .child(h_flex().flex_none().px(14).pt(14).pb(10).items_center().gap(8)
        .child(div().text_size(13).font_semibold().child("Monitoring"))
        .child(div().flex_1())
        .when(Boolean(d?.at), (el) => el.child(div().text_size(11).text_color(t.dim).child(ago(now - d.at))))
        .child(this.iconButton(t, "usage-refresh", "mods/studio-usage/refresh.svg", "Refresh", (cx) => { this.refresh(cx); this.monitor(cx); })))
      .child(v_flex().id("usage-scroll").flex_1().min_h(0).px(12).pb(14).gap(10).overflow_y_scrollbar()
        .on_mouse_move((e, cx) => {
          if (!this.drag) return;
          this.heights = { ...this.heights, [this.drag.title]: Math.max(CARD, Math.round(this.drag.h + e.position.y - this.drag.y)) };
          cx.notify();
        })
        .on_mouse_up("left", (_e, cx) => {
          if (!this.drag) return;
          this.drag = null;
          save("monitor-heights", this.heights);
          cx.notify();
        })
        .child(this.monitorCard(t))
        .when(!d, (el) => el.child(div().px(4).py(8).text_color(t.dim).child("Reading the agents' status lines…")))
        .child(this.account(t, "Claude", t.ansi3, this.acct.claude, now))
        .child(this.account(t, "Codex", t.ansi4, this.acct.codex, now))
        .child(this.account(t, "Antigravity", t.ansi5, this.acct.antigravity, now, true))
        .when(Boolean(d) && contexts.length > 0, (el) => el.child(v_flex().flex_none().gap(6)
          .child(this.foldHeader(t, "Context", contexts.length))
          .when(!this.folded.Context, (sec) => sec.child(v_flex().id("ctx-list").p(12).rounded(10).bg(t.raised).min_h(0)
            .when(contexts.length > CTX_SHOWN, (l) => l.h(CTX_ROW * CTX_SHOWN + CTX_GAP * (CTX_SHOWN - 1) + 24))
            .child(v_flex().id("ctx-scroll").gap(CTX_GAP).flex_1().min_h(0)
              .when(contexts.length > CTX_SHOWN, (l) => l.overflow_y_scrollbar())
              .children(contexts.map((c) => v_flex().id(`ctx-${c.address}`).flex_none().h(CTX_ROW).gap(5)
                .child(h_flex().gap(8).items_center()
                  .child(c.icon?.icon ? (c.icon.tint ? svg(c.icon.icon).size(14).flex_none().text_color(t.foreground) : image(c.icon.icon).size(14).flex_none()) : div().size(14).flex_none())
                  .child(div().id(`ctx-title-${c.address}`).flex_1().min_w(0).truncate().text_size(12.5).tooltip(c.title).child(c.title))
                  .child(div().flex_none().h(16).px(4).flex().items_center().rounded(4).bg(t.chrome).text_color(t.dim).font_family(mono).text_size(10.5).child(c.address))
                  .child(div().flex_none().w(34).text_right().text_size(12).font_medium().text_color(c.context >= 70 ? this.tone(t, c.context) : t.muted).child(`${c.context}%`)))
                .child(h_flex().h(4).rounded(2).overflow_hidden().bg(t.chrome).child(div().h_full().w(`${Math.min(100, c.context)}%`).bg(this.tone(t, c.context)))))))))))
        .when(Boolean(d) && contexts.length === 0, (el) => el.child(div().px(4).py(6).text_size(12).text_color(t.dim).whitespace_normal()
          .child("No agent is showing a context meter. Run Claude with its status line, or Codex, in a terminal.")))
        .when(Boolean(d), (el) => el.child(div().px(4).pt(2).text_size(11).text_color(t.dim).whitespace_normal()
          .child("Read from the agents' own status lines, once a minute."))));
  }
}
