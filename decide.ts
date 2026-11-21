#!/usr/bin/env bun
// artipeek-decide: what an agent uses to raise and keep decisions in artipeek's decision hub. No dependencies.
// It talks to the hub's API with the project's token (made on the hub's machine: artipeek decisions token <folder>).
//   artipeek-decide help
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const usage = `artipeek-decide: raise and keep decisions in artipeek's decision hub

  list [--status open,later] [--json]       decisions of the project, oldest first
  show <id> [--json]                         one decision, with updates, links and answers
  add --file f.json                          new decision from JSON (--file - reads stdin; see docs/decisions-for-agents.md)
  add --title "…" [quick flags]              …or from flags
  update <id> --file f.json                  change fields (only the ones given)
  update <id> [quick flags]
  note <id> "text" [--done]                  add a dated update ("-" reads stdin); --done marks it as done
  answers [--since <ISO>] [--json]           what the person sent from the page (answers, explainer and edit requests, action ticks)

Edit requests (the person edited a file on artipeek; you update the file yourself, then close the request):
  edits [--status pending|done|declined|superseded|withdrawn|all] [--json]   default: pending
  edit show <id> [--text | --base | --json]  the diff (default), the person's whole new text, or the file before
  edit done <id> ["note"]                    you updated the file (as asked, or adapted: say how in the note)
  edit decline <id> "why"                    you won't; the person sees why on the file

Actions (work only the person can do, as a checklist; they tick steps or ask you to do it):
  actions [--status open,agent,checking,done,withdrawn|all] [--json]   default: open,agent,checking
  action add --file a.json                   new action (title, steps, from…; see docs/decisions-for-agents.md)
  action add --title "…" --step "text" [--step "text :: command"]… [--from D317] [quick flags]
  action show <id> [--json]                  steps with their states, what the person sent
  action update <id> --file f.json | [quick flags, --step …]   (a ticked step keeps its text)
  action step <id> <n> verified|skipped|checking ["note"]       you checked it (or couldn't: skipped)
  action step <id> <n> todo "what is missing"                    not done after all: back to the person
  action done <id> ["note"] [--force]        every step verified or skipped (--force: the rest as skipped)
  action handback <id> "why"                 asked to do it, you can't: back to the person
  action withdraw <id> "why"                 moot

Quick flags:
  --title "…"  --lane ERP  --context "markdown" | --context-file f.md
  --option "A*: merge now — If A: live tonight"   (repeat; * = recommended; one question)
  --deadline "2026-11-21 18:00" (local time) | none   --deadline-note "…"
  --urgent | --not-urgent   --if-no-answer "…"   --link "label=https://…" (repeat)
  --from D12,other-project:D3   --depends-on D13   --status open|later|answered|relayed|closed|withdrawn
  --resolution "…"   --explainer docs/explainers/d15.html   --id D15 (add only; default: next free)

Where it goes (first found):
  --project / ARTIPEEK_PROJECT / the git folder's name      the artipeek folder name
  --url / ARTIPEEK_URL / ~/.config/artipeek/decide.json url  e.g. http://hub-machine:4321
  ARTIPEEK_TOKEN / decide.json tokens.<project>               the project's token (never in git)
`;

const argv = process.argv.slice(2);
const flags = new Map<string, string[]>();
const pos: string[] = [];
const BOOL = new Set(["--json", "--urgent", "--not-urgent", "--done", "--text", "--base", "--force", "-h", "--help"]);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("-") && a !== "-") {
    const [k, v] = a.includes("=") && a.startsWith("--") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, BOOL.has(a) ? "1" : argv[++i]];
    if (v === undefined) die(`${k} needs a value`);
    flags.set(k, [...(flags.get(k) ?? []), v]);
  } else pos.push(a);
}
const flag = (k: string) => flags.get(k)?.at(-1);
const has = (k: string) => flags.has(k);
function die(m: string): never { console.error(`artipeek-decide: ${m}`); process.exit(1); }

const cfgFile = path.join(os.homedir(), ".config/artipeek/decide.json");
const cfg: { url?: string; tokens?: Record<string, string> } = existsSync(cfgFile) ? JSON.parse(readFileSync(cfgFile, "utf8")) : {};
function gitName(): string {
  const r = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "ignore" });
  return r.exitCode === 0 ? path.basename(r.stdout.toString().trim()) : "";
}
const project = flag("--project") ?? process.env.ARTIPEEK_PROJECT ?? gitName();
const url = (flag("--url") ?? process.env.ARTIPEEK_URL ?? cfg.url ?? "http://127.0.0.1:4321").replace(/\/+$/, "");
const token = process.env.ARTIPEEK_TOKEN ?? cfg.tokens?.[project] ?? "";

