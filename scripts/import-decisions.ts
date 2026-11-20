#!/usr/bin/env bun
// One-off: load a desk's decisions.md (the "## D15 — title" + "- Key: value" format) into the decision hub.
// Open and later decisions come in fully; answered/closed ones only if answered (or raised) in the last --days.
// Raise times come from the file's git history. Ids already in the hub are skipped (or replaced with --replace).
// It writes the database directly; a running artipeek notices within a second and live pages update.
//   bun scripts/import-decisions.ts <project> <path/to/decisions.md> [--days 30] [--dry-run] [--replace]
//                                   [--config ~/.config/artipeek/config.json] [--tz +07:00] [--show D15]
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { openHub, ID_RE, type Input } from "../db/store.ts";
import type { Question } from "../db/schema.ts";

const argv = process.argv.slice(2);
const opt = (k: string, d?: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const flag = (k: string) => argv.includes(k);
const VALUED = new Set(["--days", "--config", "--tz", "--show"]);
const [project, file] = argv.filter((a, i) => !a.startsWith("--") && !VALUED.has(argv[i - 1]));
if (!project || !file) { console.log("usage: bun scripts/import-decisions.ts <project> <decisions.md> [--days 30] [--dry-run] [--replace] [--config FILE] [--tz +07:00] [--show ID]"); process.exit(1); }
const DAYS = Number(opt("--days", "30"));
const TZ = opt("--tz", "+07:00")!;
const expandHome = (p: string) => (p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p);
const CONFIG = path.resolve(expandHome(opt("--config", process.env.ARTIPEEK_CONFIG ?? "~/.config/artipeek/config.json")!));
const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
if (!cfg.roots.some((r: any) => r.name === project)) { console.log(`no folder named ${project} in ${CONFIG}`); process.exit(1); }
const DB = path.resolve(expandHome(cfg.decisions?.db ?? path.join(path.dirname(CONFIG), "decisions.db")));

const src = readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->/g, "");
const abs = path.resolve(file);

// ----- raise times: the first commit that added "## <id> " -----
const created = new Map<string, string>();
{
  const r = Bun.spawnSync(["git", "-C", path.dirname(abs), "log", "--reverse", "--format=C %cI", "-p", "-U0", "--", path.basename(abs)], { stdout: "pipe", stderr: "ignore", maxBuffer: 512 * 1024 * 1024 } as any);
  let at = "";
  for (const line of r.stdout.toString().split("\n")) {
    if (line.startsWith("C ")) at = new Date(line.slice(2).trim()).toISOString();
    else { const m = /^\+## ([A-Za-z][A-Za-z0-9._-]*) [—-]/.exec(line); if (m && !created.has(m[1])) created.set(m[1], at); }
  }
}

// ----- dates in the text: "20/11 08:30", "20/11/2026 11:38", "dd/mm" -----
function when(s: string, year: number): string | null {
  const m = /(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?(?:,?\s+(\d{1,2}):(\d{2}))?/.exec(s);
  if (!m) return null;
  const y = m[3] ? Number(m[3]) : year;
  const iso = `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}T${(m[4] ?? "23").padStart(2, "0")}:${m[5] ?? "59"}:00${TZ}`;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

type Field = { key: string; head: string; body: string[] }; // "- Key: head" + indented lines
type Item = { id: string; title: string; fields: Field[] };
const items: Item[] = [];
{
  let cur: Item | null = null, f: Field | null = null;
  for (const line of src.split("\n")) {
    const h = /^## ([A-Za-z][A-Za-z0-9._-]*) [—-]+ (.+)$/.exec(line);
    if (h) { cur = { id: h[1], title: h[2].trim(), fields: [] }; items.push(cur); f = null; continue; }
    if (/^#{1,2} /.test(line)) { cur = null; f = null; continue; }
    if (!cur) continue;
    const k = /^- (Q\d+\b[^:—]*?|[A-Z][A-Za-z0-9 ]*?(?: \([^)]*\))?)\s*(?::|—)\s?(.*)$/.exec(line);
    // "- A (recommended): …" is an option, not a field
    if (k && !/^- [A-Z] \(/.test(line)) { f = { key: k[1].trim(), head: k[2], body: [] }; cur.fields.push(f); continue; }
    if (f && (line.startsWith("  ") || line.trim() === "")) { f.body.push(line); continue; }
    if (f && line.trim()) { f.body.push(line); continue; } // a stray line: keep it with the last field
  }
}

const OPT_RE = /^\s*- ([A-Z0-9][A-Za-z0-9]{0,3})(?:\s*\(([^)]*)\))?\s*[:.)]\s+(.+)$/;
const QH_RE = /^\s*- (Q\d+)\b[\s,]*(?:\(([^)]*)\))?\s*([^:—]*?)\s*(?:—|:)\s*(.*)$/;
// Questions in a block of nested lines: "  - Q1 — text" starts one, "  - A (recommended): label — If A: effect" is an
// option of the current one. Other lines are kept with the option (or question) above them.
function questionsIn(lines: string[], first?: Question): Question[] {
  const out: Question[] = first ? [first] : [];
  for (const l of lines) {
    if (!l.trim()) continue;
    const qh = QH_RE.exec(l);
    if (qh && !OPT_RE.exec(l)) {
      out.push({ key: qh[1], text: [qh[2], qh[3], qh[4]].filter(Boolean).join(" ").trim().slice(0, 2000) || undefined, options: [] });
      continue;
    }
    const m = OPT_RE.exec(l);
    const q = out[out.length - 1];
    if (m) {
      const [label, effect] = m[3].split(/\s+—\s+If\s+[A-Za-z0-9]+:\s*/);
      if (!q) out.push({ options: [] });
      const cur = out[out.length - 1];
      const dup = cur.options.find((o) => o.value === m[1]);
      if (dup) { dup.label = (dup.label + " / " + m[3]).slice(0, 1000); continue; }
      cur.options.push({ value: m[1], label: label.trim().slice(0, 1000), ...(m[2] && /recommended/i.test(m[2]) ? { recommended: true } : {}), ...(effect ? { effect: effect.trim().slice(0, 2000) } : {}) });
      continue;
    }
    if (!q) continue;
    const o = q.options[q.options.length - 1];
    if (o) o.label = (o.label + " " + l.trim().replace(/^- /, "")).slice(0, 1000);
    else q.text = ((q.text ?? "") + " " + l.trim().replace(/^- /, "")).trim().slice(0, 2000);
  }
  return out;
}
const dedent = (lines: string[]) => {
  const ind = Math.min(...lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length), 99);
  return lines.map((l) => l.slice(Math.min(ind, 2))).join("\n").replace(/\n+$/, "");
};
const fieldMd = (f: Field) => [f.head, ...(f.body.length ? [dedent(f.body)] : [])].filter((x) => x !== "").join("\n");

