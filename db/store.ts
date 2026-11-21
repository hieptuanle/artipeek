// Decision hub store: opens (and migrates) the SQLite file, validates what agents send, reads decisions with their
// notes, links and answers. Used by server.ts, cli.ts and scripts/import-decisions.ts.
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { and, eq, inArray, desc, asc, or, lt, isNotNull, sql, type SQL } from "drizzle-orm";
import { mkdirSync, existsSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as s from "./schema.ts";
import { STATUSES, ACTION_STATUSES, type DecisionStatus, type EditStatus, type ActionStatus, type StepState, type Question, type Link } from "./schema.ts";

export const ID_RE = /^[A-Za-z][A-Za-z0-9._-]{0,31}$/;
export const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/;

export type Decision = typeof s.decisions.$inferSelect;
export type Note = typeof s.notes.$inferSelect;
export type Answer = typeof s.answers.$inferSelect;
export type Edit = typeof s.edits.$inferSelect;
export type Ref = { project: string; id: string; title?: string; status?: DecisionStatus };
export type ActionRef = { project: string; id: string; title: string; status: ActionStatus };
export type Full = Decision & {
  notes: Note[];
  from: Ref[]; dependsOn: Ref[]; // this decision → others
  ledTo: Ref[]; neededBy: Ref[]; // others → this decision
  answers: Answer[]; // newest first, at most 20
  actions: ActionRef[]; // actions that came out of this decision
};
export type Action = typeof s.actions.$inferSelect;
export type Step = typeof s.actionSteps.$inferSelect;
export type Signal = typeof s.actionSignals.$inferSelect;
export type FullAction = Action & { steps: Step[]; from: Ref[]; signals: Signal[] /* newest first, at most 20 */ };
export type StepInput = { text?: string; command?: string | null; where?: string | null; links?: Link[] } | string;
// What an agent may send for an action (create: title and steps required; update: any subset).
export type ActionInput = {
  id?: string; title?: string; lane?: string | null; context?: string; links?: Link[]; deadline?: string | null;
  urgent?: boolean; steps?: StepInput[]; from?: string[];
};
// What an agent may send (create: title required; update: any subset). Relations as "D12" or "other-project:D12".
export type Input = {
  id?: string; title?: string; lane?: string | null; context?: string; questions?: Question[];
  deadline?: string | null; deadlineNote?: string | null; ifNoAnswer?: string | null; urgent?: boolean;
  links?: Link[]; status?: DecisionStatus; resolution?: string | null; explainerPath?: string | null;
  from?: string[]; dependsOn?: string[];
};

// Which decisions a page asks for. urgentAt: only open ones with the flag or a deadline before that time.
export type ListOpts = { projects?: string[]; statuses?: string[]; urgentAt?: string; newestFirst?: boolean; limit?: number; offset?: number };

export class InputError extends Error {}
const bad = (m: string): never => { throw new InputError(m); };
const now = () => new Date().toISOString();
const hash = (t: string) => createHash("sha256").update(t).digest("hex");
export const sha256 = hash;

// What an edit request says to the agent, in the answers file and in GET /api/answers (kind "edit"). It always starts
// with EDIT:, so a desk that reads only the text can't take it for an answer to a decision.
export function editLine(e: Edit, what: "sent" | "withdrawn" = "sent"): string {
  if (what === "withdrawn") return `EDIT: ${e.id} withdrawn: leave ${e.path} as it is.`;
  const note = e.note ? ` (note: ${e.note.length > 1000 ? e.note.slice(0, 1000) + "…" : e.note})` : "";
  return `EDIT: ${e.path}${e.replaces ? `, replaces ${e.replaces}` : ""}${note}. Update the file yourself: artipeek-decide edit show ${e.id}`;
}

function str(v: unknown, name: string, max: number, opt = true): string | null {
  if (v === undefined || v === null || v === "") return opt ? null : bad(`${name} is required`);
  if (typeof v !== "string") return bad(`${name} must be text`);
  const t = v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (!t) return opt ? null : bad(`${name} is required`);
  if (t.length > max) bad(`${name} is longer than ${max} characters`);
  return t;
}
// A link may point to the web, or to a file of an artipeek folder (/r/<folder>/... or a path in this project).
export function checkHref(h: string): boolean {
  if (/^https?:\/\/[^\s]+$/i.test(h)) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith("//") || h.includes("\\") || /\s/.test(h)) return false;
  return h.split(/[?#]/)[0].split("/").every((p, i) => i === 0 && p === "" ? h.startsWith("/") : p !== "..");
}
export function checkRelPath(p: string): boolean {
  return !!p && !p.startsWith("/") && !p.includes("\\") && !p.includes("\0") && p.split("/").every((x) => x && x !== "." && x !== ".." && x !== ".git");
}
function checkQuestions(v: unknown): Question[] {
  if (!Array.isArray(v)) return bad("questions must be a list");
  if (v.length > 10) bad("at most 10 questions");
  const keys = new Set<string>();
  return v.map((q: any, i) => {
    if (!q || typeof q !== "object") bad(`question ${i + 1}: must be an object`);
    let key = str(q.key, `question ${i + 1} key`, 16) ?? "";
    if (!key && v.length > 1) key = `Q${i + 1}`;
    if (key && !KEY_RE.test(key)) bad(`question ${i + 1}: key "${key}" must be letters/digits (e.g. Q1)`);
    if (key && keys.has(key)) bad(`question key ${key} is used twice`);
    keys.add(key);
    if (!Array.isArray(q.options) || !q.options.length) bad(`question ${key || i + 1}: needs options`);
    if (q.options.length > 12) bad(`question ${key || i + 1}: at most 12 options`);
    const values = new Set<string>();
    const options = q.options.map((o: any, j: number) => {
      const value = str(o?.value, `option ${j + 1} value`, 16, false)!;
      if (!KEY_RE.test(value)) bad(`option value "${value}" must be letters/digits (e.g. A)`);
      if (values.has(value)) bad(`option ${value} is used twice in question ${key || i + 1}`);
      values.add(value);
      const label = str(o.label, `option ${value} label`, 1000, false)!;
      const effect = str(o.effect, `option ${value} effect`, 2000);
      return { value, label, ...(o.recommended === true ? { recommended: true } : {}), ...(effect ? { effect } : {}) };
    });
    const text = str(q.text, `question ${key || i + 1} text`, 2000);
    return { ...(key ? { key } : {}), ...(text ? { text } : {}), options };
  });
}
function checkLinks(v: unknown): Link[] {
  if (!Array.isArray(v)) return bad("links must be a list");
  if (v.length > 30) bad("at most 30 links");
  return v.map((l: any, i) => {
    const href = str(l?.href, `link ${i + 1} href`, 2000, false)!;
    if (!checkHref(href)) bad(`link ${i + 1}: only http(s) links or paths in an artipeek folder`);
    return { label: str(l.label, `link ${i + 1} label`, 200) ?? href, href };
  });
}
function checkSteps(v: unknown) {
  if (!Array.isArray(v)) return bad("steps must be a list");
  if (!v.length) bad("an action needs at least one step");
  if (v.length > 30) bad("at most 30 steps");
  return v.map((x: any, i) => {
    if (typeof x === "string") x = { text: x };
    if (!x || typeof x !== "object") bad(`step ${i + 1}: must be text or an object`);
    const text = str(x.text, `step ${i + 1} text`, 4000, false)!;
    return { text, command: str(x.command, `step ${i + 1} command`, 4000), where: str(x.where, `step ${i + 1} where`, 300), links: x.links === undefined || x.links === null ? [] : checkLinks(x.links) };
  });
}
export function parseDeadline(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string") return bad("deadline must be text (ISO date and time)");
  const t = Date.parse(v.trim());
  if (Number.isNaN(t)) bad(`deadline "${v}" is not a date (use e.g. 2026-11-21T18:00+07:00)`);
  return new Date(t).toISOString();
}
export function parseRef(r: unknown, project: string): { toProject: string; toId: string } {
  if (typeof r !== "string") return bad("a related decision must be text like D12 or project:D12");
  const m = /^(?:([A-Za-z0-9][A-Za-z0-9._-]{0,63}):)?([A-Za-z][A-Za-z0-9._-]{0,31})$/.exec(r.trim());
  if (!m) return bad(`"${r}" is not a decision id (D12 or project:D12)`);
  return { toProject: m[1] ?? project, toId: m[2] };
}

// Turns agent input into column values (only the fields given). Throws InputError with a plain reason.
function columns(inp: Input, creating: boolean) {
  if (!inp || typeof inp !== "object" || Array.isArray(inp)) bad("send a JSON object");
  const o: Partial<typeof s.decisions.$inferInsert> = {};
  const has = (k: keyof Input) => Object.prototype.hasOwnProperty.call(inp, k);
  if (creating || has("title")) o.title = str(inp.title, "title", 300, false)!;
  if (has("lane")) o.lane = str(inp.lane, "lane", 60);
  if (has("context")) o.context = str(inp.context, "context", 60_000) ?? "";
  if (has("questions")) o.questions = checkQuestions(inp.questions);
  if (has("deadline")) o.deadline = parseDeadline(inp.deadline);
  if (has("deadlineNote")) o.deadlineNote = str(inp.deadlineNote, "deadlineNote", 300);
  if (has("ifNoAnswer")) o.ifNoAnswer = str(inp.ifNoAnswer, "ifNoAnswer", 2000);
  if (has("urgent")) { if (typeof inp.urgent !== "boolean") bad("urgent must be true or false"); o.urgent = inp.urgent; }
  if (has("links")) o.links = checkLinks(inp.links);
  if (has("status")) { if (!STATUSES.includes(inp.status as DecisionStatus)) bad(`status must be one of ${STATUSES.join(", ")}`); o.status = inp.status; }
  if (has("resolution")) o.resolution = str(inp.resolution, "resolution", 4000);
  if (has("explainerPath")) {
    const p = str(inp.explainerPath, "explainerPath", 400);
    if (p && !checkRelPath(p)) bad("explainerPath must be a path inside the project folder, like docs/d15.html");
    o.explainerPath = p;
    if (p) o.explainerRequestedAt = null; // the request is done
  }
  return o;
}

export class Hub {
  readonly db;
  private listeners = new Set<(project: string, id: string | null) => void>();
  constructor(readonly sqlite: Database) {
    this.db = drizzle(sqlite, { schema: s });
  }
  // Something changed (id null: many things, e.g. an outside writer). Called after each write.
  onChange(fn: (project: string, id: string | null) => void) { this.listeners.add(fn); }
  private changed(project: string, id: string | null) { for (const f of this.listeners) { try { f(project, id); } catch {} } }
  // Changes when another connection (an import, the admin CLI) writes the file.
  dataVersion(): number { return Number((this.sqlite.query("PRAGMA data_version").get() as any).data_version); }

  // ----- tokens -----
  newToken(project: string): string {
    if (!PROJECT_RE.test(project)) bad("bad project name");
    const tok = "apk_" + randomBytes(24).toString("base64url");
    this.db.insert(s.projects).values({ name: project, tokenHash: hash(tok), createdAt: now() })
      .onConflictDoUpdate({ target: s.projects.name, set: { tokenHash: hash(tok) } }).run();
    return tok;
  }
  revokeToken(project: string) { this.db.update(s.projects).set({ tokenHash: null }).where(eq(s.projects.name, project)).run(); }
  tokenOk(project: string, tok: string): boolean {
    const row = this.db.select().from(s.projects).where(eq(s.projects.name, project)).get();
    if (!row?.tokenHash || !tok) return false;
    const a = Buffer.from(row.tokenHash, "hex"), b = Buffer.from(hash(tok), "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  }
  hasToken(project: string): boolean {
    return !!this.db.select({ t: s.projects.tokenHash }).from(s.projects).where(eq(s.projects.name, project)).get()?.t;
  }
  projectsWithTokens(): { name: string; hasToken: boolean; createdAt: string }[] {
    return this.db.select().from(s.projects).all().map((p) => ({ name: p.name, hasToken: !!p.tokenHash, createdAt: p.createdAt }));
  }

  // ----- read -----
  private full(rows: Decision[]): Full[] {
    if (!rows.length) return [];
    const projects = [...new Set(rows.map((r) => r.project))];
    const want = new Set(rows.map((r) => `${r.project}\u0000${r.id}`));
    const k = (p: string, id: string) => `${p}\u0000${id}`;
    const ids = [...new Set(rows.map((r) => r.id))]; // with projects: a small superset of the rows asked for
    const notes = this.db.select().from(s.notes).where(and(inArray(s.notes.project, projects), inArray(s.notes.decisionId, ids))).orderBy(asc(s.notes.seq)).all();
    const rels = this.db.select().from(s.relations).where(or(and(inArray(s.relations.project, projects), inArray(s.relations.decisionId, ids)), and(inArray(s.relations.toProject, projects), inArray(s.relations.toId, ids)))).all();
    const ans = this.db.select().from(s.answers).where(and(inArray(s.answers.project, projects), inArray(s.answers.decisionId, ids))).orderBy(desc(s.answers.at)).all();
    // titles/statuses of every decision a relation points at (may be in another project)
    const ends = new Set<string>();
    for (const r of rels) { ends.add(k(r.project, r.decisionId)); ends.add(k(r.toProject, r.toId)); }
    const meta = new Map<string, { title: string; status: DecisionStatus }>();
    const endProjects = [...new Set([...ends].map((e) => e.split("\u0000")[0]))];
    if (endProjects.length)
      for (const d of this.db.select({ project: s.decisions.project, id: s.decisions.id, title: s.decisions.title, status: s.decisions.status }).from(s.decisions).where(inArray(s.decisions.project, endProjects)).all())
        meta.set(k(d.project, d.id), { title: d.title, status: d.status });
    const ref = (p: string, id: string): Ref => ({ project: p, id, ...meta.get(k(p, id)) });
    const by = new Map<string, Full>();
    const out = rows.map((r) => { const f: Full = { ...r, notes: [], from: [], dependsOn: [], ledTo: [], neededBy: [], answers: [], actions: [] }; by.set(k(r.project, r.id), f); return f; });
    const arels = this.db.select().from(s.actionRelations).where(and(inArray(s.actionRelations.toProject, projects), inArray(s.actionRelations.toId, ids))).all();
    if (arels.length) {
      const am = new Map<string, { title: string; status: ActionStatus }>();
      for (const a of this.db.select({ project: s.actions.project, id: s.actions.id, title: s.actions.title, status: s.actions.status }).from(s.actions).where(inArray(s.actions.project, [...new Set(arels.map((r) => r.project))])).all())
        am.set(k(a.project, a.id), a);
      for (const r of arels) { const f = by.get(k(r.toProject, r.toId)), m = am.get(k(r.project, r.actionId)); if (f && m) f.actions.push({ project: r.project, id: r.actionId, ...m }); }
    }
    for (const n of notes) by.get(k(n.project, n.decisionId))?.notes.push(n);
    for (const r of rels) {
      const a = by.get(k(r.project, r.decisionId)), b = by.get(k(r.toProject, r.toId));
      if (a) (r.kind === "from" ? a.from : a.dependsOn).push(ref(r.toProject, r.toId));
      if (b && want.has(k(r.toProject, r.toId))) (r.kind === "from" ? b.ledTo : b.neededBy).push(ref(r.project, r.decisionId));
    }
    for (const a of ans) { const f = by.get(k(a.project, a.decisionId)); if (f && f.answers.length < 20) f.answers.push(a); }
    return out;
  }
  private where(opts: ListOpts): SQL | undefined | null {
    const conds: SQL[] = [];
    if (opts.projects) { if (!opts.projects.length) return null; conds.push(inArray(s.decisions.project, opts.projects)); }
    if (opts.statuses?.length) conds.push(inArray(s.decisions.status, opts.statuses as DecisionStatus[]));
    if (opts.urgentAt) conds.push(eq(s.decisions.status, "open"), or(eq(s.decisions.urgent, true), and(isNotNull(s.decisions.deadline), lt(s.decisions.deadline, opts.urgentAt)))!);
    return conds.length ? and(...conds) : undefined;
  }
  // The order they were raised in (or newest first), a page at a time. Same raise time (an import): D2 before D10.
  list(opts: ListOpts = {}): Full[] {
    const w = this.where(opts);
    if (w === null) return [];
    const dir = opts.newestFirst ? desc : asc;
    let q = this.db.select().from(s.decisions).where(w)
      .orderBy(dir(s.decisions.createdAt), asc(s.decisions.project), dir(sql`length(${s.decisions.id})`), dir(s.decisions.id)).$dynamic();
    if (opts.limit) q = q.limit(opts.limit).offset(opts.offset ?? 0);
    return this.full(q.all());
  }
  count(opts: ListOpts = {}): number {
    const w = this.where(opts);
    if (w === null) return 0;
    return Number(this.db.select({ n: sql<number>`count(*)` }).from(s.decisions).where(w).get()?.n ?? 0);
  }
  // Latest answer per decision since a time, for answer buttons in a folder's own pages (explainers).
  recentAnswers(project: string, since: string): { id: string; text: string; at: string; uid: string }[] {
    const latest = new Map<string, { id: string; text: string; at: string; uid: string }>();
    for (const a of this.db.select().from(s.answers).where(and(eq(s.answers.project, project), eq(s.answers.kind, "answer"))).orderBy(asc(s.answers.at)).all())
      if (a.at >= since) latest.set(a.decisionId, { id: a.decisionId, text: a.text, at: a.at, uid: a.uid });
    return [...latest.values()];
  }
  get(project: string, id: string): Full | null {
    const r = this.db.select().from(s.decisions).where(and(eq(s.decisions.project, project), eq(s.decisions.id, id))).get();
    return r ? this.full([r])[0] : null;
  }
  has(project: string, id: string): boolean {
    return !!this.db.select({ id: s.decisions.id }).from(s.decisions).where(and(eq(s.decisions.project, project), eq(s.decisions.id, id))).get();
  }
  // How many decisions each project has per status.
  counts(projects: string[]): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    if (!projects.length) return out;
    for (const r of this.sqlite.query(`SELECT project, status, count(*) AS n FROM decisions WHERE project IN (${projects.map(() => "?").join(",")}) GROUP BY project, status`).all(...projects) as any[])
      (out[r.project] ??= {})[r.status] = r.n;
    return out;
  }
  answersSince(project: string, since?: string): Answer[] {
    const rows = this.db.select().from(s.answers).where(eq(s.answers.project, project)).orderBy(asc(s.answers.at)).all();
    return since ? rows.filter((a) => a.at > since) : rows;
  }

  // ----- write -----
  // The next free id: the most used prefix in the project (D, F, H…) and one more than its highest number.
  nextId(project: string): string {
    const ids = this.db.select({ id: s.decisions.id }).from(s.decisions).where(eq(s.decisions.project, project)).all().map((r) => r.id);
    const per = new Map<string, number[]>();
    for (const id of ids) { const m = /^([A-Za-z]+)(\d+)$/.exec(id); if (m) { if (!per.has(m[1])) per.set(m[1], []); per.get(m[1])!.push(Number(m[2])); } }
    let prefix = "D";
    for (const [p, ns] of per) if (ns.length > (per.get(prefix)?.length ?? 0)) prefix = p;
    let n = Math.max(0, ...(per.get(prefix) ?? [])) + 1;
    while (this.editHas(project, `${prefix}${n}`) || this.actionHas(project, `${prefix}${n}`)) n++; // E ids may be edit requests, A ids actions
    return `${prefix}${n}`;
  }
  create(project: string, inp: Input, opts: { createdAt?: string } = {}): string {
    if (!PROJECT_RE.test(project)) bad("bad project name");
    const id = inp.id === undefined || inp.id === null || inp.id === "" ? this.nextId(project) : String(inp.id).trim();
    if (!ID_RE.test(id)) bad(`id "${id}" must start with a letter (e.g. D15)`);
    const cols = columns(inp, true);
    const at = opts.createdAt ?? now();
    this.sqlite.transaction(() => {
      if (this.has(project, id)) bad(`${id} already exists in ${project}; ids are never reused (update it, or leave out id for the next free one)`);
      if (this.editHas(project, id)) bad(`${id} is an edit request in ${project}; leave out id for the next free one`);
      if (this.actionHas(project, id)) bad(`${id} is an action in ${project}; leave out id for the next free one`);
      this.db.insert(s.decisions).values({ ...cols, title: cols.title!, project, id, createdAt: at, updatedAt: at }).run();
      this.setRelations(project, id, inp);
    })();
    this.changed(project, id);
    return id;
  }
  update(project: string, id: string, inp: Input): void {
    const cols = columns(inp, false);
    delete (cols as any).id;
    this.sqlite.transaction(() => {
      if (!this.has(project, id)) bad(`${id} does not exist in ${project}`);
      this.db.update(s.decisions).set({ ...cols, updatedAt: now() }).where(and(eq(s.decisions.project, project), eq(s.decisions.id, id))).run();
      this.setRelations(project, id, inp);
    })();
    this.changed(project, id);
  }
  // Replaces the "from" and/or "dependsOn" lists that are present in the input.
  private setRelations(project: string, id: string, inp: Input) {
    for (const [field, kind] of [["from", "from"], ["dependsOn", "depends_on"]] as const) {
      const list = inp[field];
      if (list === undefined) continue;
      if (!Array.isArray(list)) bad(`${field} must be a list like ["D12"]`);
      if (list.length > 30) bad(`${field}: at most 30`);
      const refs = list.map((r) => parseRef(r, project));
      if (refs.some((r) => r.toProject === project && r.toId === id)) bad(`${id} can't point at itself`);
      this.db.delete(s.relations).where(and(eq(s.relations.project, project), eq(s.relations.decisionId, id), eq(s.relations.kind, kind))).run();
      for (const r of refs) this.db.insert(s.relations).values({ project, decisionId: id, kind, ...r }).onConflictDoNothing().run();
    }
  }
  addNote(project: string, id: string, inp: { body?: unknown; kind?: unknown }, opts: { at?: string } = {}): number {
    const body = str(inp?.body, "body", 20_000, false)!;
    const kind = inp.kind === undefined || inp.kind === "update" ? "update" : inp.kind === "done" ? "done" : bad('kind must be "update" or "done"');
    let seq = 0;
    this.sqlite.transaction(() => {
      if (!this.has(project, id)) bad(`${id} does not exist in ${project}`);
      const at = opts.at ?? now();
      seq = Number(this.db.insert(s.notes).values({ project, decisionId: id, at, kind, body }).run().lastInsertRowid);
      this.db.update(s.decisions).set({ updatedAt: at }).where(and(eq(s.decisions.project, project), eq(s.decisions.id, id))).run();
    })();
    this.changed(project, id);
    return seq;
  }
  // The person's answer from artipeek's page (checked by the server). An answer moves the decision to "answered";
  // an explainer request only marks it (the decision stays open until answered).
  recordAnswer(a: { uid: string; project: string; decisionId: string; at: string; by: string; kind: "answer" | "explain"; text: string; page: string }) {
    this.sqlite.transaction(() => {
      this.db.insert(s.answers).values(a).run();
      const where = and(eq(s.decisions.project, a.project), eq(s.decisions.id, a.decisionId));
      if (a.kind === "explain") this.db.update(s.decisions).set({ explainerRequestedAt: a.at, updatedAt: a.at }).where(where).run();
      else this.db.update(s.decisions).set({ status: "answered", updatedAt: a.at }).where(where).run();
    })();
    this.changed(a.project, a.decisionId);
  }

  // ----- edit requests (see schema.ts) -----
  private editListeners = new Set<(project: string, path: string) => void>();
  // An edit request was sent, replaced or resolved: the file's mark changes.
  onEdit(fn: (project: string, path: string) => void) { this.editListeners.add(fn); }
  private editChanged(project: string, p: string) { for (const f of this.editListeners) { try { f(project, p); } catch {} } }
  private editHas(project: string, id: string): boolean {
    return !!this.db.select({ id: s.edits.id }).from(s.edits).where(and(eq(s.edits.project, project), eq(s.edits.id, id))).get();
  }
  nextEditId(project: string): string {
    let n = 0;
    for (const r of this.db.select({ id: s.edits.id }).from(s.edits).where(eq(s.edits.project, project)).all()) { const m = /^E(\d+)$/.exec(r.id); if (m) n = Math.max(n, Number(m[1])); }
    n++;
    while (this.has(project, `E${n}`) || this.actionHas(project, `E${n}`)) n++; // a folder whose decisions use E
    return `E${n}`;
  }
  edit(project: string, id: string): Edit | null {
    return this.db.select().from(s.edits).where(and(eq(s.edits.project, project), eq(s.edits.id, id))).get() ?? null;
  }
  // Newest first.
  edits(project: string, statuses?: EditStatus[]): Edit[] {
    const w = statuses?.length ? and(eq(s.edits.project, project), inArray(s.edits.status, statuses)) : eq(s.edits.project, project);
    return this.db.select().from(s.edits).where(w).orderBy(desc(s.edits.createdAt), desc(sql`length(${s.edits.id})`), desc(s.edits.id)).all();
  }
  pendingEdit(project: string, p: string): Edit | null {
    return this.db.select().from(s.edits).where(and(eq(s.edits.project, project), eq(s.edits.path, p), eq(s.edits.status, "pending"))).orderBy(desc(s.edits.createdAt)).get() ?? null;
  }
  // path → id of the pending edit, for the marks in the file list.
  pendingPaths(project: string): Map<string, string> {
    return new Map(this.db.select({ path: s.edits.path, id: s.edits.id }).from(s.edits).where(and(eq(s.edits.project, project), eq(s.edits.status, "pending"))).all().map((r) => [r.path, r.id]));
  }
  // The edit a file's page shows: its pending one, else the last one the agent resolved since `since`.
  shownEdit(project: string, p: string, since: string): Edit | null {
    return this.pendingEdit(project, p) ?? this.db.select().from(s.edits)
      .where(and(eq(s.edits.project, project), eq(s.edits.path, p), inArray(s.edits.status, ["done", "declined"]), sql`${s.edits.updatedAt} >= ${since}`))
      .orderBy(desc(s.edits.updatedAt)).get() ?? null;
  }
  // The person's edit (checked by the server). A pending edit of the same file becomes superseded.
  createEdit(e: { project: string; path: string; base: string; text: string; note: string | null; by: string; at?: string }): Edit {
    if (!PROJECT_RE.test(e.project)) bad("bad project name");
    if (!checkRelPath(e.path)) bad("bad path");
    const at = e.at ?? now();
    let out: Edit | null = null;
    this.sqlite.transaction(() => {
      const old = this.pendingEdit(e.project, e.path);
      if (old) this.db.update(s.edits).set({ status: "superseded", updatedAt: at }).where(and(eq(s.edits.project, e.project), eq(s.edits.id, old.id))).run();
      const row = { project: e.project, id: this.nextEditId(e.project), path: e.path, base: e.base, baseSha: hash(e.base), text: e.text, textSha: hash(e.text),
        note: e.note, replaces: old?.id ?? null, by: e.by, status: "pending" as const, createdAt: at, updatedAt: at };
      this.db.insert(s.edits).values(row).run();
      out = this.edit(e.project, row.id);
    })();
    this.editChanged(e.project, e.path);
    return out!;
  }
  // The person took a pending edit back (sent the file's own text).
  withdrawEdit(project: string, id: string, at = now()): Edit {
    const e = this.edit(project, id);
    if (!e || e.status !== "pending") bad(`${id} is not a pending edit of ${project}`);
    this.db.update(s.edits).set({ status: "withdrawn", resolvedBy: "person", updatedAt: at }).where(and(eq(s.edits.project, project), eq(s.edits.id, id))).run();
    this.editChanged(project, e!.path);
    return this.edit(project, id)!;
  }
  // The agent (or artipeek, when the file came to have the person's text) closes a pending edit.
  resolveEdit(project: string, id: string, inp: { status?: unknown; note?: unknown }, by: "agent" | "artipeek" = "agent"): Edit {
    if (!inp || typeof inp !== "object") bad("send a JSON object");
    const status = inp.status === "done" || inp.status === "declined" ? inp.status : bad('status must be "done" or "declined"');
    const note = str(inp.note, "note", 4000);
    if (status === "declined" && !note) bad("say why in note when you decline an edit");
    const e = this.edit(project, id);
    if (!e) bad(`${id} is not an edit request of ${project}`);
    if (e!.status !== "pending") bad(`${id} is ${e!.status}, not pending`);
    this.db.update(s.edits).set({ status, resolution: note, resolvedBy: by, updatedAt: now() }).where(and(eq(s.edits.project, project), eq(s.edits.id, id))).run();
    this.editChanged(project, e!.path);
    return this.edit(project, id)!;
  }
  // Edit requests as the agent hears them (GET /api/answers): one entry when sent, one more when withdrawn.
  editNotices(project: string, since?: string) {
    const out: { uid: string; project: string; decisionId: string; at: string; by: string; kind: "edit"; text: string; page: string }[] = [];
    for (const e of this.db.select().from(s.edits).where(eq(s.edits.project, project)).all()) {
      out.push({ uid: `edit-${e.id}`, project, decisionId: e.id, at: e.createdAt, by: e.by, kind: "edit", text: editLine(e), page: e.path });
      if (e.status === "withdrawn") out.push({ uid: `edit-${e.id}-withdrawn`, project, decisionId: e.id, at: e.updatedAt, by: e.by, kind: "edit", text: editLine(e, "withdrawn"), page: e.path });
    }
    return since ? out.filter((a) => a.at > since) : out;
  }
  // ----- actions (see schema.ts) -----
  private actionListeners = new Set<(project: string, id: string | null) => void>();
  // An action or one of its steps changed.
  onAction(fn: (project: string, id: string | null) => void) { this.actionListeners.add(fn); }
  private actionChanged(project: string, id: string | null) { for (const f of this.actionListeners) { try { f(project, id); } catch {} } }
  actionHas(project: string, id: string): boolean {
    return !!this.db.select({ id: s.actions.id }).from(s.actions).where(and(eq(s.actions.project, project), eq(s.actions.id, id))).get();
  }
  nextActionId(project: string): string {
    let n = 0;
    for (const r of this.db.select({ id: s.actions.id }).from(s.actions).where(eq(s.actions.project, project)).all()) { const m = /^A(\d+)$/.exec(r.id); if (m) n = Math.max(n, Number(m[1])); }
    n++;
    while (this.has(project, `A${n}`) || this.editHas(project, `A${n}`)) n++; // a folder whose decisions use A
    return `A${n}`;
  }
  private fullActions(rows: Action[]): FullAction[] {
    if (!rows.length) return [];
    const projects = [...new Set(rows.map((r) => r.project))], ids = [...new Set(rows.map((r) => r.id))];
    const k = (p: string, id: string) => `${p}\u0000${id}`;
    const by = new Map<string, FullAction>();
    const out = rows.map((r) => { const f: FullAction = { ...r, steps: [], from: [], signals: [] }; by.set(k(r.project, r.id), f); return f; });
    for (const st of this.db.select().from(s.actionSteps).where(and(inArray(s.actionSteps.project, projects), inArray(s.actionSteps.actionId, ids))).orderBy(asc(s.actionSteps.n)).all())
      by.get(k(st.project, st.actionId))?.steps.push(st);
    const rels = this.db.select().from(s.actionRelations).where(and(inArray(s.actionRelations.project, projects), inArray(s.actionRelations.actionId, ids))).all();
    const meta = new Map<string, { title: string; status: DecisionStatus }>();
    const ends = [...new Set(rels.map((r) => r.toProject))];
    if (ends.length)
      for (const d of this.db.select({ project: s.decisions.project, id: s.decisions.id, title: s.decisions.title, status: s.decisions.status }).from(s.decisions).where(inArray(s.decisions.project, ends)).all())
        meta.set(k(d.project, d.id), { title: d.title, status: d.status });
    for (const r of rels) by.get(k(r.project, r.actionId))?.from.push({ project: r.toProject, id: r.toId, ...meta.get(k(r.toProject, r.toId)) });
    for (const g of this.db.select().from(s.actionSignals).where(and(inArray(s.actionSignals.project, projects), inArray(s.actionSignals.actionId, ids))).orderBy(desc(s.actionSignals.at)).all()) {
      const f = by.get(k(g.project, g.actionId));
      if (f && f.signals.length < 20) f.signals.push(g);
    }
    return out;
  }
  private actionWhere(opts: ListOpts): SQL | undefined | null {
    const conds: SQL[] = [];
    if (opts.projects) { if (!opts.projects.length) return null; conds.push(inArray(s.actions.project, opts.projects)); }
    if (opts.statuses?.length) conds.push(inArray(s.actions.status, opts.statuses as ActionStatus[]));
    if (opts.urgentAt) conds.push(eq(s.actions.status, "open"), or(eq(s.actions.urgent, true), and(isNotNull(s.actions.deadline), lt(s.actions.deadline, opts.urgentAt)))!);
    return conds.length ? and(...conds) : undefined;
  }
  // Same order as decisions: raised order (or newest first), a page at a time.
  actionList(opts: ListOpts = {}): FullAction[] {
    const w = this.actionWhere(opts);
    if (w === null) return [];
    const dir = opts.newestFirst ? desc : asc;
    let q = this.db.select().from(s.actions).where(w)
      .orderBy(dir(s.actions.createdAt), asc(s.actions.project), dir(sql`length(${s.actions.id})`), dir(s.actions.id)).$dynamic();
    if (opts.limit) q = q.limit(opts.limit).offset(opts.offset ?? 0);
    return this.fullActions(q.all());
  }
  actionCount(opts: ListOpts = {}): number {
    const w = this.actionWhere(opts);
    if (w === null) return 0;
    return Number(this.db.select({ n: sql<number>`count(*)` }).from(s.actions).where(w).get()?.n ?? 0);
  }
  actionCounts(projects: string[]): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    if (!projects.length) return out;
    for (const r of this.sqlite.query(`SELECT project, status, count(*) AS n FROM actions WHERE project IN (${projects.map(() => "?").join(",")}) GROUP BY project, status`).all(...projects) as any[])
      (out[r.project] ??= {})[r.status] = r.n;
    return out;
  }
  action(project: string, id: string): FullAction | null {
    const r = this.db.select().from(s.actions).where(and(eq(s.actions.project, project), eq(s.actions.id, id))).get();
    return r ? this.fullActions([r])[0] : null;
  }
  private actionRow(project: string, id: string): Action {
    const a = this.db.select().from(s.actions).where(and(eq(s.actions.project, project), eq(s.actions.id, id))).get();
    return a ?? bad(`${id} is not an action of ${project}`);
  }
  private stepsOf(project: string, id: string): Step[] {
    return this.db.select().from(s.actionSteps).where(and(eq(s.actionSteps.project, project), eq(s.actionSteps.actionId, id))).orderBy(asc(s.actionSteps.n)).all();
  }
  private setStep0(project: string, id: string, n: number, set: Partial<Step>) {
    this.db.update(s.actionSteps).set(set).where(and(eq(s.actionSteps.project, project), eq(s.actionSteps.actionId, id), eq(s.actionSteps.n, n))).run();
  }
  // The status follows the steps and the person's request, until the agent closes the action.
  private settle(project: string, id: string, at: string) {
    const a = this.actionRow(project, id);
    let status = a.status;
    if (status !== "done" && status !== "withdrawn") {
      const steps = this.stepsOf(project, id);
      status = a.agentAskedAt ? "agent" : steps.length && steps.every((x) => x.state !== "todo") ? "checking" : "open";
    }
    this.db.update(s.actions).set({ status, updatedAt: at }).where(and(eq(s.actions.project, project), eq(s.actions.id, id))).run();
  }
  private actionColumns(inp: ActionInput, creating: boolean) {
    if (!inp || typeof inp !== "object" || Array.isArray(inp)) bad("send a JSON object");
    const o: Partial<typeof s.actions.$inferInsert> = {};
    const has = (k: keyof ActionInput) => Object.prototype.hasOwnProperty.call(inp, k);
    if (creating || has("title")) o.title = str(inp.title, "title", 300, false)!;
    if (has("lane")) o.lane = str(inp.lane, "lane", 60);
    if (has("context")) o.context = str(inp.context, "context", 60_000) ?? "";
    if (has("links")) o.links = checkLinks(inp.links);
    if (has("deadline")) o.deadline = parseDeadline(inp.deadline);
    if (has("urgent")) { if (typeof inp.urgent !== "boolean") bad("urgent must be true or false"); o.urgent = inp.urgent; }
    if (has("status" as any)) bad('set the status with {"status": "done" | "withdrawn" | "open", "note"} (artipeek-decide action done|withdraw|handback)');
    const steps = creating || has("steps") ? checkSteps(inp.steps) : undefined;
    return { o, steps };
  }
  private setActionFrom(project: string, id: string, from: unknown) {
    if (from === undefined) return;
    if (!Array.isArray(from)) bad('from must be a list like ["D12"]');
    if (from.length > 30) bad("from: at most 30");
    const refs = from.map((r) => parseRef(r, project));
    this.db.delete(s.actionRelations).where(and(eq(s.actionRelations.project, project), eq(s.actionRelations.actionId, id))).run();
    for (const r of refs) this.db.insert(s.actionRelations).values({ project, actionId: id, ...r }).onConflictDoNothing().run();
  }
  createAction(project: string, inp: ActionInput, opts: { createdAt?: string } = {}): string {
    if (!PROJECT_RE.test(project)) bad("bad project name");
    const { o, steps } = this.actionColumns(inp, true);
    const want = inp.id === undefined || inp.id === null || inp.id === "" ? null : String(inp.id).trim();
    if (want !== null && !ID_RE.test(want)) bad(`id "${want}" must start with a letter (e.g. A3)`);
    const at = opts.createdAt ?? now();
    let id = "";
    this.sqlite.transaction(() => {
      id = want ?? this.nextActionId(project);
      if (this.actionHas(project, id) || this.has(project, id) || this.editHas(project, id)) bad(`${id} is already used in ${project}; ids are never reused (leave out id for the next free one)`);
      this.db.insert(s.actions).values({ ...o, title: o.title!, project, id, createdAt: at, updatedAt: at }).run();
      steps!.forEach((st, i) => this.db.insert(s.actionSteps).values({ project, actionId: id, n: i + 1, ...st }).run());
      this.setActionFrom(project, id, inp.from);
    })();
    this.actionChanged(project, id);
    return id;
  }
  // Steps may be rewritten: a step keeps its state when its text stays the same at the same place; a ticked (or checked)
  // step can't be changed or dropped.
  updateAction(project: string, id: string, inp: ActionInput): void {
    const { o, steps } = this.actionColumns(inp, false);
    this.sqlite.transaction(() => {
      this.actionRow(project, id);
      const at = now();
      this.db.update(s.actions).set({ ...o, updatedAt: at }).where(and(eq(s.actions.project, project), eq(s.actions.id, id))).run();
      if (steps) {
        const old = this.stepsOf(project, id);
        old.forEach((x, i) => {
          const keep = steps[i] && steps[i].text === x.text;
          if (!keep && (x.state !== "todo" || x.told !== "todo")) bad(`step ${x.n} is ${x.state === "todo" ? "unticked, but the agent hasn't heard yet" : x.state}: keep its text as it is (and keep it in the list)`);
        });
        this.db.delete(s.actionSteps).where(and(eq(s.actionSteps.project, project), eq(s.actionSteps.actionId, id))).run();
        steps.forEach((st, i) => {
          const x = old[i] && old[i].text === st.text ? old[i] : null;
          this.db.insert(s.actionSteps).values({ ...(x ?? {}), project, actionId: id, n: i + 1, ...st }).run();
        });
      }
      this.setActionFrom(project, id, inp.from);
      this.settle(project, id, at);
    })();
    this.actionChanged(project, id);
  }
  private open(a: Action) { if (a.status === "done" || a.status === "withdrawn") bad(`${a.id} is ${a.status}`); }

  // The person (checked by the server). Returns false when nothing changed (a double click, a stale page).
  tickStep(project: string, id: string, n: number, on: boolean, by: string, at = now()): boolean {
    let changed = false;
    this.sqlite.transaction(() => {
      this.open(this.actionRow(project, id));
      const st = this.stepsOf(project, id).find((x) => x.n === n) ?? bad(`${id} has no step ${n}`);
      if (on && st.state === "todo") { this.setStep0(project, id, n, { state: "done", doneAt: at, doneBy: by }); changed = true; }
      if (!on && (st.state === "done" || st.state === "checking")) { this.setStep0(project, id, n, { state: "todo", doneAt: null, doneBy: by }); changed = true; }
      if (!on && (st.state === "verified" || st.state === "skipped")) bad(`step ${n} is already ${st.state === "verified" ? "verified" : "closed (verify skipped)"} by the agent`);
      if (changed) this.settle(project, id, at);
    })();
    if (changed) this.actionChanged(project, id);
    return changed;
  }
  // "I've done all of them": every step still to do is ticked.
  tickAll(project: string, id: string, by: string, note: string | null = null, at = now()): number {
    let n = 0;
    this.sqlite.transaction(() => {
      this.open(this.actionRow(project, id));
      if (note) this.db.update(s.actions).set({ personNote: note }).where(and(eq(s.actions.project, project), eq(s.actions.id, id))).run();
      for (const st of this.stepsOf(project, id)) if (st.state === "todo") { this.setStep0(project, id, st.n, { state: "done", doneAt: at, doneBy: by }); n++; }
      this.settle(project, id, at);
    })();
    this.actionChanged(project, id);
    return n;
  }
  // "Ask the agent to do it": the action goes to the agent until it closes it or hands it back.
  askAgent(project: string, id: string, by: string, note: string | null, at = now()) {
    this.sqlite.transaction(() => {
      const a = this.actionRow(project, id);
      this.open(a);
      if (a.agentAskedAt && !a.agentHeard) bad(`you already asked; it goes to the agent in a moment`);
      this.db.update(s.actions).set({ agentAskedAt: at, agentNote: note, agentBy: by, agentHeard: false }).where(and(eq(s.actions.project, project), eq(s.actions.id, id))).run();
      this.settle(project, id, at);
    })();
    this.actionChanged(project, id);
  }
  // Is there something the agent hasn't heard yet? (ticks, unticks, a request)
  actionPending(project: string, id: string): boolean {
    const a = this.db.select().from(s.actions).where(and(eq(s.actions.project, project), eq(s.actions.id, id))).get();
    return !!a && ((!!a.agentAskedAt && !a.agentHeard) || !!a.personNote || this.stepsOf(project, id).some((x) => x.state === "done" || (x.state === "todo" && x.told === "done")));
  }
  pendingActions(): { project: string; id: string }[] {
    return this.sqlite.query(`SELECT DISTINCT a.project, a.id FROM actions a LEFT JOIN action_steps st ON st.project = a.project AND st.action_id = a.id
      WHERE (a.agent_asked_at IS NOT NULL AND a.agent_heard = 0) OR a.person_note IS NOT NULL OR st.state = 'done' OR (st.state = 'todo' AND st.told = 'done')`).all() as { project: string; id: string }[];
  }
  // Everything the agent hasn't heard about one action, as one signal (ticked steps move on to checking). Null: nothing new.
  takeActionSignal(project: string, id: string): Signal | null {
    let sig: Signal | null = null;
    this.sqlite.transaction(() => {
      const a = this.db.select().from(s.actions).where(and(eq(s.actions.project, project), eq(s.actions.id, id))).get();
      if (!a) return;
      const steps = this.stepsOf(project, id);
      const ticked = steps.filter((x) => x.state === "done"), unticked = steps.filter((x) => x.state === "todo" && x.told === "done");
      const ask = !!a.agentAskedAt && !a.agentHeard;
      if (!ticked.length && !unticked.length && !ask && !a.personNote) return;
      const at = now();
      for (const x of ticked) this.setStep0(project, id, x.n, { state: "checking", told: "done" });
      for (const x of unticked) this.setStep0(project, id, x.n, { told: "todo" });
      this.db.update(s.actions).set({ agentHeard: true, personNote: null }).where(and(eq(s.actions.project, project), eq(s.actions.id, id))).run();
      const nums = (l: Step[]) => `${l.length > 1 ? "steps" : "step"} ${l.map((x) => x.n).join(", ")}`;
      const cut = (t: string, n: number) => (t.length > n ? t.slice(0, n) + "…" : t);
      const left = steps.filter((x) => x.state === "todo").length; // after this signal
      const parts = [
        ask ? `do it for me${a.agentNote ? ` (note: ${cut(a.agentNote, 1000)})` : ""}` : "",
        ticked.length ? `${nums(ticked)} done by the person` : "",
        unticked.length ? `${nums(unticked)} unticked (not done after all)` : "",
        a.personNote ? `note: ${cut(a.personNote, 1000)}` : "",
      ].filter(Boolean);
      const sum = left ? `${steps.length - left} of ${steps.length} steps done` : `all ${steps.length} steps done`;
      const next = ask ? "Try it yourself; mark each step verified (or skipped), then the action done or hand it back"
        : ticked.length ? "Verify each ticked step (verified, or skipped if you can't check it), then mark the action done" : "Nothing to verify for now";
      const by = (ask ? a.agentBy : null) ?? [...ticked, ...unticked].map((x) => x.doneBy).find(Boolean) ?? a.agentBy ?? "person";
      // uid: the same shape as an answer's; the file line and the API share it
      sig = { uid: randomBytes(6).toString("hex"), project, actionId: id, at, by,
        text: `ACTION: ${id} "${cut(a.title, 120)}": ${parts.join("; ")} (${sum}). ${next}: artipeek-decide action show ${id}` };
      this.db.insert(s.actionSignals).values(sig).run();
      this.settle(project, id, at);
    })();
    if (sig) this.actionChanged(project, id);
    return sig;
  }
  // Signals as the agent hears them (GET /api/answers).
  actionNotices(project: string, since?: string) {
    const rows = this.db.select().from(s.actionSignals).where(eq(s.actionSignals.project, project)).orderBy(asc(s.actionSignals.at)).all();
    return rows.filter((g) => !since || g.at > since).map((g) => ({ uid: g.uid, project, decisionId: g.actionId, at: g.at, by: g.by, kind: "action" as const, text: g.text, page: "artipeek:actions" }));
  }

  // The agent: one step's state. todo = not done after all (say what is missing in the note).
  setStep(project: string, id: string, n: number, inp: { state?: unknown; note?: unknown }): void {
    if (!inp || typeof inp !== "object") bad("send a JSON object");
    const state = (["checking", "verified", "skipped", "todo"] as const).find((x) => x === inp.state) ?? bad('state must be "checking", "verified", "skipped" or "todo"');
    const note = str(inp.note, "note", 4000);
    if (state === "todo" && !note) bad("say what is still missing in note when you send a step back");
    this.sqlite.transaction(() => {
      this.open(this.actionRow(project, id));
      const st = this.stepsOf(project, id).find((x) => x.n === n) ?? bad(`${id} has no step ${n}`);
      const at = now();
      this.setStep0(project, id, n, state === "todo"
        ? { state, told: "todo", note, checkedAt: at, doneAt: null }
        : { state, told: "done", note: note ?? (state === "checking" ? st.note : null), checkedAt: at });
      this.settle(project, id, at);
    })();
    this.actionChanged(project, id);
  }
  // The agent closes the action (done, withdrawn) or hands it back to the person (open: can't do it for them, or reopen).
  resolveAction(project: string, id: string, inp: { status?: unknown; note?: unknown; force?: unknown }): void {
    if (!inp || typeof inp !== "object") bad("send a JSON object");
    const status = (["done", "withdrawn", "open"] as const).find((x) => x === inp.status) ?? bad('status must be "done", "withdrawn" or "open"');
    const note = str(inp.note, "note", 4000);
    if (status !== "done" && !note) bad(status === "open" ? "say why you hand it back in note" : "say why in note");
    this.sqlite.transaction(() => {
      const a = this.actionRow(project, id);
      const at = now();
      const where = and(eq(s.actions.project, project), eq(s.actions.id, id));
      if (status === "done") {
        if (a.status === "done" || a.status === "withdrawn") bad(`${id} is already ${a.status}`);
        const left = this.stepsOf(project, id).filter((x) => x.state !== "verified" && x.state !== "skipped");
        if (left.length && inp.force !== true) bad(`${left.length > 1 ? "steps" : "step"} ${left.map((x) => x.n).join(", ")} not verified or skipped yet: mark them (action step), or send force: true to close them as skipped`);
        for (const x of left) this.setStep0(project, id, x.n, { state: "skipped", told: "done", checkedAt: at, note: x.note ?? "closed by the agent without a check" });
        this.db.update(s.actions).set({ status: "done", ...(note ? { resolution: note } : {}), updatedAt: at }).where(where).run();
      } else if (status === "withdrawn") {
        if (a.status === "done" || a.status === "withdrawn") bad(`${id} is already ${a.status}`);
        this.db.update(s.actions).set({ status: "withdrawn", resolution: note, updatedAt: at }).where(where).run();
      } else {
        // open: hand a "do it for me" back, or reopen a closed action
        if (a.status !== "agent" && a.status !== "done" && a.status !== "withdrawn") bad(`${id} is ${a.status}: nothing to hand back`);
        this.db.update(s.actions).set({ status: "open", resolution: note, agentAskedAt: null, agentHeard: true, updatedAt: at }).where(where).run();
        this.settle(project, id, at);
      }
    })();
    this.actionChanged(project, id);
  }

}

export function openHub(file: string): Hub {
  mkdirSync(path.dirname(file), { recursive: true });
  // decisions are private: the file (and SQLite's -wal/-shm, which copy its mode) is for this user only
  if (!existsSync(file)) writeFileSync(file, "", { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch {}
  const sqlite = new Database(file, { create: true });
  sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;");
  const hub = new Hub(sqlite);
  migrate(hub.db, { migrationsFolder: path.join(import.meta.dir, "..", "drizzle") });
  return hub;
}
