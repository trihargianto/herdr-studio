// Tasks: things to get agents working on, each with a title, details and links.
// Saved in ~/.config/herdr-app/studio-tasks/tasks.json. "Send to agent" writes the task as a
// markdown brief next to it and sends the focused agent a short pointer (`hc send`), so long
// context never rides in the message itself. Nothing is sent until you press the button.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, EditorState, Editor, TextView } from "gpui-base";
import * as fs from "fs/promises";
import { agents, focused, hc, appHome, theme, settings, layout } from "herdr";

// The first line of the details, without markdown marks, for a closed card.
const preview = (md) => (md.split("\n").map((l) => l.replace(/^[#>\-*\s`]+/, "").replace(/[*_`]/g, "").trim()).find(Boolean) ?? "");

const ICONS = "mods/studio-workspace-chrome";
const STATUS = ["todo", "doing", "done"];
const NEXT = { todo: "doing", doing: "done", done: "todo" };
const LABEL = { todo: "To do", doing: "Doing", done: "Done" };

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}~/]+/u, "").trim();

function ago(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// "https://host/a/b?x" shown as "host/a/b".
function short(url) {
  return url.replace(/^https?:\/\//, "").replace(/[?#].*$/, "").replace(/\/$/, "");
}

// Only http(s) links open (`open_url` refuses everything else); a bare domain gets https.
function toLink(raw) {
  const s = raw.trim();
  if (!s || /\s/.test(s)) return null;
  if (/^https?:\/\/\S+\.\S+/i.test(s)) return s;
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(s)) return `https://${s}`;
  return null;
}

function brief(task) {
  const lines = [`# Task: ${task.title}`, ""];
  if (task.notes) lines.push(task.notes, "");
  if (task.links.length) lines.push("## Links", ...task.links.map((l) => `- ${l}`), "");
  lines.push(`_From Herdr Studio tasks · ${task.id}_`, "");
  return lines.join("\n");
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

export default class Tasks extends View {
  init(_props, cx) {
    this.dir = `${appHome()}/studio-tasks`;
    this.tasks = [];
    this.ready = false;
    this.open = null; // the expanded task's id
    this.form = null; // { id: string | null, links: string[] } while adding or editing
    this.focus = null; // which input has the keyboard
    this.showDone = false;
    this.filter = null; // "todo", "doing" or "done"; null shows everything
    this.confirm = null; // a task whose delete awaits a second click
    this.copied = null;
    this.note = null;
    this.sending = null;
    this.menuFor = null; // the task whose agent list is open
    this.pick = null; // an agent chosen by hand; null follows the active one
    this.queue = Promise.resolve();

    this.quickIn = InputState.new({ placeholder: "Add a task, press Enter" });
    this.quickIn.on("submit", (_e, cx) => this.quickAdd(cx));
    this.quickIn.on("focus", (_e, cx) => { this.focus = "quick"; cx.notify(); });
    this.quickIn.on("blur", (_e, cx) => { if (this.focus === "quick") this.focus = null; cx.notify(); });
    this.titleIn = InputState.new({ placeholder: "What should the agent do?" });
    // Details are markdown: a small editor that wraps, with no gutter.
    const t = theme();
    this.notesIn = EditorState.new({
      language: "markdown", soft_wrap: true, line_numbers: false, folding: false, font_size: 12,
      font_family: settings().font_family,
      syntax: { keyword: t.accent, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi6, number: t.ansi3, constant: t.ansi5, punctuation: t.dim },
    });
    this.linkIn = InputState.new({ placeholder: "Paste a link, press Enter" });
    this.titleIn.on("submit", (_e, cx) => this.save(cx));
    // Details are multi-line: Enter and Shift+Enter add a line (the editor also reports them as "submit",
    // without `secondary`), and only Cmd/Ctrl+Enter saves the form.
    this.notesIn.on("submit", (e, cx) => { if (e.secondary) this.save(cx); });
    this.linkIn.on("submit", (_e, cx) => this.addLink(cx));
    for (const [name, state] of [["title", this.titleIn], ["notes", this.notesIn], ["link", this.linkIn]]) {
      state.on("focus", (_e, cx) => { this.focus = name; cx.notify(); });
      state.on("blur", (_e, cx) => { if (this.focus === name) this.focus = null; cx.notify(); });
    }

    cx.spawn(async (cx) => {
      try {
        await fs.mkdir(`${this.dir}/briefs`, { recursive: true });
        if (await fs.exists(`${this.dir}/tasks.json`)) this.tasks = JSON.parse(await fs.readFile(`${this.dir}/tasks.json`, "utf8"));
      } catch {
        this.note = { ok: false, text: "Couldn't read saved tasks." };
      }
      this.ready = true;
      cx.notify();
    });
    // The ages ("2m") redraw once a minute, and only while this pane is the one shown.
    cx.timer.every(60000, (cx) => {
      if (shown("tasks")) cx.notify();
    });
  }

  // Writes are queued so two quick edits never race.
  persist() {
    const text = JSON.stringify(this.tasks, null, 2);
    this.queue = this.queue
      .then(() => fs.writeFile(`${this.dir}/tasks.json`, text))
      .catch(() => { this.note = { ok: false, text: "Couldn't save tasks." }; });
  }

  update(id, patch) {
    this.tasks = this.tasks.map((x) => (x.id === id ? { ...x, ...patch, updated: Date.now() } : x));
    this.persist();
  }

  // ---- form

  // One line, Enter: a task with just a title. The + opens the full form for details and links.
  quickAdd(cx) {
    const title = this.quickIn.value().trim();
    if (!title) return;
    const id = `task-${Date.now().toString(36)}`;
    this.tasks = [{ id, title, notes: "", links: [], status: "todo", agent: null, created: Date.now(), updated: Date.now() }, ...this.tasks];
    this.quickIn.set_value("");
    if (this.filter === "doing" || this.filter === "done") this.filter = null;
    this.persist();
    cx.notify();
  }

  edit(task, cx) {
    this.form = { id: task?.id ?? null, links: [...(task?.links ?? [])] };
    // Anything typed in the quick field carries over into a new task's form.
    this.titleIn.set_value(task?.title ?? this.quickIn.value());
    if (!task) this.quickIn.set_value("");
    this.notesIn.set_value(task?.notes ?? "");
    this.linkIn.set_value("");
    this.note = null;
    this.titleIn.focus();
    cx.notify();
  }

  addLink(cx) {
    const raw = this.linkIn.value();
    if (!raw.trim() || !this.form) return;
    const link = toLink(raw);
    if (!link) {
      this.note = { ok: false, text: "Links must start with http:// or https://" };
    } else {
      if (!this.form.links.includes(link)) this.form.links.push(link);
      this.linkIn.set_value("");
      this.note = null;
    }
    cx.notify();
  }

  save(cx) {
    const form = this.form;
    const title = this.titleIn.value().trim();
    if (!form || !title) return;
    // A link typed but not yet added still counts.
    const pending = toLink(this.linkIn.value());
    const links = pending && !form.links.includes(pending) ? [...form.links, pending] : form.links;
    const notes = this.notesIn.value().trim();
    if (form.id) this.update(form.id, { title, notes, links });
    else {
      const id = `task-${Date.now().toString(36)}`;
      this.tasks = [{ id, title, notes, links, status: "todo", agent: null, created: Date.now(), updated: Date.now() }, ...this.tasks];
      this.open = id;
      if (this.filter === "doing" || this.filter === "done") this.filter = null;
      this.persist();
    }
    this.form = null;
    this.note = null;
    cx.notify();
  }

  // ---- actions

  remove(task, cx) {
    if (this.confirm !== task.id) {
      this.confirm = task.id;
      cx.notify();
      cx.timer.after(3000, (cx) => {
        if (this.confirm === task.id) this.confirm = null;
        cx.notify();
      });
      return;
    }
    this.tasks = this.tasks.filter((x) => x.id !== task.id);
    this.confirm = null;
    if (this.open === task.id) this.open = null;
    this.persist();
    // The brief file would only mislead an agent now.
    fs.unlink(`${this.dir}/briefs/${task.id}.md`).catch(() => {});
    cx.notify();
  }

  copyBrief(task, cx) {
    cx.write_to_clipboard(brief(task));
    this.copied = task.id;
    cx.notify();
    cx.timer.after(1200, (cx) => {
      if (this.copied === task.id) this.copied = null;
      cx.notify();
    });
  }

  copyText(text, key, cx) {
    cx.write_to_clipboard(text);
    this.copied = key;
    cx.notify();
    cx.timer.after(1200, (cx) => {
      if (this.copied === key) this.copied = null;
      cx.notify();
    });
  }

  // Where Send goes: the agent picked in the list, else the one whose terminal is active.
  target(list) {
    return (this.pick && list.find((a) => a.address === this.pick)) || list.find((a) => a.address === focused()?.terminal) || null;
  }

  // The chosen agent gets a one-line pointer to the task's brief file.
  send(task, cx) {
    const target = this.target(agents());
    if (!target) {
      this.note = { ok: false, text: "Focus an agent terminal first." };
      cx.notify();
      return;
    }
    if (this.sending) return;
    this.sending = task.id;
    this.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const file = `${this.dir}/briefs/${task.id}.md`;
        await fs.writeFile(file, brief(task));
        let path = file;
        if (target.address.includes("/")) {
          // On another machine: put the file beside that terminal and use where it landed.
          const put = await hc(["put", target.address, file]);
          if (put.code !== 0) throw new Error((put.stderr || put.stdout || "Couldn't copy the brief there.").trim().split("\n")[0]);
          path = put.stdout.trim().split("\n").filter(Boolean).pop().replace(/^["']|["']$/g, "");
        }
        const text = `Read ${path} and work on the task described in it: ${task.title}`;
        const r = await hc(["send", target.address, text, ...(target.status === "blocked" ? ["--force"] : [])]);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout || "Not sent").trim().split("\n")[0]);
        this.update(task.id, { agent: target.address, status: task.status === "todo" ? "doing" : task.status });
        this.note = { ok: true, text: `Sent to ${target.address}` };
        this.pick = null;
        this.menuFor = null;
      } catch (e) {
        this.note = { ok: false, text: String(e.message ?? e) };
      }
      this.sending = null;
      cx.notify();
    });
  }

  // ---- pieces

  button(t, id, label, action, primary = false) {
    return div().id(id).h(26).px(10).flex().items_center().flex_none().rounded(7).text_size(12).font_medium().cursor_pointer()
      .accessibility_label(label)
      .border(1).border_color(primary ? t.solid : t.border)
      .bg(primary ? t.solid : t.chrome).text_color(primary ? t.solid_foreground : t.foreground)
      .hover((s) => s.bg(primary ? t.solid : t.hover)).active((s) => s.bg(t.selected))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        action(cx);
      })
      .child(label);
  }

  iconButton(t, id, path, label, action, color, size = 24) {
    return div().id(id).size(size).flex_none().flex().items_center().justify_center().rounded(6)
      .text_color(color ?? t.dim).cursor_pointer().tooltip(label).accessibility_label(label)
      .hover((s) => s.bg(t.raised).text_color(color ?? t.foreground)).active((s) => s.bg(t.selected))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        action(cx);
      })
      .child(svg(path).size(13));
  }

  // A small rounded label: icon and/or text, optionally tinted.
  pill(t, children, color) {
    return h_flex().h(18).px(7).gap(4).items_center().flex_none().rounded(9).text_size(11)
      .bg(color ? color + "1f" : t.raised).text_color(color ?? t.muted).children(children);
  }

  // The status mark, which is also the button that moves a task along: to do, doing, done.
  mark(t, task) {
    const next = NEXT[task.status];
    const face = task.status === "done"
      ? div().size(18).rounded(9).bg(t.ansi2).flex().items_center().justify_center().text_color(t.chrome).child(svg(`${ICONS}/check.svg`).size(11))
      : task.status === "doing"
        ? div().size(18).rounded(9).border(2).border_color(t.working).flex().items_center().justify_center().child(div().size(6).rounded(3).bg(t.working))
        : div().size(18).rounded(9).border(1.5).border_color(t.input);
    return div().id(`mark-${task.id}`).size(26).flex_none().flex().items_center().justify_center().rounded(7).cursor_pointer()
      .tooltip(`${LABEL[task.status]}. Click to mark ${LABEL[next].toLowerCase()}`)
      .accessibility_label(`${LABEL[task.status]}. Mark ${LABEL[next].toLowerCase()}`)
      .hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.update(task.id, { status: next });
        cx.notify();
      })
      .child(face);
  }

  field(t, id, state, name) {
    return div().id(id).min_h(32).px(10).flex().items_center().flex_1().min_w(0).rounded(8).border(1)
      .border_color(this.focus === name ? t.accent : t.border).bg(t.background).cursor_text()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(Input.new(state).w_full().text_size(12.5).text_color(t.foreground));
  }

  label(t, text) {
    return div().px(2).text_size(11).font_medium().text_color(t.dim).child(text);
  }

  formCard(t) {
    const form = this.form;
    const ready = this.titleIn.value().trim().length > 0;
    return v_flex().id("task-form").flex_none().p(14).gap(12).rounded(10).border(1).border_color(t.accent + "88").bg(t.surface)
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(13).font_semibold().child(form.id ? "Edit task" : "New task"))
        .child(this.iconButton(t, "f-close", `${ICONS}/x.svg`, "Cancel", (cx) => { this.form = null; this.note = null; cx.notify(); })))
      .child(v_flex().gap(4).child(this.label(t, "Title")).child(h_flex().child(this.field(t, "f-title", this.titleIn, "title"))))
      .child(v_flex().gap(4).child(this.label(t, "Details · Markdown"))
        // The editor has padding of its own: this wrapper only adds what lines the text up with the single-line fields.
        .child(div().id("f-notes").h(132).px(5).py(4).rounded(8).border(1).border_color(this.focus === "notes" ? t.accent : t.border).bg(t.background).cursor_text()
          .overflow_hidden().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Editor.new(this.notesIn).size_full())))
      .child(v_flex().gap(6)
        .child(this.label(t, form.links.length ? `Links · ${form.links.length}` : "Links"))
        .child(h_flex().gap(6).items_center()
          .child(this.field(t, "f-link", this.linkIn, "link"))
          .child(this.button(t, "f-add-link", "Add", (cx) => this.addLink(cx))))
        .children(form.links.map((l, i) => h_flex().id(`f-link-${i}`).h(26).pl(9).pr(2).gap(6).items_center().rounded(6).bg(t.raised).text_size(11.5).text_color(t.muted)
          .child(svg("mods/studio-tasks/link.svg").size(11).flex_none().text_color(t.dim))
          .child(div().id(`f-link-text-${i}`).flex_1().min_w(0).truncate().tooltip(l).child(short(l)))
          .child(this.iconButton(t, `f-link-x-${i}`, `${ICONS}/x.svg`, "Remove link", (cx) => {
            form.links = form.links.filter((x) => x !== l);
            cx.notify();
          }, null, 22)))))
      .when(Boolean(this.note), (el) => el.child(div().text_size(11.5).text_color(this.note.ok ? t.ansi2 : t.blocked).child(this.note.text)))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().text_size(11).text_color(t.dim).child("Enter in the title saves · ⌘Enter in details saves"))
        .child(this.button(t, "f-cancel", "Cancel", (cx) => { this.form = null; this.note = null; cx.notify(); }))
        .child(div().id("f-save").h(26).px(14).flex().items_center().flex_none().rounded(7).text_size(12).font_medium()
          .accessibility_label("Save task").bg(ready ? t.solid : t.raised).text_color(ready ? t.solid_foreground : t.dim)
          .when(ready, (el) => el.cursor_pointer().hover((s) => s.bg(t.solid)).active((s) => s.bg(t.selected).text_color(t.foreground)))
          .on_click((_e, cx) => this.save(cx))
          .child("Save")));
  }

  card(t, task, now, live) {
    const open = this.open === task.id;
    const done = task.status === "done";
    const list = agents();
    const target = this.target(list);
    // A pick that is now the active agent is the same as following it.
    const following = !this.pick || this.pick === focused()?.terminal || !list.some((a) => a.address === this.pick);
    const agent = task.agent ? live.get(task.agent) : null;
    const targetName = target ? clean(target.title) || target.program?.name || "agent" : null;
    const accent = done ? t.ansi2 + "55" : task.status === "doing" ? (agent === "blocked" ? t.blocked : t.working) : t.chrome;
    const agentColor = agent === "working" ? t.working : agent === "blocked" ? t.blocked : agent === "done" ? t.done : null;
    const sending = this.sending === task.id;
    const confirming = this.confirm === task.id;
    return h_flex().id(`task-${task.id}`).w_full().flex_none().rounded(10).border(1).overflow_hidden()
      .border_color(open ? t.input : t.border).bg(open ? t.surface : t.chrome)
      // The whole card lights up while it is closed. An open card stays still: a band over
      // just its header would end halfway down, where the details begin.
      .when(!open, (el) => el.hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected)))
      // A stripe on the left says where the task stands before you read it.
      .child(div().w(3).flex_none().bg(accent))
      .child(v_flex().flex_1().min_w(0)
        .child(h_flex().id(`task-head-${task.id}`).pl(6).pr(12).py(10).gap(5).items_start().cursor_pointer()
          .accessibility_label(`${task.title}, ${LABEL[task.status]}. ${open ? "Collapse" : "Expand"}`)
          .on_click((_e, cx) => {
            this.open = open ? null : task.id;
            this.confirm = null;
            this.note = null;
            cx.notify();
          })
          .child(this.mark(t, task))
          .child(v_flex().flex_1().min_w(0).gap(7).pt(3)
            .child(h_flex().gap(8).items_start()
              .child(div().id(`task-title-${task.id}`).flex_1().min_w(0).when(!open, (el) => el.truncate()).tooltip(task.title)
                .text_size(13).font_medium().text_color(done ? t.dim : t.foreground).when(done, (el) => el.line_through()).child(task.title))
              .child(div().flex_none().text_size(11).text_color(t.dim).pt(1).child(ago(now - task.updated))))
            .when(!open && Boolean(task.notes), (el) => el.child(div().min_w(0).truncate().text_size(12).text_color(t.dim).child(preview(task.notes))))
            .when(task.links.length > 0 || Boolean(task.agent), (el) => el.child(h_flex().gap(5).items_center()
              .when(task.links.length > 0, (el) => el.child(this.pill(t, [svg("mods/studio-tasks/link.svg").size(10).flex_none(), `${task.links.length}`])))
              .when(Boolean(task.agent), (el) => el.child(h_flex().id(`task-agent-${task.id}`).h(18).px(7).gap(5).items_center().flex_none().rounded(9).bg(t.raised)
                .tooltip(agent ? `${task.agent} is ${agent}` : `${task.agent} is no longer running`)
                .child(div().size(6).rounded(3).flex_none().bg(agentColor ?? t.dim + "88"))
                .child(div().font_family(settings().font_family ?? "JetBrains Mono").text_size(10.5).text_color(agent ? t.muted : t.dim).child(task.agent))))))))
        .when(open, (el) => el.child(v_flex().pl(37).pr(12).pb(12).gap(12)
          .when(Boolean(task.notes), (el) => el.child(div().id(`task-notes-${task.id}`).p(10).rounded(8).bg(t.raised).text_size(12).text_color(t.muted)
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .child(TextView.markdown(`task-md-${task.id}`, task.notes).selectable(true))))
          .when(task.links.length > 0, (el) => el.child(v_flex().gap(4)
            .child(this.label(t, "Links"))
            .children(task.links.map((l, i) => h_flex().id(`task-link-${task.id}-${i}`).h(28).pl(9).pr(2).gap(6).items_center().rounded(7).border(1).border_color(t.border).bg(t.chrome)
              .cursor_pointer().accessibility_label(`Open ${short(l)}`)
              .hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected))
              .on_click((_e, cx) => cx.open_url(l))
              .child(svg("mods/studio-tasks/external.svg").size(11).flex_none().text_color(t.dim))
              .child(div().id(`task-link-text-${task.id}-${i}`).flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).tooltip(l).child(short(l)))
              .child(this.iconButton(t, `task-link-copy-${task.id}-${i}`, this.copied === `${task.id}-${i}` ? `${ICONS}/check.svg` : "mods/studio-tasks/copy.svg", this.copied === `${task.id}-${i}` ? "Copied" : "Copy link",
                (cx) => this.copyText(l, `${task.id}-${i}`, cx), this.copied === `${task.id}-${i}` ? t.ansi2 : null, 22))))))
          .when(Boolean(this.note) && !this.form, (el) => el.child(div().text_size(11.5).text_color(this.note.ok ? t.ansi2 : t.blocked).child(this.note.text)))
          .child(h_flex().gap(4).items_center()
            .child(h_flex().h(28).flex_none().rounded(7).overflow_hidden().bg(target ? t.solid : t.raised)
              .child(h_flex().id(`task-send-${task.id}`).h_full().pl(11).pr(9).gap(6).items_center().text_size(12).font_medium()
                .accessibility_label(target ? `Send to ${targetName}, ${target.address}` : "Send to the active agent")
                .text_color(target ? t.solid_foreground : t.dim)
                .when(Boolean(target), (el) => el.cursor_pointer().hover((s) => s.bg(t.solid_foreground + "14")).active((s) => s.bg(t.solid_foreground + "26")))
                .tooltip(target ? `${targetName} · ${target.address}${following ? " (active agent)" : ""}` : "Focus an agent terminal, or choose one")
                .on_click((_e, cx) => {
                  cx.stop_propagation();
                  this.send(task, cx);
                })
                .child(svg("mods/studio-tasks/send.svg").size(12).flex_none())
                .child(sending ? "Sending…" : target ? `Send to ${target.address}` : "Send to agent"))
              .child(div().w(1).h_full().flex_none().bg((target ? t.solid_foreground : t.dim) + "33"))
              .child(div().id(`task-send-menu-${task.id}`).h_full().w(26).flex_none().flex().items_center().justify_center()
                .text_color(target ? t.solid_foreground : t.muted).cursor_pointer().tooltip("Choose an agent")
                .accessibility_label(this.menuFor === task.id ? "Close agent list" : "Choose which agent to send to")
                .when(this.menuFor === task.id, (el) => el.bg((target ? t.solid_foreground : t.dim) + "26"))
                .hover((s) => s.bg((target ? t.solid_foreground : t.dim) + "1a")).active((s) => s.bg((target ? t.solid_foreground : t.dim) + "33"))
                .on_click((_e, cx) => {
                  cx.stop_propagation();
                  this.menuFor = this.menuFor === task.id ? null : task.id;
                  cx.notify();
                })
                .child(svg(`mods/studio-tasks/chevron-${this.menuFor === task.id ? "up" : "down"}.svg`).size(12))))
            .child(div().flex_1())
            .child(this.iconButton(t, `task-copy-${task.id}`, this.copied === task.id ? `${ICONS}/check.svg` : "mods/studio-tasks/copy.svg", this.copied === task.id ? "Copied" : "Copy brief to paste into a prompt",
              (cx) => this.copyBrief(task, cx), this.copied === task.id ? t.ansi2 : null))
            .child(this.iconButton(t, `task-edit-${task.id}`, `${ICONS}/square-pen.svg`, "Edit", (cx) => this.edit(task, cx)))
            .child(confirming
              ? h_flex().id(`task-del-${task.id}`).h(24).px(9).items_center().flex_none().rounded(6).bg(t.blocked + "26").text_size(11.5).font_medium().text_color(t.blocked)
                .cursor_pointer().accessibility_label("Confirm delete").hover((s) => s.bg(t.blocked + "3a")).active((s) => s.bg(t.blocked + "4d"))
                .on_click((_e, cx) => {
                  cx.stop_propagation();
                  this.remove(task, cx);
                })
                .child("Delete?")
              : this.iconButton(t, `task-del-${task.id}`, "mods/studio-tasks/trash.svg", "Delete", (cx) => this.remove(task, cx))))
          .when(this.menuFor === task.id, (el) => el.child(this.agentMenu(t, task, list, target, following))))));
  }

  // The agents to send to, most urgent first. The first row goes back to following the active one.
  agentMenu(t, task, list, target, following) {
    const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
    const active = list.find((a) => a.address === focused()?.terminal);
    // The active agent has its own first row, so it isn't listed again below.
    const sorted = list.filter((a) => a !== active).sort((x, y) => (RANK[y.status] ?? 0) - (RANK[x.status] ?? 0));
    const mono = settings().font_family ?? "JetBrains Mono";
    const dot = (a) => a.status === "blocked"
      ? div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!")
      : a.status === "working"
        ? svg(`${ICONS}/spinner.svg`).size(12).flex_none().text_color(t.working).spin(900)
        : div().size(14).flex_none().flex().items_center().justify_center()
          .child(a.status === "done" ? div().size(7).rounded(4).bg(t.done) : div().size(7).rounded(4).border(1.5).border_color(t.idle ?? t.dim));
    const row = (id, a, label, picked, action) => h_flex().id(id).h(30).px(8).gap(8).items_center().flex_none().rounded(6).cursor_pointer()
      .accessibility_label(`${label}${picked ? ", selected" : ""}`)
      .when(picked, (el) => el.bg(t.selected)).hover((s) => s.bg(picked ? t.selected : t.hover)).active((s) => s.bg(t.selected))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        action();
        this.menuFor = null;
        cx.notify();
      })
      .child(a ? (a.program?.icon ? (a.program.tint ? svg(a.program.icon).size(14).flex_none().text_color(t.foreground) : image(a.program.icon).size(14).flex_none()) : div().size(14).flex_none()) : svg(`${ICONS}/terminal.svg`).size(14).flex_none().text_color(t.muted))
      .child(div().id(`${id}-name`).flex_1().min_w(0).truncate().text_size(12.5).tooltip(label).child(label))
      .when(Boolean(a), (el) => el.child(div().flex_none().h(16).px(4).flex().items_center().rounded(4).bg(t.raised).text_color(t.dim).font_family(mono).text_size(10.5).child(a.address)))
      .when(Boolean(a), (el) => el.child(dot(a)))
      .child(div().w(12).flex_none().flex().items_center().justify_center().when(picked, (el) => el.child(svg(`${ICONS}/check.svg`).size(12).text_color(t.foreground))));
    // A scroll area needs a definite height: rows are 30px with a 1px gap, plus the divider and padding.
    const height = Math.min(240, 8 + (sorted.length + 1) * 31 + (sorted.length ? 7 : 0) + (sorted.length ? 0 : 36));
    return v_flex().id(`task-menu-${task.id}`).h(height).flex_none().p(4).gap(1).rounded(8).border(1).border_color(t.border).bg(t.popover).overflow_y_scrollbar()
      .child(row(`menu-follow-${task.id}`, null, active ? `Active agent · ${clean(active.title) || active.program?.name || active.address}` : "Active agent (none focused)", following,
        () => { this.pick = null; }))
      .when(sorted.length > 0, (el) => el.child(div().h(1).my(3).bg(t.border).flex_none()))
      .when(!sorted.length, (el) => el.child(div().p(8).text_size(12).text_color(t.dim).child("No agents running")))
      .children(sorted.map((a) => row(`menu-${task.id}-${a.address}`, a, clean(a.title) || a.program?.name || a.address, !following && target?.address === a.address,
        () => { this.pick = a.address; })));
  }

  section(t, label, n, color, action, open) {
    return h_flex().id(`sec-${label}`).h(28).px(2).mt(8).gap(7).items_center().flex_none().text_size(11.5).font_medium().rounded(6)
      .text_color(t.muted).when(Boolean(action), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected))
        .on_click((_e, cx) => { action(); cx.notify(); }))
      .child(div().size(7).rounded(4).flex_none().bg(color))
      .child(div().child(label))
      .child(div().text_color(t.dim).child(String(n)))
      .when(Boolean(action), (el) => el.child(div().flex_1()).child(svg(`${ICONS}/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none().text_color(t.dim)));
  }

  // How the work splits: done, doing, to do, as a thin bar.
  progress(t, doing, todo, done) {
    const total = doing + todo + done;
    if (!total) return null;
    const seg = (n, color) => n ? div().h_full().w(`${(n / total) * 100}%`).bg(color) : null;
    return h_flex().h(4).rounded(2).overflow_hidden().bg(t.raised).children([seg(done, t.ansi2), seg(doing, t.working), seg(todo, t.dim)].filter(Boolean));
  }

  // One of the filter buttons: a dot in the status colour, its name and how many tasks it holds.
  chip(t, id, label, count, color, on, action) {
    const empty = count === 0 && !on;
    return h_flex().id(`chip-${id}`).flex_1().min_w(0).h(28).gap(6).items_center().justify_center().rounded(7).text_size(11.5).font_medium()
      .border(1).border_color(on ? (color ?? t.input) + "88" : t.border).bg(on ? (color ?? t.muted) + "1f" : t.chrome)
      .text_color(empty ? t.dim : on ? t.foreground : t.muted)
      .tooltip(on ? `${label} (click to clear)` : label).accessibility_label(`${label}, ${count}. ${on ? "Clear filter" : "Show only these"}`)
      .when(!empty, (el) => el.cursor_pointer().hover((s) => s.bg(on ? (color ?? t.muted) + "2a" : t.hover)).active((s) => s.bg(t.selected))
        .on_click((_e, cx) => {
          action();
          cx.notify();
        }))
      .when(Boolean(color), (el) => el.child(div().size(6).rounded(3).flex_none().bg(empty ? color + "55" : color)))
      .child(div().truncate().child(label))
      .child(div().text_color(t.dim).child(String(count)));
  }

  render() {
    const t = theme();
    const now = Date.now();
    const live = new Map(agents().map((a) => [a.address, a.status]));
    const by = (status) => this.tasks.filter((x) => x.status === status).sort((a, b) => b.updated - a.updated);
    const doing = by("doing"), todo = by("todo"), done = by("done");
    const empty = this.ready && !this.tasks.length && !this.form;
    const f = this.filter;
    const filtered = Boolean(f);
    const set = (value) => () => { this.filter = this.filter === value ? null : value; };
    const shown = (group, id) => (!f || f === id ? group : []);
    const showDone = this.showDone || f === "done";
    return v_flex().size_full().min_w(0).min_h(0).bg(t.chrome).text_color(t.foreground).text_size(13)
      .child(v_flex().flex_none().px(12).pt(14).pb(12).gap(12).border_b(1).border_color(t.border)
        .child(h_flex().items_center().gap(8).px(2)
          .child(div().text_size(13).font_semibold().child("Tasks"))
          .child(div().flex_1())
          .child(this.iconButton(t, "task-new", `${ICONS}/plus.svg`, "New task with details and links", (cx) => this.edit(null, cx))))
        .when(this.tasks.length > 0, (el) => el.child(this.progress(t, doing.length, todo.length, done.length)))
        .when(this.tasks.length > 0, (el) => el.child(h_flex().gap(6)
          .child(this.chip(t, "todo", "To do", todo.length, t.dim, f === "todo", set("todo")))
          .child(this.chip(t, "doing", "Doing", doing.length, t.working, f === "doing", set("doing")))
          .child(this.chip(t, "done", "Done", done.length, t.ansi2, f === "done", set("done")))))
        .child(h_flex().child(this.field(t, "task-quick", this.quickIn, "quick"))))
      .child(v_flex().id("tasks-scroll").flex_1().min_h(0).px(12).pt(6).pb(14).gap(8).overflow_y_scrollbar()
        .when(Boolean(this.form), (el) => el.child(this.formCard(t)))
        .when(!this.ready, (el) => el.child(div().px(4).py(10).text_color(t.dim).child("Loading…")))
        .when(empty, (el) => el.child(v_flex().items_center().px(16).py(28).gap(10)
          .child(div().size(44).rounded(12).bg(t.raised).flex().items_center().justify_center().text_color(t.dim).child(svg("mods/studio-tasks/list-todo.svg").size(22)))
          .child(div().text_size(14).font_medium().child("Nothing queued"))
          .child(div().text_size(12).text_color(t.dim).text_center().whitespace_normal().child("Type a task above and press Enter. Use + to add details and links, then send it to an agent as context."))))
        .when(filtered && this.ready && this.tasks.length > 0 && !shown(by(f), f).length, (el) => el.child(v_flex().px(4).py(10).gap(8)
          .child(div().text_color(t.muted).child(`No ${LABEL[f].toLowerCase()} tasks`))
          .child(this.button(t, "filter-clear", "Show all", (cx) => { this.filter = null; cx.notify(); }).self_start())))
        // With a filter on, the one group shows without its heading.
        .when(!filtered && doing.length > 0, (el) => el.child(this.section(t, "Doing", doing.length, t.working)))
        .children(shown(doing, "doing").map((x) => this.card(t, x, now, live)))
        .when(!filtered && todo.length > 0, (el) => el.child(this.section(t, "To do", todo.length, t.dim)))
        .children(shown(todo, "todo").map((x) => this.card(t, x, now, live)))
        .when(!filtered && done.length > 0, (el) => el.child(this.section(t, "Done", done.length, t.ansi2, () => { this.showDone = !this.showDone; }, this.showDone)))
        .when(!filtered ? this.showDone : f === "done", (el) => el.children(done.map((x) => this.card(t, x, now, live)))));
  }
}