const STATUS: Record<string, Input["status"]> = { open: "open", later: "later", answered: "answered", relayed: "relayed", "past-due": "open", withdrawn: "withdrawn", closed: "closed", done: "closed" };
const since = Date.now() - DAYS * 86400_000;
const allIds = new Set(items.map((i) => i.id));
const prefix = (/^([A-Za-z]+)/.exec(items[0]?.id ?? "D") ?? [, "D"])[1];
const idsIn = (s: string) => [...s.matchAll(new RegExp(`\\b(${prefix}\\d+)\\b`, "g"))].map((m) => m[1]);

type Plan = { id: string; input: Input; createdAt: string; notes: { at: string; kind: "update" | "done"; body: string }[]; skip?: string };
const plans: Plan[] = [];
for (const it of items) {
  if (!ID_RE.test(it.id)) continue;
  const createdAt = created.get(it.id) ?? new Date(0).toISOString();
  const year = new Date(createdAt).getUTCFullYear() || new Date().getFullYear();
  const get = (k: string) => it.fields.find((f) => f.key.toLowerCase() === k.toLowerCase());
  const ctx: string[] = [];
  const notes: Plan["notes"] = [];
  const questions: Question[] = [];
  const links: { label: string; href: string }[] = [];
  let lane: string | undefined, deadline: string | null = null, deadlineNote: string | null = null, ifNoAnswer: string | undefined;
  let status: Input["status"] = "open", statusRest = "", answer = "";
  const from = new Set<string>(), dependsOn = new Set<string>();
  const scanRefs = (s: string) => {
    for (const m of s.matchAll(/\b(from|follows|following|part of|built as you approved in|out of)\s+((?:[A-Z]+\d+(?:\s+(?:Q\d+|[A-Z])\b)?(?:\s*(?:,|and|\+|&)\s*)?)+)/gi)) idsIn(m[2]).forEach((x) => from.add(x));
    for (const m of s.matchAll(/\b(depends on|waits? for|blocked by|needs)\s+((?:[A-Z]+\d+(?:\s*(?:,|and|\+|&)\s*)?)+)/gi)) idsIn(m[2]).forEach((x) => dependsOn.add(x));
  };
  scanRefs(it.title);
  for (const m of it.title.matchAll(/\(([^)]*)\)/g)) idsIn(m[1]).forEach((x) => from.add(x));
  for (const f of it.fields) {
    const key = f.key.replace(/\s*\(.*\)$/, "").trim();
    const kl = key.toLowerCase();
    const text = fieldMd(f);
    if (kl === "lane" || kl === "track") lane = [lane, f.head.trim()].filter(Boolean).join(" · ");
    else if (kl === "item") lane = [lane, f.head.trim()].filter(Boolean).join(" · ");
    else if (kl === "wt") { ctx.unshift(`**WT:** ${text}`); scanRefs(f.head); }
    else if (kl === "deadline") {
      const h = f.head.trim();
      if (/^none\b/i.test(h)) { const rest = h.replace(/^none[;,:\s(]*/i, "").replace(/\)$/, "").trim(); deadlineNote = rest || null; }
      else { deadline = when(h, year); if (!deadline || /[a-z]{3,}/i.test(h.replace(/\b(ICT|Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/g, ""))) deadlineNote = h.slice(0, 300); }
    }
    else if (kl === "context") { const dt = /\(([^)]*)\)/.exec(f.key); ctx.push((dt ? `*${dt[1]}:* ` : "") + text); scanRefs(f.head.split(". ")[0]); }
    else if (kl === "options" || /^q\d+\b/i.test(key)) {
      const qk = /^(Q\d+)/i.exec(key)?.[1].toUpperCase();
      const qtext = (qk ? [f.key.replace(/^Q\d+[\s,]*/i, "").replace(/^\((.*)\)$/, "$1"), f.head] : [f.head]).filter(Boolean).join(" ").trim().slice(0, 2000);
      const qs = questionsIn(f.body, qk ? { key: qk, text: qtext || undefined, options: [] } : undefined);
      const good = qs.filter((q) => q.options.length);
      for (const q of qs) if (!q.options.length) ctx.push(`**${q.key ?? "Question"}** ${q.text ?? ""}`.trim());
      if (!qk && !good.length) ctx.push(`**Options:** ${text}`);
      else if (!qk && qtext) ctx.push(qtext);
      questions.push(...good.map((q) => ({ ...q, options: q.options.slice(0, 12) })));
    }
    else if (kl === "if no answer") ifNoAnswer = text.slice(0, 2000);
    else if (kl === "links") {
      const rest = f.head.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, l, h) => { links.push({ label: l, href: h }); return ""; })
        .replace(/(https?:\/\/[^\s,)]+|\/r\/[^\s,)]+)/g, (h) => { links.push({ label: h.replace(/^https?:\/\/|^\/r\/[^/]+\/(raw|view)\//g, "").slice(0, 80), href: h }); return ""; })
        .replace(/[,;\s]+/g, " ").trim();
      if (rest || f.body.some((l) => l.trim())) ctx.push(`**Links:** ${text}`);
    }
    else if (kl === "status") { const s = f.head.trim(); const w = /^[a-z-]+/i.exec(s)?.[0].toLowerCase() ?? "open"; status = STATUS[w] ?? "open"; statusRest = s.slice(w.length).trim(); }
    else if (kl === "answer") answer = text.trim();
    else if (kl === "update" || kl === "done" || /^(update|done)\b/i.test(f.key)) {
      const at = when(f.key, year) ?? when(f.head, year) ?? createdAt;
      notes.push({ at, kind: /^done/i.test(f.key) ? "done" : "update", body: text || "(no text)" });
    }
    else if (/^answer as e\.g\./i.test(f.key)) continue;
    else ctx.push(`**${f.key}:** ${text}`);
  }
  if (questions.length === 1) delete questions[0].key;
  else questions.forEach((q, i) => { q.key ??= `Q${i + 1}`; if (!q.text) delete q.text; });
  { const seen = new Set<string>(); questions.forEach((q, i) => { if (q.key && seen.has(q.key)) q.key = `${q.key}.${i + 1}`; if (q.key) seen.add(q.key); }); }
  const ansAt = answer && answer !== "-" ? [...answer.matchAll(/\((\d{1,2}\/\d{1,2}(?:\/\d{4})?,?\s+\d{1,2}:\d{2})\)/g)].map((m) => when(m[1], year)).filter(Boolean).pop() ?? null : null;
  const recent = Math.max(Date.parse(ansAt ?? "") || 0, Date.parse(createdAt), ...notes.map((n) => Date.parse(n.at))) >= since;
  const resolution = [answer && answer !== "-" ? `Answer: ${answer}` : "", statusRest ? `(${statusRest.replace(/^\(|\)$/g, "")})` : ""].filter(Boolean).join(" ").slice(0, 4000) || null;
  const input: Input = {
    id: it.id, title: it.title.slice(0, 300), lane: lane?.slice(0, 60) ?? null, context: ctx.join("\n\n").slice(0, 60_000), questions,
    deadline, deadlineNote: deadlineNote?.slice(0, 300) ?? null, ifNoAnswer: ifNoAnswer ?? null, links: links.slice(0, 30),
    urgent: status === "open" && /\burgent\b/i.test(it.title), status, resolution,
  };
  const plan: Plan = { id: it.id, input, createdAt, notes };
  if (status !== "open" && status !== "later" && !recent) plan.skip = `older than ${DAYS} days`;
  // relations only to decisions that also come in
  (plan as any).from = [...from].filter((x) => x !== it.id && allIds.has(x));
  (plan as any).dependsOn = [...dependsOn].filter((x) => x !== it.id && allIds.has(x));
  plans.push(plan);
}
const coming = new Set(plans.filter((p) => !p.skip).map((p) => p.id));
for (const p of plans) { p.input.from = (p as any).from.filter((x: string) => coming.has(x)); p.input.dependsOn = (p as any).dependsOn.filter((x: string) => coming.has(x)); }

const show = opt("--show");
if (show) { console.log(JSON.stringify(plans.find((p) => p.id === show), null, 1)); process.exit(0); }
const by = (s?: string) => plans.filter((p) => !p.skip && p.input.status === s).length;
console.log(`${project}: ${items.length} in ${file}; importing ${coming.size} (open ${by("open")}, later ${by("later")}, answered ${by("answered")}, relayed ${by("relayed")}, closed ${by("closed")}, withdrawn ${by("withdrawn")}); skipping ${plans.length - coming.size} older than ${DAYS} days`);
const noCreated = plans.filter((p) => !p.skip && !created.has(p.id)).map((p) => p.id);
if (noCreated.length) console.log(`  no raise time in git for: ${noCreated.join(", ")} (they sort first)`);
console.log(`  questions: ${plans.filter((p) => !p.skip && p.input.questions!.length).length} with buttons, ${plans.filter((p) => !p.skip && !p.input.questions!.length).length} free text only; links between decisions: ${plans.reduce((n, p) => n + (p.skip ? 0 : p.input.from!.length + p.input.dependsOn!.length), 0)}`);
if (flag("--dry-run")) { console.log("  dry run: nothing written"); process.exit(0); }

const hub = openHub(DB);
let made = 0, skipped = 0;
// pass 1: decisions (without relations: targets may come later); pass 2: relations
for (const p of plans) {
  if (p.skip) continue;
  if (hub.has(project, p.id)) {
    if (!flag("--replace")) { skipped++; continue; }
    hub.sqlite.query("DELETE FROM decision_notes WHERE project = ? AND decision_id = ?").run(project, p.id);
    hub.sqlite.query("DELETE FROM decision_relations WHERE project = ? AND decision_id = ?").run(project, p.id);
    hub.sqlite.query("DELETE FROM decisions WHERE project = ? AND id = ?").run(project, p.id);
  }
  const { from, dependsOn, ...rest } = p.input;
  try {
    hub.create(project, rest, { createdAt: p.createdAt });
    for (const n of p.notes) hub.addNote(project, p.id, { kind: n.kind, body: n.body }, { at: n.at });
    hub.sqlite.query("UPDATE decisions SET updated_at = ? WHERE project = ? AND id = ?").run(p.notes.at(-1)?.at ?? p.createdAt, project, p.id);
    made++;
  } catch (e) { console.log(`  ${p.id}: not imported: ${(e as Error).message}`); }
}
for (const p of plans) {
  if (p.skip || !hub.has(project, p.id) || (!p.input.from!.length && !p.input.dependsOn!.length)) continue;
  try { hub.update(project, p.id, { from: p.input.from, dependsOn: p.input.dependsOn }); } catch (e) { console.log(`  ${p.id}: links not set: ${(e as Error).message}`); }
}
console.log(`  imported ${made}, already there ${skipped}  → ${DB}`);
