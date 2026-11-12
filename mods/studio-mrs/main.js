// Merge requests you opened and ones waiting for your review, with pipeline state.
// Runs `glab api` (read-only GETs every two minutes while the window is in front,
// plus one POST when you press Retry). Nothing else leaves the machine.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, home, theme, window, settings, layout } from "herdr";

const ICONS = "mods/studio-workspace-chrome";
const MINE = "merge_requests?scope=created_by_me&state=opened&per_page=20";
const reviewing = (username) => `merge_requests?scope=all&state=opened&reviewer_username=${encodeURIComponent(username)}&per_page=20`;
const DETAIL_LIMIT = 12;

function ago(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

async function glab(args) {
  const r = await exec("glab", args, { cwd: home(), timeout: 30000 });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || "glab failed").trim().split("\n")[0]);
  return r.stdout;
}

// failed and conflicts first, then running, then the rest, drafts last.
function rank(m) {
  const p = m.head_pipeline?.status;
  // Drafts are works in progress: a failing one is not urgent.
  if (m.draft) return 4;
  if (p === "failed") return 0;
  if (m.has_conflicts && !m.draft) return 1;
  if (p === "running" || p === "pending" || p === "created" || p === "preparing" || p === "waiting_for_resource") return 2;
  return m.draft ? 4 : 3;
}

const FILTERS = [
  { id: "failed", label: "Failed", test: (m) => m.head_pipeline?.status === "failed" },
  { id: "conflicts", label: "Conflicts", test: (m) => Boolean(m.has_conflicts) && !m.draft },
  { id: "running", label: "Running", test: (m) => ["running", "pending", "created", "preparing", "waiting_for_resource"].includes(m.head_pipeline?.status) },
  { id: "unreviewed", label: "Not approved", test: (m) => m.approvedByMe === false },
];

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

export default class Mrs extends View {
  init(_props, cx) {
    this.items = null; // opened by you
    this.reviews = null; // waiting for your review
    this.me = null;
    this.error = null;
    this.loading = false;
    this.at = null;
    this.retrying = new Set();
    this.copied = null; // the MR whose link was just copied
    this.filtering = false; // the filter row is open
    this.filter = null; // one of FILTERS, or all
    this.hideDrafts = false;
    this.last = 0;
    this.redrawn = 0;
    // Looks every two minutes, but only while this pane is the one shown (and at once when it opens).
    // A redraw every 30 seconds keeps "5m ago" honest.
    cx.timer.every(3000, (cx) => {
      if (!shown("mrs")) return;
      const now = Date.now();
      if (window()?.active && now - this.last > 120000) this.refresh(cx);
      else if (now - this.redrawn > 30000) {
        this.redrawn = now;
        cx.notify();
      }
    });
  }