async function call(method: string, p: string, body?: unknown): Promise<any> {
  if (!project) die("which project? use --project or ARTIPEEK_PROJECT (the artipeek folder name)");
  if (!token) die(`no token for ${project}: set ARTIPEEK_TOKEN or tokens.${project} in ${cfgFile}`);
  let r: Response;
  try {
    r = await fetch(url + p, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  } catch (e) { die(`can't reach ${url}: ${(e as Error).message}`); }
  const j = (await r.json().catch(() => ({}))) as any;
  if (!r.ok || !j.ok) die(`${r.status}: ${j.error ?? r.statusText}`);
  return j;
}
const P = () => `/api/decisions/${encodeURIComponent(project)}`;

// "2026-11-21 18:00" is local time here; send it with the offset so the hub can't read it in another zone.
function deadline(v: string): string | null {
  if (/^(none|-)$/i.test(v)) return null;
  const t = new Date(v.trim().replace(" ", "T"));
  if (Number.isNaN(+t)) die(`deadline "${v}" is not a date (e.g. 2026-11-21 18:00)`);
  return t.toISOString();
}
async function stdinText(): Promise<string> { return await new Response(Bun.stdin.stream()).text(); }
async function input(): Promise<Record<string, unknown>> {
  let o: Record<string, unknown> = {};
  const f = flag("--file");
  const raw = f ? (f === "-" ? await stdinText() : readFileSync(f, "utf8")) : "";
  if (raw.trim()) { try { o = JSON.parse(raw); } catch { die("the JSON input does not parse"); } }
  const set = (k: string, v: unknown) => { if (v !== undefined) o[k] = v; };
  set("id", flag("--id"));
  set("title", flag("--title"));
  set("lane", flag("--lane"));
  set("context", flag("--context") ?? (flag("--context-file") ? readFileSync(flag("--context-file")!, "utf8") : undefined));
  if (has("--deadline")) o.deadline = deadline(flag("--deadline")!);
  set("deadlineNote", flag("--deadline-note"));
  set("ifNoAnswer", flag("--if-no-answer"));
  if (has("--urgent")) o.urgent = true;
  if (has("--not-urgent")) o.urgent = false;
  set("status", flag("--status"));
  set("resolution", flag("--resolution"));
  set("explainerPath", flag("--explainer"));
  if (has("--from")) o.from = flags.get("--from")!.flatMap((x) => x.split(",")).map((x) => x.trim()).filter(Boolean);
  if (has("--depends-on")) o.dependsOn = flags.get("--depends-on")!.flatMap((x) => x.split(",")).map((x) => x.trim()).filter(Boolean);
  if (has("--link")) o.links = flags.get("--link")!.map((l) => { const i = l.indexOf("="); return i > 0 ? { label: l.slice(0, i), href: l.slice(i + 1) } : { label: l, href: l }; });
  if (has("--option")) o.questions = [{ options: flags.get("--option")!.map((x) => {
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]{0,15})(\*)?\s*[:.)]\s*(.+)$/.exec(x.trim());
    if (!m) die(`--option "${x}": write it like "A*: label — If A: effect"`);
    const [label, effect] = m[3].split(/\s+—\s+If\s+[^:]+:\s*/);
    return { value: m[1], label: label.trim(), ...(m[2] ? { recommended: true } : {}), ...(effect ? { effect: effect.trim() } : {}) };
  }) }];
  if (has("--step")) o.steps = flags.get("--step")!.map((x) => { const i = x.indexOf(" :: "); return i < 0 ? { text: x } : { text: x.slice(0, i), command: x.slice(i + 4) }; });
  return o;
}

