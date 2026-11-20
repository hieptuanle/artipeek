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
import { STATUSES, type DecisionStatus, type Question, type Link } from "./schema.ts";

export const ID_RE = /^[A-Za-z][A-Za-z0-9._-]{0,31}$/;
export const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/;

export type Decision = typeof s.decisions.$inferSelect;
export type Note = typeof s.notes.$inferSelect;
export type Answer = typeof s.answers.$inferSelect;
export type Ref = { project: string; id: string; title?: string; status?: DecisionStatus };
export type Full = Decision & {
  notes: Note[];
  from: Ref[]; dependsOn: Ref[]; // this decision → others
  ledTo: Ref[]; neededBy: Ref[]; // others → this decision
  answers: Answer[]; // newest first, at most 20
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
    const out = rows.map((r) => { const f: Full = { ...r, notes: [], from: [], dependsOn: [], ledTo: [], neededBy: [], answers: [] }; by.set(k(r.project, r.id), f); return f; });
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
    return `${prefix}${Math.max(0, ...(per.get(prefix) ?? [])) + 1}`;
  }
  create(project: string, inp: Input, opts: { createdAt?: string } = {}): string {
    if (!PROJECT_RE.test(project)) bad("bad project name");
    const id = inp.id === undefined || inp.id === null || inp.id === "" ? this.nextId(project) : String(inp.id).trim();
    if (!ID_RE.test(id)) bad(`id "${id}" must start with a letter (e.g. D15)`);
    const cols = columns(inp, true);
    const at = opts.createdAt ?? now();
    this.sqlite.transaction(() => {
      if (this.has(project, id)) bad(`${id} already exists in ${project}; ids are never reused (update it, or leave out id for the next free one)`);
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