  // The first few get their own record: the list has no pipeline in it.
  async detail(list, extra) {
    return Promise.all(list.slice(0, DETAIL_LIMIT).map(async (m) => {
      try {
        const full = JSON.parse(await glab(["api", `projects/${m.project_id}/merge_requests/${m.iid}`]));
        return extra ? await extra(full) : full;
      } catch {
        return m;
      }
    }));
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    this.last = Date.now();
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        this.me ??= JSON.parse(await glab(["api", "user"])).username;
        const [mine, asked] = await Promise.all([glab(["api", MINE]), glab(["api", reviewing(this.me)])]);
        const mineList = JSON.parse(mine);
        // Others' MRs that name you as reviewer; yours are in the other list.
        const askedList = JSON.parse(asked).filter((m) => m.author?.username !== this.me);
        const [own, theirs] = await Promise.all([
          this.detail(mineList),
          this.detail(askedList, async (m) => {
            // Whether you already approved it.
            let approved = false;
            try {
              const a = JSON.parse(await glab(["api", `projects/${m.project_id}/merge_requests/${m.iid}/approvals`]));
              approved = (a.approved_by ?? []).some((x) => x.user?.username === this.me);
            } catch {}
            return { ...m, approvedByMe: approved };
          }),
        ]);
        this.items = [...own, ...mineList.slice(DETAIL_LIMIT)];
        this.reviews = [...theirs, ...askedList.slice(DETAIL_LIMIT)];
        this.error = null;
        this.at = Date.now();
      } catch (e) {
        this.error = String(e.message ?? e);
      }
      this.loading = false;
      cx.notify();
    });
  }

  retry(m, cx) {
    const id = m.head_pipeline?.id;
    if (!id || this.retrying.has(id)) return;
    this.retrying.add(id);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await glab(["api", "-X", "POST", `projects/${m.project_id}/pipelines/${id}/retry`]);
      } catch (e) {
        this.error = `Retry failed: ${String(e.message ?? e)}`;
      }
      this.retrying.delete(id);
      this.loading = false;
      this.refresh(cx);
    });
  }

  pipeline(t, status) {
    switch (status) {
      case "success": return { label: "Passed", color: t.ansi2, mark: div().size(7).mx(2).rounded(4).bg(t.ansi2).flex_none() };
      case "failed": return { label: "Failed", color: t.blocked, mark: div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!") };
      case "running": return { label: "Running", color: t.working, mark: svg(`${ICONS}/spinner.svg`).size(12).flex_none().text_color(t.working).spin(900) };
      case "pending": case "created": case "preparing": case "waiting_for_resource": case "scheduled":
        return { label: "Waiting", color: t.muted, mark: div().size(7).mx(2).rounded(4).border(1.5).border_color(t.idle ?? t.dim).flex_none() };
      case "canceled": return { label: "Canceled", color: t.dim, mark: div().size(7).mx(2).rounded(4).border(1.5).border_color(t.dim).flex_none() };
      case "manual": return { label: "Manual", color: t.muted, mark: div().size(7).mx(2).rounded(4).border(1.5).border_color(t.dim).flex_none() };
      default: return null;
    }
  }

  chip(t, label, color) {
    return div().flex_none().h(16).px(5).flex().items_center().rounded(4).bg(color + "26").text_size(10.5).font_medium().text_color(color).child(label);
  }

  button(t, id, label, action) {
    return div().id(id).h(22).px(8).flex().items_center().flex_none().rounded(5).text_size(11.5).cursor_pointer()
      .accessibility_label(label).border(1).border_color(t.border).bg(t.chrome).text_color(t.foreground)
      .hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        action(cx);
      })
      .child(label);
  }

  // Icon-only button that copies the MR's link, then says "Copied" for a moment.
  copyLink(t, m) {
    const copied = this.copied === m.id;
    return div().id(`copy-${m.id}`).size(22).flex_none().flex().items_center().justify_center().rounded(5).border(1)
      .border_color(copied ? t.ansi2 + "66" : t.border).bg(copied ? t.ansi2 + "1a" : t.chrome).text_color(copied ? t.ansi2 : t.muted)
      .cursor_pointer().tooltip(copied ? "Copied" : "Copy link").accessibility_label(copied ? "Link copied" : "Copy link to this merge request")
      .hover((s) => s.bg(copied ? t.ansi2 + "1a" : t.hover).text_color(copied ? t.ansi2 : t.foreground)).active((s) => s.bg(t.selected))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        cx.write_to_clipboard(m.web_url);
        this.copied = m.id;
        cx.notify();
        cx.timer.after(1200, (cx) => {
          if (this.copied === m.id) this.copied = null;
          cx.notify();
        });
      })
      .child(svg(copied ? `${ICONS}/check.svg` : "mods/studio-mrs/link.svg").size(12));
  }

  // A toggle in the filter row; `count` is how many of all the MRs it would show.
  filterChip(t, id, label, count, on, action) {
    const empty = count === 0 && !on;
    return h_flex().id(id).h(24).px(8).gap(5).items_center().flex_none().rounded(6).text_size(11.5)
      .border(1).border_color(on ? t.accent : t.border).bg(on ? t.selected : t.chrome)
      .text_color(on ? t.foreground : empty ? t.dim : t.muted)
      .accessibility_label(`${label}${count != null ? `, ${count}` : ""}. ${on ? "On" : "Off"}`)
      .when(!empty, (el) => el.cursor_pointer().hover((s) => s.bg(on ? t.selected : t.hover)).active((s) => s.bg(t.selected)))
      .on_click((_e, cx) => {
        if (empty) return;
        action();
        cx.notify();
      })
      .child(label)
      .when(count != null, (el) => el.child(div().text_color(t.dim).child(String(count))));
  }

  card(t, m, now) {
    const status = m.head_pipeline?.status;
    const pipe = this.pipeline(t, status);
    const title = m.title.replace(/^Draft:\s*/i, "");
    const ref = m.references?.full ?? `!${m.iid}`;
    const repo = ref.includes("/") ? ref.slice(ref.lastIndexOf("/") + 1) : ref;
    const updated = Date.parse(m.updated_at);
    const retrying = this.retrying.has(m.head_pipeline?.id);
    const theirs = m.author?.username && m.author.username !== this.me;
    return v_flex().id(`mr-${m.id}`).w_full().flex_none().px(10).py(8).gap(5).rounded(8).border(1)
      .border_color(status === "failed" ? t.blocked + "55" : t.border).bg(t.chrome).cursor_pointer()
      .accessibility_label(`${title}, ${ref}${pipe ? `, pipeline ${pipe.label.toLowerCase()}` : ""}. Open in browser`)
      .hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected))
      .on_click((_e, cx) => cx.open_url(m.web_url))
      .child(h_flex().gap(6).items_center()
        .when(m.draft, (el) => el.child(this.chip(t, "Draft", t.muted)))
        .child(div().id(`mr-title-${m.id}`).flex_1().min_w(0).truncate().font_medium().tooltip(title).child(title)))
      .child(h_flex().gap(6).items_center().text_size(11.5).text_color(t.dim)
        .child(div().flex_none().font_family(settings().font_family ?? "JetBrains Mono").text_size(10.5).child(repo))
        .child(div().id(`mr-branch-${m.id}`).flex_1().min_w(0).truncate().tooltip(m.source_branch).child(m.source_branch))
        .when(theirs, (el) => el.child(div().id(`mr-author-${m.id}`).flex_none().max_w(90).truncate().tooltip(`by ${m.author.name ?? m.author.username}`).child(m.author.username)))
        .when(m.user_notes_count > 0, (el) => el.child(div().flex_none().child(`${m.user_notes_count} ✉`)))
        .child(div().flex_none().child(ago(now - updated))))
      .child(h_flex().gap(6).items_center().h(22)
        .when(Boolean(pipe), (el) => el.child(pipe.mark).child(div().flex_none().text_size(11.5).text_color(pipe.color).child(pipe.label)))
        .when(m.has_conflicts && !m.draft, (el) => el.child(this.chip(t, "Conflicts", t.blocked)))
        .when(m.approvedByMe, (el) => el.child(this.chip(t, "You approved", t.ansi2)))
        .child(div().flex_1())
        .when(status === "failed" && !theirs, (el) => el.child(this.button(t, `retry-${m.id}`, retrying ? "Retrying…" : "Retry", (cx) => this.retry(m, cx))))
        .child(this.copyLink(t, m))
        .child(this.button(t, `open-${m.id}`, "Open", (cx) => cx.open_url(m.web_url))));
  }

  render() {
    const t = theme();
    const now = Date.now();
    const order = (list) => [...(list ?? [])].sort((a, b) => rank(a) - rank(b) || Date.parse(b.updated_at) - Date.parse(a.updated_at));
    const allMine = order(this.items);
    // Ones you haven't approved yet come first.
    const allReviews = order(this.reviews).sort((a, b) => Number(Boolean(a.approvedByMe)) - Number(Boolean(b.approvedByMe)));
    const active = FILTERS.find((f) => f.id === this.filter);
    const keep = (m) => (!active || active.test(m)) && !(this.hideDrafts && m.draft);
    const mine = allMine.filter(keep);
    const reviews = allReviews.filter(keep);
    const everything = [...allMine, ...allReviews];
    const narrowed = Boolean(active) || this.hideDrafts;
    const failed = allMine.filter((m) => m.head_pipeline?.status === "failed").length;
    const waiting = allReviews.filter((m) => !m.approvedByMe && !m.draft).length;
    const loaded = this.items && this.reviews;
    const section = (label, n, extra) => h_flex().flex_none().h(24).px(2).mt(4).gap(6).items_center().text_size(11).font_medium()
      .child(div().text_color(t.dim).child(label)).child(div().text_color(t.dim).child(String(n))).when(Boolean(extra), (el) => el.child(extra));
    return v_flex().size_full().min_w(0).min_h(0).bg(t.chrome).text_color(t.foreground).text_size(13)
      .child(h_flex().flex_none().h(41).px(14).pt(4).items_center().gap(8)
        .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Merge requests"))
        .when(failed > 0, (el) => el.child(div().text_size(11.5).font_medium().text_color(t.blocked).child(`${failed} failed`)))
        .when(waiting > 0, (el) => el.child(div().text_size(11.5).font_medium().text_color(t.working).child(`${waiting} to review`)))
        .child(div().flex_1())
        .when(Boolean(this.at), (el) => el.child(div().text_size(11).text_color(t.dim).child(ago(now - this.at))))
        .child(div().id("mr-filter").size(24).flex_none().relative().flex().items_center().justify_center().rounded(6)
          .bg(this.filtering ? t.selected : t.chrome).text_color(this.filtering || narrowed ? t.foreground : t.dim)
          .cursor_pointer().tooltip(narrowed ? "Filter (on)" : "Filter").accessibility_label(`Filter merge requests${narrowed ? ", on" : ""}`)
          .hover((s) => s.bg(this.filtering ? t.selected : t.hover).text_color(t.foreground)).active((s) => s.bg(t.selected))
          .on_click((_e, cx) => {
            this.filtering = !this.filtering;
            cx.notify();
          })
          .child(svg("mods/studio-mrs/filter.svg").size(13))
          .when(narrowed, (el) => el.child(div().absolute().top(4).right(4).size(6).rounded(3).bg(t.accent))))
        .child(div().id("mr-refresh").size(24).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim)
          .tooltip("Refresh").accessibility_label("Refresh merge requests")
          .when(!this.loading, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).active((s) => s.bg(t.selected))
            .on_click((_e, cx) => this.refresh(cx)))
          .child(this.loading
            ? svg(`${ICONS}/spinner.svg`).size(13).text_color(t.muted).spin(900)
            : svg("mods/studio-mrs/refresh.svg").size(13))))
      .when(this.filtering, (el) => el.child(h_flex().flex_none().px(10).pb(8).gap(5).flex_wrap()
        .child(this.filterChip(t, "f-all", "All", null, !active, () => { this.filter = null; }))
        .children(FILTERS.map((f) => this.filterChip(t, `f-${f.id}`, f.label, everything.filter(f.test).length, this.filter === f.id,
          () => { this.filter = this.filter === f.id ? null : f.id; })))
        .child(this.filterChip(t, "f-drafts", "Hide drafts", everything.filter((m) => m.draft).length, this.hideDrafts,
          () => { this.hideDrafts = !this.hideDrafts; }))))
      .child(v_flex().id("mrs-scroll").flex_1().min_h(0).px(10).pb(10).gap(6).overflow_y_scrollbar()
        .when(Boolean(this.error), (el) => el.child(v_flex().px(4).py(6).gap(4)
          .child(div().text_size(12).text_color(t.blocked).child(this.error))
          .child(div().text_size(11.5).text_color(t.dim).child("Check `glab auth status`, then refresh."))))
        .when(!loaded && !this.error, (el) => el.child(div().px(4).py(8).text_color(t.dim).child("Loading…")))
        .when(loaded && !mine.length && !reviews.length && !this.error && !narrowed, (el) => el.child(v_flex().px(4).py(8).gap(4)
          .child(div().text_color(t.muted).child("No open merge requests"))
          .child(div().text_size(12).text_color(t.dim).child("Yours and ones waiting for your review show up here."))))
        .when(loaded && !mine.length && !reviews.length && !this.error && narrowed, (el) => el.child(v_flex().px(4).py(8).gap(6)
          .child(div().text_color(t.muted).child("No merge requests match"))
          .child(this.button(t, "f-clear", "Clear filters", () => { this.filter = null; this.hideDrafts = false; }).self_start())))
        .when(reviews.length > 0, (el) => el.child(section("To review", reviews.length)))
        .children(reviews.map((m) => this.card(t, m, now)))
        .when(mine.length > 0, (el) => el.child(section("Yours", mine.length)))
        .children(mine.map((m) => this.card(t, m, now))));
  }
}
