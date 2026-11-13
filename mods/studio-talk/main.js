// Agent talk: who messages whom, drawn in the Agenttrail Map's look (its tokens, type, cards and
// connectors).
// Agents that talked are cards joined by curved connectors, an arrowhead at the receiver; a new
// message flies along its connector as a dot, and the line runs dashed in amber for a few seconds.
// Herdr has no "message sent" event, so this reads what the agents already show (`hc read`, read-only):
// a received message is pasted as <hc from="t64">…</hc>, a sent one is a `hc send t7m "…"` command.
// Both sides are matched up, so one message counts once. Agents started by another (`hc run`) get a
// dotted line from their parent.

import { View, div, svg, PathBuilder } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, hc, exec, home, layout, run, settings, window as win } from "herdr";

const ASSET = "mods/studio-talk";
const FLY_MS = 760; // sender to receiver, along the curve
const STEPS = 8; // waypoints the dot moves through, so it follows the curve instead of cutting across
const RING_MS = 650; // the receiver's ring fading out
const HOT_MS = 8000; // how long a connector stays lit after a message
const SHOWN_EVERY = 2500, HIDDEN_EVERY = 4; // read every 2.5 s while shown, every 4th tick while hidden
const NODE_H = 74;
const DOT = 24; // the Map's background dots: fixed to the screen
const KEEP = 200;
const STORE = "studio-talk";
const SANS = "Geist", MONO = "Geist Mono";