const STEP_MARK: Record<string, string> = { todo: "[ ]", done: "[x]", checking: "[?]", verified: "[✓]", skipped: "[-]" };
function showAction(a: any) {
  const t = (s: string | null) => s ? new Date(s).toLocaleString("en-GB", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
  console.log(`${a.id}  [${a.status}${a.urgent ? ", urgent" : ""}]  ${a.title}`);
  console.log(`  raised ${t(a.createdAt)}${a.deadline ? ` · deadline ${t(a.deadline)}` : ""}${a.lane ? ` · ${a.lane}` : ""}${a.from.length ? ` · from ${a.from.map((r: any) => (r.project !== a.project ? r.project + ":" : "") + r.id).join(", ")}` : ""}`);
  if (a.agentAskedAt) console.log(`  THE PERSON ASKED YOU TO DO IT ${t(a.agentAskedAt)}${a.agentNote ? `: ${a.agentNote}` : ""}`);
  for (const x of a.steps) {
    console.log(`  ${STEP_MARK[x.state] ?? x.state} ${x.n}. ${x.text.split("\n")[0].slice(0, 160)}   (${x.state}${x.doneAt ? ` ${t(x.doneAt)} by ${x.doneBy}` : ""})`);
    if (x.where) console.log(`        where: ${x.where}`);
    if (x.command) console.log(`        $ ${x.command.split("\n").join("\n          ")}`);
    if (x.note) console.log(`        note: ${x.note}`);
  }
  if (a.resolution) console.log(`  your note: ${a.resolution}`);
  for (const g of a.signals.slice(0, 5)) console.log(`  sent ${t(g.at)} by ${g.by}: ${g.text}`);
}

function show(d: any) {
  const t = (s: string | null) => s ? new Date(s).toLocaleString("en-GB", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
  console.log(`${d.id}  [${d.status}${d.urgent ? ", urgent" : ""}]  ${d.title}`);
  console.log(`  raised ${t(d.createdAt)}${d.deadline ? ` · deadline ${t(d.deadline)}` : ""}${d.deadlineNote ? ` · ${d.deadlineNote}` : ""}${d.lane ? ` · ${d.lane}` : ""}`);
  const refs = (l: any[]) => l.map((r: any) => (r.project !== d.project ? r.project + ":" : "") + r.id).join(", ");
  for (const [k, l] of [["from", d.from], ["depends on", d.dependsOn], ["led to", d.ledTo], ["needed by", d.neededBy]] as const) if (l.length) console.log(`  ${k}: ${refs(l)}`);
  for (const q of d.questions) {
    if (q.key || q.text) console.log(`  ${[q.key, q.text].filter(Boolean).join(" ")}`);
    for (const o of q.options) console.log(`    ${o.value}${o.recommended ? " (recommended)" : ""}: ${o.label}${o.effect ? ` — If ${o.value}: ${o.effect}` : ""}`);
  }
  if (d.explainerPath) console.log(`  explainer: ${d.explainerPath}`); else if (d.explainerRequestedAt) console.log(`  explainer ASKED FOR ${t(d.explainerRequestedAt)}`);
  for (const n of d.notes) console.log(`  ${n.kind} ${t(n.at)}: ${n.body.split("\n")[0].slice(0, 120)}`);
  for (const a of d.answers) console.log(`  ${a.kind === "explain" ? "explainer request" : "ANSWER"} ${t(a.at)} by ${a.by} (uid ${a.uid}): ${a.text}`);
  if (d.resolution) console.log(`  resolution: ${d.resolution}`);
  if (d.actions?.length) console.log(`  actions: ${d.actions.map((r: any) => `${r.id} (${r.status})`).join(", ")}`);
}

const [cmd, a1, a2] = pos;
switch (cmd) {
  case undefined: case "help": console.log(usage); break;
  case "list": {
    const j = await call("GET", P() + (flag("--status") ? `?status=${encodeURIComponent(flag("--status")!)}` : ""));
    if (has("--json")) console.log(JSON.stringify(j.decisions, null, 1));
    else for (const d of j.decisions) console.log(`${d.id.padEnd(6)} ${d.status.padEnd(9)} ${d.urgent ? "! " : "  "}${d.title}`);
    break;
  }
  case "show": {
    if (!a1) die("show <id>");
    const j = await call("GET", `${P()}/${encodeURIComponent(a1)}`);
    if (has("--json")) console.log(JSON.stringify(j.decision, null, 1)); else show(j.decision);
    break;
  }
  case "add": {
    const j = await call("POST", P(), await input());
    console.log(`${j.id} raised: ${url}${j.url}`);
    break;
  }
  case "update": {
    if (!a1) die("update <id>");
    const j = await call("PATCH", `${P()}/${encodeURIComponent(a1)}`, await input());
    console.log(`${a1} updated (${j.decision.status})`);
    break;
  }
  case "note": {
    if (!a1) die('note <id> "text"');
    if (a2 === undefined) die('note <id> "text"   (or - to read the text from stdin)');
    const body = a2 === "-" ? await stdinText() : a2;
    await call("POST", `${P()}/${encodeURIComponent(a1)}/notes`, { body, kind: has("--done") ? "done" : "update" });
    console.log(`${a1}: ${has("--done") ? "done note" : "update"} added`);
    break;
  }
  case "answers": {
    const j = await call("GET", `/api/answers/${encodeURIComponent(project)}${flag("--since") ? `?since=${encodeURIComponent(flag("--since")!)}` : ""}`);
    if (has("--json")) console.log(JSON.stringify(j.answers, null, 1));
    else for (const a of j.answers) console.log(`${a.at}  ${a.decisionId}  ${a.kind === "explain" ? "EXPLAIN " : a.kind === "edit" ? "EDIT " : a.kind === "action" ? "ACTION " : ""}${a.uid}  by ${a.by}: ${a.text}`);
    break;
  }
  case "edits": {
    const j = await call("GET", `/api/edits/${encodeURIComponent(project)}?status=${encodeURIComponent(flag("--status") ?? "pending")}`);
    if (has("--json")) console.log(JSON.stringify(j.edits, null, 1));
    else if (!j.edits.length) console.log(`no ${flag("--status") ?? "pending"} edit requests`);
    else for (const e of j.edits) console.log(`${e.id.padEnd(5)} ${e.status.padEnd(10)} ${e.path}  +${e.added} -${e.removed}${e.note ? `  note: ${e.note.split("\n")[0].slice(0, 80)}` : ""}`);
    break;
  }
  case "edit": {
    const [sub, id, text] = [a1, a2, pos[3]];
    if (!sub || !id || !["show", "done", "decline"].includes(sub)) die('edit show|done|decline <id> ["note"]');
    const E = `/api/edits/${encodeURIComponent(project)}/${encodeURIComponent(id)}`;
    if (sub === "show") {
      const e = (await call("GET", E)).edit;
      if (has("--json")) console.log(JSON.stringify(e, null, 1));
      else if (has("--text")) process.stdout.write(e.text);
      else if (has("--base")) process.stdout.write(e.base);
      else {
        console.log(`${e.id}  [${e.status}]  ${e.path}  +${e.added} -${e.removed}  by ${e.by} ${e.createdAt}${e.replaces ? `  (replaces ${e.replaces})` : ""}`);
        console.log(`  the file now: ${e.file}${e.file === "changed since" ? " (merge the change by hand)" : ""}`);
        if (e.note) console.log(`  note: ${e.note}`);
        if (e.resolution) console.log(`  ${e.status} (${e.resolvedBy}): ${e.resolution}`);
        console.log(e.diff);
        if (e.status === "pending") console.log(`Whole new text: artipeek-decide edit show ${e.id} --text > ${e.path}   then: artipeek-decide edit done ${e.id}`);
      }
      break;
    }
    if (sub === "decline" && !text) die('edit decline <id> "why"');
    const e = (await call("PATCH", E, { status: sub === "done" ? "done" : "declined", note: text === "-" ? await stdinText() : text })).edit;
    console.log(`${e.id}: ${e.status}`);
    break;
  }
  case "actions": {
    const st = flag("--status");
    const j = await call("GET", `/api/actions/${encodeURIComponent(project)}${st ? `?status=${encodeURIComponent(st)}` : ""}`);
    if (has("--json")) console.log(JSON.stringify(j.actions, null, 1));
    else if (!j.actions.length) console.log(`no ${st ?? "open"} actions`);
    else for (const a of j.actions) console.log(`${a.id.padEnd(5)} ${a.status.padEnd(9)} ${a.steps.filter((x: any) => x.state !== "todo").length}/${a.steps.length} ${a.urgent ? "! " : "  "}${a.title}`);
    break;
  }
  case "action": {
    const [sub, id, x3, x4] = [a1, a2, pos[3], pos[4]];
    const A = `/api/actions/${encodeURIComponent(project)}`;
    const I = () => { if (!id) die(`action ${sub} <id>`); return `${A}/${encodeURIComponent(id)}`; };
    const txt = async (v: string | undefined) => (v === "-" ? await stdinText() : v);
    switch (sub) {
      case "add": { const j = await call("POST", A, await input()); console.log(`${j.id} raised: ${url}${j.url}`); break; }
      case "show": { const a = (await call("GET", I())).action; if (has("--json")) console.log(JSON.stringify(a, null, 1)); else showAction(a); break; }
      case "update": { const a = (await call("PATCH", I(), await input())).action; console.log(`${a.id} updated (${a.status})`); break; }
      case "step": {
        if (!x3 || !/^\d+$/.test(x3) || !["verified", "skipped", "checking", "todo"].includes(x4 ?? "")) die('action step <id> <n> verified|skipped|checking|todo ["note"]');
        const a = (await call("PATCH", `${I()}/steps/${x3}`, { state: x4, note: await txt(pos[5]) })).action;
        console.log(`${a.id} step ${x3}: ${x4} (action ${a.status})`);
        break;
      }
      case "done": case "handback": case "withdraw": {
        const note = await txt(x3);
        if (sub !== "done" && !note) die(`action ${sub} <id> "why"`);
        const a = (await call("PATCH", I(), { status: sub === "done" ? "done" : sub === "handback" ? "open" : "withdrawn", note, ...(has("--force") ? { force: true } : {}) })).action;
        console.log(`${a.id}: ${a.status}`);
        break;
      }
      default: die("action add|show|update|step|done|handback|withdraw (artipeek-decide help)");
    }
    break;
  }
  default: die(`unknown command ${cmd} (artipeek-decide help)`);
}