// The Map's tokens (agenttrail's public/index.html :root), so this view and the Map are one product.
const DARK = { bg: "#000000", surface: "#181818", raised: "#1f1f1f", hover: "#272727", line: "#313131", text: "#ffffff", soft: "#d1d1d1", dim: "#9b9b9b", faint: "#686868", accent: "#e9a23b", danger: "#db6b67", success: "#7aa36a", done: "#3f7f57", card: "#181818", cardLive: "#2f271c", cardHover: "#1f1f1f", overlay: "#181818", dot: "#31313159", openai: "#e8e8ea" };
const LIGHT = { ...DARK, bg: "#ffffff", surface: "#f9f8f7", raised: "#f3f2f0", hover: "#eeecea", line: "#00000024", text: "#000000", soft: "#000000c7", dim: "#666666", faint: "#0000007a", accent: "#955f12", success: "#3f7f57", card: "#ffffff", cardLive: "#fdf5e9", cardHover: "#f9f8f7", overlay: "#ffffff", dot: "#00000018", openai: "#111111" };
const lit = () => settings()?.dark === false;
const MARK = { claude: "claude", "claude-code": "claude", codex: "codex", chatgpt: "codex", openai: "codex" };
const markOf = (app) => (app ? MARK[String(app).toLowerCase()] ?? null : null);
const markColor = (c, key) => (key === "claude" ? "#d97757" : key === "codex" ? c.openai : c.dim);
const WORD = { working: "Working", blocked: "Needs you", done: "Done", idle: "Idle" };
const tone = (c, status) => ({ working: c.accent, blocked: c.danger, done: c.success })[status] ?? c.dim;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}~/]+/u, "").trim();
const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "").slice(0, 28);
const flat = (s) => s.replace(/\s*\n\s*/g, " ").trim();
const ADDR = /^(?:[\w-]+\/)?t[0-9a-z]+$/;
// A pasted message starts its own line, after the prompt mark at most; quoted output ("10:❯ <hc") does not.
const RECV = /(?:^|\n)[ \t]*(?:[❯›>»$%#][ \t]*)?<hc\b([^>]*)>/g;
// A send is a command: at a line start, in a tool call (Bash(…), Ran …, $ …) or after && or ;.
const SEND = /(?:Bash\(|Ran |\$ |&& |; |(?:^|\n)[ \t]*)hc[ \t]+send[ \t]+(?:--?[\w-]+[ \t]+)*([^\s"'`]+)[ \t]+(["'])/g;

function ago(at) {
  if (at == null) return "earlier";
  const s = Math.floor((Date.now() - at) / 1000);
  if (s < 10) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`;
}

// A pane in the side panel does its work while it is the one shown.
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
const watching = () => shown("talk");

// A point on a connector: the cubic from p0 to p1 through c1 and c2.
function bez(l, t) {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t;
  return { x: a * l.p0.x + b * l.c1.x + d * l.c2.x + e * l.p1.x, y: a * l.p0.y + b * l.c1.y + d * l.c2.y + e * l.p1.y };
}

export default class AgentTalk extends View {
  init(_props, cx) {
    this.size = null;
    this.events = []; // newest first: { id, from, to, body, at, sides, keys }
    this.keys = new Set(); // every message already counted, so a screen read again adds nothing
    this.read = new Map(); // address → the agent's seq when last read
    this.flights = []; // dots on their way
    this.rings = []; // receivers just reached
    this.queue = [];
    this.next = 1;
    this.tick = 0;
    this.scanning = false;
    this.mem = new Map(); // address → KB, the agent and everything it started
    this.pids = new Map(); // address → its shell's pid
    this.measuring = false;
    this.restore();
    this.scan(cx);
    this.measure(cx);
    cx.timer.every(SHOWN_EVERY, (cx) => {
      const live = watching();
      this.tick += 1;
      if (live || this.tick % HIDDEN_EVERY === 0) this.scan(cx);
      if (live && this.tick % 2 === 0) this.measure(cx); // memory every 5 s, only while shown
    });
  }

  // Memory as Monitoring counts it: one `ps`, then each terminal's process and everything under it.
  measure(cx) {
    if (this.measuring) return;
    this.measuring = true;
    cx.spawn(async (cx) => {
      try {
        const out = await exec("ps", ["-axo", "pid=,ppid=,rss="], { cwd: home(), timeout: 15000 });
        const rss = new Map(), kids = new Map();
        for (const line of out.stdout.split("\n")) {
          const [pid, ppid, kb] = line.trim().split(/\s+/).map(Number);
          if (!pid) continue;
          rss.set(pid, kb || 0);
          if (!kids.has(ppid)) kids.set(ppid, []);
          kids.get(ppid).push(pid);
        }
        const total = (root) => {
          let kb = 0;
          const stack = [root], seen = new Set();
          while (stack.length) {
            const id = stack.pop();
            if (seen.has(id)) continue;
            seen.add(id);
            kb += rss.get(id) ?? 0;
            stack.push(...(kids.get(id) ?? []));
          }
          return kb;
        };
        // Only the agents on the graph. `terminals()` has no pid, so each one is asked once (`hc get`),
        // and again if that process is gone (a lost terminal gets a new shell at the same address).
        const mem = new Map();
        for (const addr of this.model().nodes.filter((n) => !n.gone).map((n) => n.addr)) {
          if (!rss.has(this.pids.get(addr))) {
            const r = await hc(["get", addr, "--json"]);
            const pid = r.code === 0 ? JSON.parse(r.stdout).pid : null;
            if (pid) this.pids.set(addr, pid); else continue;
          }
          if (rss.has(this.pids.get(addr))) mem.set(addr, total(this.pids.get(addr)));
        }
        this.mem = mem;
      } catch {}
      this.measuring = false;
      cx.notify();
    });
  }

  restore() {
    try {
      const saved = JSON.parse(window.sessionStorage.getItem(STORE) ?? "null");
      if (!saved) return;
      this.events = saved.events ?? [];
      this.keys = new Set(saved.keys ?? []);
      this.next = Math.max(0, ...this.events.map((e) => e.id)) + 1;
    } catch {}
  }

  save() {
    try { window.sessionStorage.setItem(STORE, JSON.stringify({ events: this.events, keys: [...this.keys].slice(-2000) })); } catch {}
  }

  scan(cx) {
    if (this.scanning) return;
    if (win()?.active === false && !watching()) return;
    this.scanning = true;
    const live = watching();
    cx.spawn(async (cx) => {
      try {
        for (const a of agents()) {
          const first = !this.read.has(a.address);
          if (!first && this.read.get(a.address) === a.seq && a.status !== "working") continue;
          const out = await hc(["read", a.address, "--lines", "250"]);
          if (out.code !== 0) continue;
          this.read.set(a.address, a.seq);
          this.parse(a.address, out.stdout, !first, live);
        }
      } catch {}
      this.scanning = false;
      this.launch(cx);
      cx.notify();
    });
  }

  // What a message says, from where it starts to its end (or 600 characters on).
  static body(text, from, until) {
    const rest = text.slice(from, from + 600);
    const end = until(rest);
    return end >= 0 ? rest.slice(0, end) : rest;
  }

  parse(addr, text, fresh, live) {
    for (const m of text.matchAll(RECV)) {
      const from = m[1].match(/\bfrom="([^"]+)"/)?.[1];
      if (!from || from === addr) continue;
      const body = AgentTalk.body(text, m.index + m[0].length, (s) => s.indexOf("</hc>"));
      this.found("recv", from, addr, body, fresh, live);
    }
    for (const m of text.matchAll(SEND)) {
      const to = this.resolve(m[1]);
      if (!to || to === addr) continue;
      const quote = m[2];
      let body = AgentTalk.body(text, m.index + m[0].length, (s) => {
        for (let i = 0; i < s.length; i++) if (s[i] === quote && s[i - 1] !== "\\") return i;
        return -1;
      });
      body = body.replace(/^\$\(cat\s*<<-?\s*'?\w+'?\s*/, "");
      this.found("send", addr, to, body, fresh, live);
    }
  }

  resolve(target) {
    const t = target.replace(/[),.;:]+$/, "");
    if (ADDR.test(t)) return t;
    return terminals().find((x) => x.name === t)?.address ?? null;
  }

  found(side, from, to, raw, fresh, live) {
    const n = norm(raw);
    if (n.length < 4) return; // `hc send t7m "..."` in a brief is an example, not a message
    const key = `${from}>${to}>${n}`;
    if (this.keys.has(key)) return;
    this.keys.add(key);
    const now = Date.now();
    const head = (s) => s.slice(0, Math.min(20, s.length));
    // The other side of the same message: same pair, the text agrees, and close in time.
    const twin = this.events.find((e) => e.from === from && e.to === to && !e.sides.includes(side)
      && (!fresh || e.at == null || now - e.at < 90000)
      && e.keys.some((k) => { const o = k.split(">")[2]; return o.startsWith(head(n)) || n.startsWith(head(o)); }));
    if (twin) {
      twin.sides.push(side);
      twin.keys.push(key);
      if (side === "recv") twin.body = flat(raw).slice(0, 240);
      this.save();
      return;
    }
    const ev = { id: this.next++, from, to, body: flat(raw).slice(0, 240), at: fresh ? now : null, sides: [side], keys: [key] };
    this.events.unshift(ev);
    this.events = this.events.slice(0, KEEP);
    this.save();
    if (fresh && live) this.queue.push(ev);
  }

  // New messages fly one after another, a beat apart, so a burst still reads as separate messages.
  launch(cx) {
    this.queue.reverse().forEach((ev, i) => cx.timer.after(i * 260, (cx) => this.fly(ev, cx)));
    this.queue = [];
  }

  // The dot runs along the connector through STEPS waypoints, spaced by an ease-in-out curve, each leg a
  // native linear move: it leaves the sender gently, speeds up, and settles into the receiver.
  fly(ev, cx) {
    const f = { id: ev.id, from: ev.from, to: ev.to, k: 0 };
    this.flights.push(f);
    cx.notify();
    const leg = FLY_MS / STEPS;
    for (let k = 1; k <= STEPS; k++) cx.timer.after(34 + (k - 1) * leg, (cx) => { f.k = k; cx.notify(); });
    cx.timer.after(34 + FLY_MS, (cx) => {
      this.flights = this.flights.filter((x) => x !== f);
      const r = { id: ev.id, at: ev.to, fade: false };
      this.rings.push(r);
      cx.notify();
      cx.timer.after(34, (cx) => { r.fade = true; cx.notify(); });
      cx.timer.after(34 + RING_MS, (cx) => { this.rings = this.rings.filter((x) => x !== r); cx.notify(); });
    });
    cx.timer.after(HOT_MS + 100, (cx) => cx.notify()); // the connector cools down
  }

  clear(cx) {
    this.events = [];
    this.save();
    cx.notify();
  }

  // ---- who's who

  who(addr, terms, live) {
    const t = terms.get(addr);
    const a = live.get(addr);
    const where = t?.labels?.where ?? (a ? `${a.space_name} / ${a.tab_name}` : t?.name ?? addr);
    const [space, tab] = where.split(" / ");
    const name = clean(space) || addr;
    const label = tab && !/^\d+$/.test(tab) ? `${name} · ${clean(tab)}` : name;
    const gone = !t || t.state === "finished";
    return { addr, label, where, status: a?.status ?? null, gone, agent: Boolean(a), mark: markOf(a?.app ?? t?.report?.app) };
  }

  // ---- the graph

  model() {
    const terms = new Map(terminals().map((t) => [t.address, t]));
    const live = new Map(agents().map((a) => [a.address, a]));
    const now = Date.now();
    const pairs = new Map();
    const order = [];
    const see = (id) => { if (!order.includes(id)) order.push(id); };
    for (const e of [...this.events].reverse()) {
      see(e.from); see(e.to);
      const k = [e.from, e.to].sort().join("|");
      const p = pairs.get(k) ?? { a: e.from, b: e.to, n: {}, last: 0, lastFrom: null };
      const d = `${e.from}>${e.to}`;
      p.n[d] = (p.n[d] ?? 0) + 1;
      if ((e.at ?? 0) >= p.last) { p.last = e.at ?? 0; p.lastFrom = e.from; }
      pairs.set(k, p);
    }
    const spawns = [];
    for (const t of terms.values()) {
      if (!t.parent || t.state === "finished" || !live.has(t.address)) continue;
      if (!terms.has(t.parent) && !live.has(t.parent)) continue;
      see(t.parent); see(t.address);
      spawns.push({ from: t.parent, to: t.address });
    }
    const degree = Object.fromEntries(order.map((id) => [id, 0]));
    for (const p of pairs.values()) { degree[p.a] += 1; degree[p.b] += 1; }
    for (const s of spawns) { degree[s.from] += 1; degree[s.to] += 1; }
    const nodes = order.map((id) => this.who(id, terms, live));
    return { nodes, pairs: [...pairs.values()], spawns, degree, now };
  }

  // The busiest agent on top with up to three below it (a lead and its workers); more go in a ring.
  place(m, W, H, top0) {
    const ids = m.nodes.map((n) => n.addr);
    const pos = {};
    let NW = Math.min(176, Math.max(110, W * 0.42));
    const busiest = [...ids].sort((a, b) => m.degree[b] - m.degree[a])[0];
    const hub = ids.length >= 3 && m.degree[busiest] >= 2 ? busiest : null;
    const ring = ids.filter((id) => id !== hub);
    const top = top0 + NODE_H / 2, bottom = H - NODE_H / 2 - 56; // room below for a row's own connectors
    const row = (list, y) => {
      if (list.length === 1) { pos[list[0]] = { x: W / 2, y }; return; }
      NW = Math.min(NW, (W - 32) / list.length - 10);
      const span = W - 32 - NW;
      list.forEach((id, i) => { pos[id] = { x: 16 + NW / 2 + (span * i) / (list.length - 1), y }; });
    };
    if (ids.length <= 2) row(ids, (top + bottom) / 2);
    else if (hub && ring.length <= 3) { pos[hub] = { x: W / 2, y: top }; row(ring, bottom); }
    else {
      NW = Math.min(NW, 128);
      const cy = (top + bottom) / 2;
      if (hub) pos[hub] = { x: W / 2, y: cy };
      const rx = W / 2 - NW / 2 - 16, ry = (bottom - top) / 2;
      ring.forEach((id, i) => {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / ring.length;
        pos[id] = { x: W / 2 + rx * Math.cos(a), y: cy + ry * Math.sin(a) };
      });
    }
    return { pos, NW };
  }

  // One curve per direction, from the sender's port to the receiver's: vertical S-curves between rows,
  // horizontal ones within a row (as the Map draws them). When both talk, the two share the ports and
  // bow apart in the middle, so each keeps its own arrowhead and its own path for the dot.
  lanes(m, pos, NW) {
    const lanes = {};
    const curve = (A, B, off) => {
      const dx = B.x - A.x, dy = B.y - A.y;
      if (Math.abs(dy) < 4) {
        // Two cards in the same row: under them, bottom port to bottom port, so it never squeezes between.
        const p0 = { x: A.x, y: A.y + NODE_H / 2 }, p1 = { x: B.x, y: B.y + NODE_H / 2 + 1 };
        const d = 40 + off;
        return { p0, p1, c1: { x: p0.x, y: p0.y + d }, c2: { x: p1.x, y: p1.y + d } };
      }
      if (Math.abs(dy) >= Math.abs(dx) * 0.45) {
        const s = Math.sign(dy) || 1;
        const p0 = { x: A.x, y: A.y + s * NODE_H / 2 }, p1 = { x: B.x, y: B.y - s * (NODE_H / 2 + 1) };
        const k = Math.abs(p1.y - p0.y) * 0.55;
        return { p0, p1, c1: { x: p0.x + off, y: p0.y + s * k }, c2: { x: p1.x + off, y: p1.y - s * k } };
      }
      const s = Math.sign(dx) || 1;
      const p0 = { x: A.x + s * NW / 2, y: A.y }, p1 = { x: B.x - s * (NW / 2 + 1), y: B.y };
      const k = Math.abs(p1.x - p0.x) * 0.5;
      return { p0, p1, c1: { x: p0.x + s * k, y: p0.y + off }, c2: { x: p1.x - s * k, y: p1.y + off } };
    };
    for (const p of m.pairs) {
      const dirs = [[p.a, p.b], [p.b, p.a]].filter(([f, t]) => p.n[`${f}>${t}`]);
      dirs.forEach(([f, t]) => {
        const A = pos[f], B = pos[t];
        if (!A || !B) return;
        const off = dirs.length === 2 ? (f === p.a ? -16 : 16) : 0;
        const hot = m.now - p.last < HOT_MS && p.lastFrom === f;
        lanes[`${f}>${t}`] = { ...curve(A, B, off), n: p.n[`${f}>${t}`], hot, from: f };
      });
    }
    return { lanes, curve };
  }

  path(l, width, dash) {
    let b = PathBuilder.stroke(width);
    if (dash) b = b.dash_array(dash);
    return b.move_to(l.p0.x, l.p0.y).cubic_bezier_to(l.p1.x, l.p1.y, l.c1.x, l.c1.y, l.c2.x, l.c2.y).build();
  }

  head(l) {
    const vx = l.p1.x - l.c2.x, vy = l.p1.y - l.c2.y, len = Math.hypot(vx, vy) || 1;
    const ux = vx / len, uy = vy / len, s = 7;
    const bx = l.p1.x - ux * s * 1.4, by = l.p1.y - uy * s * 1.4;
    return PathBuilder.fill().add_polygon([[l.p1.x, l.p1.y], [bx - uy * s * 0.6, by + ux * s * 0.6], [bx + uy * s * 0.6, by - ux * s * 0.6]], true).build();
  }

  // Connectors in the Map's styles: solid in the line colour, dashed in amber while a message is
  // fresh, dotted and faint for "started by".
  edges(c, m, pos, NW, lanes, curve, W, H) {
    const paint = (path, color) => window.paint_path(path, color).absolute().left(0).top(0).w(W).h(H);
    const out = [];
    for (const s of m.spawns) {
      const A = pos[s.from], B = pos[s.to];
      if (!A || !B || lanes[`${s.from}>${s.to}`] || lanes[`${s.to}>${s.from}`]) continue;
      out.push(paint(this.path(curve(A, B, 0), 1.5, [2, 7]), c.faint));
    }
    for (const l of Object.values(lanes)) {
      const color = l.hot ? c.accent : c.line;
      out.push(paint(this.path(l, l.hot ? 2 : 1.5, l.hot ? [5, 8] : null), color));
      out.push(paint(this.head(l), color));
    }
    return out;
  }

  // What a connector says, beside its middle: who just spoke (`t64 ⇢`), else how many messages went.
  labels(c, m, lanes) {
    return m.pairs.map((p) => {
      const ls = [lanes[`${p.a}>${p.b}`], lanes[`${p.b}>${p.a}`]].filter(Boolean);
      if (!ls.length) return null;
      const hot = ls.find((l) => l.hot);
      const mid = bez(ls[ls.length - 1], 0.5);
      const total = ls.reduce((n, l) => n + l.n, 0);
      const ab = p.n[`${p.a}>${p.b}`] ?? 0, ba = p.n[`${p.b}>${p.a}`] ?? 0;
      return div().id(`label-${p.a}-${p.b}`).absolute().left(mid.x + 10).top(mid.y - 8).whitespace_nowrap()
        .text_size(10.5).font_family(MONO).font_weight(hot ? 650 : 500).text_color(hot ? c.accent : c.faint)
        .tooltip(`${p.a} → ${p.b}: ${ab} · ${p.b} → ${p.a}: ${ba}`)
        .child(hot ? `${hot.from} ⇢` : `×${total}`);
    }).filter(Boolean);
  }

  // The Map's card status icon, 18px at the top right.
  statusIcon(c, n) {
    const box = () => div().absolute().top(10).right(10).w(18).h(18).rounded(9).flex().items_center().justify_center();
    if (n.gone) return box().border(2).border_color(c.line);
    if (n.status === "working") return div().absolute().top(8).right(8).w(22).h(22)
      .child(div().absolute().left(2).top(2).w(18).h(18).rounded(9).border(2).border_color(c.line))
      .child(svg(`${ASSET}/arc-status.svg`).absolute().left(0).top(0).w(22).h(22).text_color(c.accent).spin(1100));
    if (n.status === "blocked") return box().bg(c.danger).text_size(12).font_weight(700).text_color("#ffffff").child("!");
    if (n.status === "done") return box().bg(c.done).child(svg(`${ASSET}/check.svg`).w(18).h(18).text_color("#ffffff"));
    return box().border(2).border_color(c.faint);
  }

  card(c, n, p, NW, hot) {
    const word = n.gone ? "Ended" : WORD[n.status] ?? (n.agent ? "Agent" : "Terminal");
    const kb = n.gone ? null : this.mem.get(n.addr) ?? null;
    const memText = kb == null ? null : kb >= 1048576 ? `${(kb / 1048576).toFixed(1)} GB` : `${Math.round(kb / 1024)} MB`;
    return div().id(`node-${n.addr}`).absolute().left(p.x - NW / 2).top(p.y - NODE_H / 2).w(NW).h(NODE_H)
      .transition("left", { duration: 300, easing: "ease-in-out" }).transition("top", { duration: 300, easing: "ease-in-out" })
      .rounded(12).bg(hot ? c.cardLive : c.card).border(hot ? 1.5 : 1).border_color(hot ? c.accent : c.line)
      .when(n.gone, (el) => el.opacity(0.5))
      .cursor_pointer().hover((s) => s.bg(c.cardHover).border_color(hot ? c.accent : c.faint))
      .tooltip(`${n.where} · ${n.addr} · ${word}${memText ? ` · ${memText} memory (the agent and everything it started)` : ""}. Click to go there`)
      .accessibility_label(`${n.label}, ${n.addr}, ${word}${memText ? `, ${memText} memory` : ""}. Go there`)
      .on_click(() => run("agent.focus", { terminal: n.addr }))
      .child(v_flex().size_full().pl(12).pr(36).py(10).gap(2).justify_center()
        .child(h_flex().h(14).gap(5).items_center()
          .when(Boolean(n.mark), (el) => el.child(svg(`${ASSET}/agent-${n.mark}.svg`).w(11).h(11).flex_none().text_color(markColor(c, n.mark))))
          .child(div().text_size(10.5).font_family(MONO).font_weight(500).text_color(c.faint).child(n.addr)))
        .child(div().h(19).truncate().text_size(13.5).line_height("19px").font_weight(600).text_color(c.text).child(n.label))
        .child(h_flex().h(16).gap(6).items_center().min_w(0)
          .child(div().flex_none().text_size(11.5).line_height("16px").font_weight(500).text_color(n.gone ? c.faint : tone(c, n.status)).child(word))
          .when(Boolean(memText), (el) => el
            .child(div().flex_none().text_size(11.5).text_color(c.faint).child("·"))
            .child(div().min_w(0).truncate().text_size(11).font_family(MONO).text_color(c.dim).child(memText)))))
      .child(this.statusIcon(c, n));
  }

  // The Map's dot grid: dashed lines, so a whole field costs a few paths.
  grid(c, W, H) {
    const key = `${W}x${H}|${lit()}`;
    if (this.gridCache?.key !== key) {
      let path = PathBuilder.stroke(2).dash_array([2, DOT - 2]);
      for (let y = 1; y < H; y += DOT) path = path.move_to(0, y).line_to(W, y);
      this.gridCache = { key, path: path.build() };
    }
    return window.paint_path(this.gridCache.path, c.dot).absolute().left(0).top(0).w(W).h(H);
  }

  chip(c, text) {
    return div().absolute().left(12).top(12).px(10).py(5).rounded(10).border(1).border_color(c.line).bg(c.overlay)
      .whitespace_nowrap().text_size(10.5).font_weight(600).font_family(MONO).text_color(c.faint).child(text);
  }

  canvas(c, m, W, H) {
    const hotAny = this.events.some((e) => e.at && m.now - e.at < HOT_MS);
    const pairs = m.pairs.length, msgs = this.events.length;
    const label = msgs
      ? `${hotAny ? "NOW" : "EARLIER"} · ${pairs} ${pairs === 1 ? "PAIR" : "PAIRS"} · ${msgs} ${msgs === 1 ? "MESSAGE" : "MESSAGES"}`
      : `WATCHING ${agents().length} AGENTS`;
    const box = div().id("talk-canvas").relative().flex_none().w(W).h(H).overflow_hidden().bg(c.bg).child(this.grid(c, W, H)).child(this.chip(c, label))
      .when(msgs > 0, (el) => el.child(div().id("talk-clear").absolute().top(10).right(10).h(28).px(10).flex().items_center().rounded(8)
        .text_size(11).font_family(MONO).text_color(c.dim).cursor_pointer()
        .hover((s) => s.bg(c.hover).text_color(c.text)).active((s) => s.bg(c.raised))
        .tooltip("Clear the list (messages already seen stay counted)")
        .on_click((_e, cx) => this.clear(cx)).child("Clear")));
    if (!m.nodes.length) {
      return box.child(v_flex().absolute().left(0).top(48).w(W).px(24).gap(6)
        .child(div().text_size(15).font_weight(600).text_color(c.text).child("No messages yet"))
        .child(div().text_size(13).text_color(c.dim).child("When one agent sends another a message with hc send, they appear here as cards, and the message runs along the line between them.")));
    }
    // The cards keep a readable spread and sit in the middle of a tall panel, so lines never stretch.
    const band = Math.min(H - 52, Math.max(300, W * 0.85));
    const y0 = 52 + (H - 52 - band) / 2;
    const { pos, NW } = this.place(m, W, y0 + band, y0);
    const { lanes, curve } = this.lanes(m, pos, NW);
    const hot = new Set();
    for (const e of this.events) if (e.at && m.now - e.at < HOT_MS) { hot.add(e.from); hot.add(e.to); }
    const dots = this.flights.map((f) => {
      const l = lanes[`${f.from}>${f.to}`];
      if (!l) return null;
      const at = bez(l, ease(f.k / STEPS));
      const move = (el) => el.transition("left", { duration: FLY_MS / STEPS, easing: "linear" }).transition("top", { duration: FLY_MS / STEPS, easing: "linear" });
      return [
        move(div().id(`glow-${f.id}`).absolute().left(at.x - 9).top(at.y - 9).size(18).rounded(9).bg(c.accent + "40")),
        move(div().id(`dot-${f.id}`).absolute().left(at.x - 4.5).top(at.y - 4.5).size(9).rounded(5).bg(c.accent)),
      ];
    }).filter(Boolean).flat();
    const rings = this.rings.map((r) => {
      const p = pos[r.at];
      if (!p) return null;
      return div().id(`ring-${r.id}`).absolute().left(p.x - NW / 2 - 5).top(p.y - NODE_H / 2 - 5).w(NW + 10).h(NODE_H + 10)
        .rounded(16).border(2).border_color(c.accent).opacity(r.fade ? 0 : 1)
        .transition("opacity", { duration: RING_MS, easing: "ease-out" });
    }).filter(Boolean);
    // Ports where connectors meet the cards, as the Map's side ports.
    const ports = new Map();
    for (const l of Object.values(lanes)) for (const q of [l.p0, l.p1]) ports.set(`${Math.round(q.x)}:${Math.round(q.y)}`, q);
    return box
      .children(this.edges(c, m, pos, NW, lanes, curve, W, H))
      .children(this.labels(c, m, lanes))
      .children(rings)
      .children(m.nodes.map((n) => this.card(c, n, pos[n.addr], NW, hot.has(n.addr))))
      .children([...ports.values()].map((q) => div().absolute().left(q.x - 4).top(q.y - 4).w(8).h(8).rounded(4).bg(c.raised).border(1).border_color(c.faint)))
      .children(dots);
  }

  // The panel's name, in the Map header's look.
  header(c) {
    return h_flex().flex_none().h(44).px(12).gap(10).items_center().bg(c.bg).border_b(1).border_color(c.hover)
      .child(svg("mods/studio-tabs/talk.svg").w(16).h(16).flex_none().text_color(c.dim))
      .child(div().flex_1().min_w(0).truncate().text_size(14).font_weight(600).text_color(c.text).child("Agent talk"));
  }

  render() {
    const c = lit() ? LIGHT : DARK;
    const W = this.size ? Math.max(220, this.size.width) : null;
    const H = this.size ? Math.max(260, this.size.height - 44) : 0; // under the 44px header
    const m = this.model();
    return v_flex().id("talk-root").size_full().bg(c.bg).font_family(SANS).text_color(c.text)
      .on_size_change((size, cx) => { if (size.width !== this.size?.width || size.height !== this.size?.height) { this.size = size; cx.notify(); } })
      .child(this.header(c))
      .when(Boolean(W), (el) => el.child(this.canvas(c, m, W, H)));
  }
}
