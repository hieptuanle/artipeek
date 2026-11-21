// artipeek: read-only preview of several folders (repos) in a browser, built for the phone.
//
// - Folders ("roots") come from a JSON config file, re-read when it changes.
// - Only files git would list (tracked + untracked-not-ignored) are listed or served, minus a hard
//   deny list (env files, keys). Every path resolves inside its root (symlinks too).
// - GET/HEAD only, except answer buttons (see "answers"): a folder with `answers` set (or decisions in the hub) takes
//   POST /r/<folder>/answer from artipeek's own page, after a click on Send, and appends it to one file.
// - Decision hub (decisions/web.ts, db/): /decisions pages, and /api/ for agents with a per-folder token (not on the
//   public listener). Agents write decisions; only the person answers them.
// - Edit requests: /r/<folder>/edit/<path> lets the person change a text file, and POST /r/<folder>/edit hands the new
//   text to the folder's agent (like an answer). artipeek never writes the file; the agent does.
// - Listens on 127.0.0.1 and, if enabled, on this machine's Tailscale IP, where every
//   request is checked with `tailscale whois` against an allow-list of devices.
// - Optional public listener (config "public") for Cloudflare Tunnel: every request needs a valid
//   Cloudflare Access JWT, and only public.roots exist there.
// - Never logs file contents. Sends nothing anywhere (except fetching the Access certs).
//
//   bun server.ts [--config FILE] [--port N]

import { watch, realpathSync, lstatSync, statSync, readdirSync, readFileSync, existsSync, openSync, readSync, closeSync, type FSWatcher } from "node:fs";
import { readFile, appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import MarkdownIt from "markdown-it";
import anchor from "markdown-it-anchor";
import footnote from "markdown-it-footnote";
import taskLists from "markdown-it-task-lists";
import hljs from "highlight.js";
import { iconFor, DIR_ICON, ICON_CSS } from "./icons.ts";
import { openHub, sha256, editLine, type Edit } from "./db/store.ts";
import { editDiff } from "./edits/diff.ts";
import { createDecisionsWeb, DECISIONS_CSS, DECISIONS_JS } from "./decisions/web.ts";
import { createPush, type PushConfig } from "./push/notify.ts";

// ---------- args + config ----------
function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}
const expandHome = (p: string) => (p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p);
const CONFIG_PATH = path.resolve(expandHome(arg("config", "~/.config/artipeek/config.json")!));

type Config = {
  port?: number;
  tailnet?: boolean;
  tailnets?: string[];
  allowDevices?: string[];
  // Tailnet devices whose browser may send answers (see "answers"). Default none. Only phones and tablets
  // belong here: anything running on a listed device (an agent, a script) could send one.
  answerDevices?: string[];
  roots: { name: string; path: string; answers?: AnswersCfg }[];
  // Public listener for Cloudflare Tunnel + Access. Every request needs a valid Access JWT.
  public?: {
    port: number;
    teamDomain: string; // <team>.cloudflareaccess.com
    aud: string; // Access application AUD tag
    emails: string[];
    roots: string[]; // only these folders exist on this listener
    certsUrl?: string; // tests only: default https://<teamDomain>/cdn-cgi/access/certs
  };
  // Decision hub (SQLite). Default file: decisions.db next to the config. Read at start.
  decisions?: { db?: string };
  // Push to the iOS app (APNs). Read at start. See push/notify.ts.
  push?: PushConfig;
};
// Answer buttons: a page in this folder may ask the viewer to send a short answer. artipeek shows its own
// sheet with the exact text; only a click on Send there saves it, as one JSON line in `file` (inside the
// folder), committed if the folder is a git repo, then runs `after` (e.g. a sync command) without waiting.
type AnswersCfg = { file: string; message?: string; after?: string[] };
function readConfig(): Config {
  const c = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Config;
  if (!Array.isArray(c.roots)) throw new Error("config: roots must be a list");
  return c;
}
const config0 = readConfig();
const DECISIONS_DB = path.resolve(expandHome(config0.decisions?.db ?? path.join(path.dirname(CONFIG_PATH), "decisions.db")));
const hub = openHub(DECISIONS_DB);
const PORT = Number(arg("port") ?? config0.port ?? 4321);
const HOST = "127.0.0.1";
const MAX_HIGHLIGHT = 1_000_000; // bytes: above this, plain text
const MAX_INLINE = 5_000_000; // bytes: above this, show only the start
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// Never listed or served, even if tracked in git.
const DENY_RE = /^(\.env(\..+)?|\.netrc|\.pgpass|\.npmrc|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.+\.(pem|key|p12|pfx|kdbx|ppk|keystore|jks))$/i;
const DENY_ALLOW_RE = /^\.env\.(example|sample|template)$/i;
const denied = (rel: string) => {
  const b = path.posix.basename(rel);
  return DENY_RE.test(b) && !DENY_ALLOW_RE.test(b);
};

// ---------- helpers ----------
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const encPath = (rel: string) => rel.split("/").map(encodeURIComponent).join("/");
const fmtSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} kB` : `${(n / 1048576).toFixed(1)} MB`;
const enc = new TextEncoder();

const EXT_LANG: Record<string, string> = {
  sh: "bash", bash: "bash", zsh: "bash", py: "python", js: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript", jsx: "javascript", sql: "sql", json: "json", jsonc: "json", jsonl: "json",
  toml: "ini", yml: "yaml", yaml: "yaml", csv: "plaintext", txt: "plaintext", cron: "bash", conf: "ini",
  ini: "ini", css: "css", scss: "scss", xml: "xml", service: "ini", timer: "ini", go: "go", rs: "rust",
  dockerfile: "dockerfile", diff: "diff", patch: "diff", lua: "lua", php: "php", rb: "ruby", java: "java",
  kt: "kotlin", swift: "swift", vue: "xml", svelte: "xml", nginx: "nginx", tf: "ini", hcl: "ini",
};
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "ico"]);
const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  svg: "image/svg+xml", avif: "image/avif", ico: "image/x-icon", pdf: "application/pdf",
  json: "application/json; charset=utf-8",
};
const extOf = (rel: string) => {
  const b = path.posix.basename(rel).toLowerCase();
  if (b === "dockerfile" || b.startsWith("dockerfile.")) return "dockerfile";
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(i + 1) : "";
};
const isBinary = (buf: Uint8Array) => {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
};
function highlight(code: string, lang?: string): string {
  if (code.length > MAX_HIGHLIGHT) return esc(code);
  try {
    if (lang && lang !== "plaintext" && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
  } catch {}
  return esc(code);
}

function age(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 365) return `${Math.floor(s / 86400)}d`;
  return `${Math.floor(s / (86400 * 365))}y`;
}
const fullTime = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} (local) · ${d.toISOString().slice(0, 19).replace("T", " ")} UTC`;
};
const ageTag = (ms: number) => `<span class="age" data-mtime="${Math.round(ms)}" title="${esc(fullTime(ms))}">${age(ms)}</span>`;

// ---------- status ----------
// Markdown: the first "Status:" line in the first 20 lines (not in a code block), e.g. "STATUS: **SENT 2026-10-15 …**",
// "- Status: for your yes", "Status: drafted …; not sent".
// HTML (email drafts): <meta name="x-status" content="sent">, with optional x-sent-at, x-to, x-subject.
// A folder takes the status of its README.md / index.md / email.html / index.html or, if every Markdown and
// HTML file directly in it has the same status, that status.
type StatusKind = "sent" | "done" | "waiting" | "draft" | "other";
type Status = { kind: StatusKind; label: string; text: string; from: string };
const STATUS_RE = /^\s{0,3}(?:[-*>]\s+)?[*_]{0,2}status[*_]{0,2}\s*:\s*[*_]{0,2}\s*(\S.*)$/i;
function classifyStatus(raw: string, from: string): Status {
  const text = raw.replace(/[*_`]/g, "").replace(/\s+/g, " ").trim().slice(0, 300);
  const t = text.toLowerCase();
  let kind: StatusKind = "other";
  if (/^(sent|posted|delivered|replied|published)\b/.test(t)) kind = "sent";
  else if (/\bnot (yet )?sent\b|^(draft|drafted|drafting|started|wip|todo|to do|in progress|writing)\b/.test(t)) kind = "draft";
  else if (/^(for (your )?(yes|review|approval|sign-?off)|waiting|awaiting|pending|needs? (review|approval))\b/.test(t)) kind = "waiting";
  else if (/^(done|ok|complete|completed|approved|merged|shipped|closed|resolved)\b/.test(t)) kind = "done";
  const label = kind !== "other" ? kind : (/^(?:(?:never|not|no)\s+)?[a-z][a-z-]*/.exec(t)?.[0] ?? "status").slice(0, 14);
  return { kind, label, text, from };
}
function readHead(abs: string, n: number): string | null {
  try {
    const fd = openSync(abs, "r");
    try { const b = Buffer.alloc(n); return b.subarray(0, readSync(fd, b, 0, n, 0)).toString("utf8"); } finally { closeSync(fd); }
  } catch { return null; }
}
const attr = (tag: string, name: string) => new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
const decodeEnt = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
function fmtWhen(v: string): string {
  const t = Date.parse(v);
  return Number.isNaN(t) ? v : new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}
// <meta name="x-status" content="sent"> (+ x-sent-at, x-to, x-subject) in the first 16 kB of an HTML file.
function readHtmlStatus(abs: string, rel: string): Status | null {
  const head = readHead(abs, 16384);
  if (!head) return null;
  const meta: Record<string, string> = {};
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const name = attr(m[0], "name"), content = attr(m[0], "content");
    if (name && content) meta[(name[2] ?? name[3]).toLowerCase()] = decodeEnt(content[2] ?? content[3]).trim();
  }
  const status = meta["x-status"];
  if (!status) return null;
  const parts = [status];
  if (meta["x-sent-at"]) parts.push(fmtWhen(meta["x-sent-at"]));
  if (meta["x-to"]) parts.push(`to ${meta["x-to"]}`);
  if (meta["x-subject"]) parts.push(`“${meta["x-subject"]}”`);
  return classifyStatus(parts.join(" · "), rel);
}
function readStatus(abs: string, rel: string): Status | null {
  if (isHtml(rel)) return readHtmlStatus(abs, rel);
  const head = readHead(abs, 4096);
  if (head === null) return null;
  let fence = false; // skip code blocks
  for (const line of head.split(/\r?\n/).slice(0, 20)) {
    if (/^\s{0,3}(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const m = STATUS_RE.exec(line);
    if (m) return classifyStatus(m[1], rel);
  }
  return null;
}
const isMd = (rel: string) => /\.(md|markdown)$/i.test(rel);
const isHtml = (rel: string) => /\.html?$/i.test(rel);
const dirOf = (rel: string) => { const i = rel.lastIndexOf("/"); return i < 0 ? "" : rel.slice(0, i); };
const statusBadge = (st: Status | null | undefined, rel = "") =>
  st ? `<span class="st st-${st.kind}" title="${esc(st.text + (rel && st.from !== rel ? ` (from ${path.posix.basename(st.from)})` : ""))}">${esc(st.label)}</span>` : "";

// ---------- roots ----------
type Entry = { rel: string; mtime: number; size: number };
type Node = { dirs: Map<string, Node>; files: string[]; mtime: number }; // mtime = newest file inside

class Root {
  files = new Map<string, Entry>();
  byBase = new Map<string, string[]>();
  status = new Map<string, Status>(); // Markdown file -> its own status
  dirStatus = new Map<string, Status>(); // folder ("" = top) -> status
  private statusCache = new Map<string, { key: string; st: Status | null }>();
  private statusSig = "";
  private lastStatusSig = "";
  clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastRecent = "";
  private watcher: FSWatcher | null = null;
  readonly base: string; // URL prefix

  constructor(readonly name: string, readonly dir: string) {
    this.base = `/r/${encodeURIComponent(name)}`;
    this.rebuild();
    this.lastRecent = this.recentSig();
    this.lastStatusSig = this.statusSig;
    try {
      this.watcher = watch(dir, { recursive: true }, (_ev, n) => this.onFs(n));
    } catch (e) {
      console.log(`artipeek: cannot watch ${name}: ${(e as Error).message}`);
    }
  }

  stop() {
    this.watcher?.close();
    if (this.timer) clearTimeout(this.timer);
    for (const c of this.clients) { try { c.close(); } catch {} }
    this.clients.clear();
  }

  private inside(abs: string) {
    return abs === this.dir || abs.startsWith(this.dir + path.sep);
  }

  private listRaw(): string[] {
    const r = Bun.spawnSync(["git", "-C", this.dir, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      stdout: "pipe", stderr: "pipe",
    });
    if (r.exitCode === 0) return r.stdout.toString().split("\0").filter(Boolean);
    // Not a git repo: walk it, skipping .git and node_modules.
    const out: string[] = [];
    const walk = (d: string, depth: number) => {
      if (depth > 12 || out.length > 20000) return;
      for (const e of readdirSync(path.join(this.dir, d), { withFileTypes: true })) {
        if (e.name === ".git" || e.name === "node_modules") continue;
        const rel = d ? `${d}/${e.name}` : e.name;
        if (e.isDirectory()) walk(rel, depth + 1);
        else out.push(rel);
      }
    };
    try { walk("", 0); } catch {}
    return out;
  }

  safeAbs(rel: string): string | null {
    if (!rel || rel.includes("\0") || rel.startsWith("/") || rel.includes("\\")) return null;
    const parts = rel.split("/");
    if (parts.some((p) => p === ".." || p === "." || p === "" || p === ".git")) return null;
    if (denied(rel)) return null;
    const abs = path.join(this.dir, rel);
    if (!this.inside(abs)) return null;
    try {
      const real = realpathSync(abs);
      if (!this.inside(real)) return null;
      if (!statSync(real).isFile()) return null;
      return real;
    } catch {
      return null;
    }
  }

  rebuild(): boolean {
    const next = new Map<string, Entry>();
    for (const rel of this.listRaw()) {
      const abs = this.safeAbs(rel);
      if (!abs) continue;
      try {
        const st = statSync(abs);
        next.set(rel, { rel, mtime: st.mtimeMs, size: st.size });
      } catch {}
    }
    const changed = next.size !== this.files.size || [...next.keys()].some((k) => !this.files.has(k));
    this.files = next;
    this.byBase = new Map();
    for (const rel of next.keys()) {
      const b = path.posix.basename(rel).toLowerCase();
      for (const k of new Set([b, b.replace(/\.md$/, "")])) {
        if (!this.byBase.has(k)) this.byBase.set(k, []);
        this.byBase.get(k)!.push(rel);
      }
    }
    this.readStatuses();
    return changed;
  }

  // Re-reads only Markdown files whose mtime/size changed.
  private readStatuses() {
    const cache = new Map<string, { key: string; st: Status | null }>();
    const own = new Map<string, Status>();
    for (const [rel, e] of this.files) {
      if (!isMd(rel) && !isHtml(rel)) continue;
      const key = `${e.mtime}:${e.size}`;
      const old = this.statusCache.get(rel);
      const st = old && old.key === key ? old.st : readStatus(path.join(this.dir, rel), rel);
      cache.set(rel, { key, st });
      if (st) own.set(rel, st);
    }
    this.statusCache = cache;
    const byDir = new Map<string, Status[]>();
    const mdCount = new Map<string, number>();
    for (const rel of cache.keys()) mdCount.set(dirOf(rel), (mdCount.get(dirOf(rel)) ?? 0) + 1);
    for (const [rel, st] of own) { const d = dirOf(rel); if (!byDir.has(d)) byDir.set(d, []); byDir.get(d)!.push(st); }
    const dirs = new Map<string, Status>();
    for (const [d, list] of byDir) {
      const name = (st: Status) => st.from.slice(d ? d.length + 1 : 0).toLowerCase();
      const main = ["readme.md", "readme.markdown", "index.md", "email.html", "index.html", "email.htm"].map((n) => list.find((st) => name(st) === n)).find(Boolean);
      if (main) dirs.set(d, main);
      else if (list.length === mdCount.get(d) && list.every((st) => st.kind === list[0].kind && st.label === list[0].label))
        dirs.set(d, [...list].sort((a, b) => collator.compare(a.from, b.from))[0]);
    }
    this.status = own;
    this.dirStatus = dirs;
    this.statusSig = [...own].map(([r, st]) => `${r}=${st.kind}:${st.label}`).sort().join("\n");
  }

  // A file's own status, else its folder's (e.g. an email .html next to a README.md with "Status: sent").
  statusFor(rel: string): Status | undefined {
    return this.status.get(rel) ?? this.dirStatus.get(dirOf(rel));
  }

  // The label on a file row in lists: its own status, or for an .html file (an email draft) its folder's.
  // Other files in the folder (css, pdf, zip…) get none, so a folder's rows don't all repeat it.
  rowStatus(rel: string): Status | undefined {
    return this.status.get(rel) ?? (isHtml(rel) ? this.dirStatus.get(dirOf(rel)) : undefined);
  }

  // The only way a request reaches a file: listed, and still resolves inside the root.
  resolve(rel: string): { rel: string; abs: string } | null {
    if (!this.files.has(rel)) return null;
    const abs = this.safeAbs(rel);
    return abs ? { rel, abs } : null;
  }

  recent(n = 10) {
    return [...this.files.values()].sort((a, b) => b.mtime - a.mtime).slice(0, n);
  }
  private recentSig() {
    return this.recent().map((e) => e.rel).join("\n");
  }

  private onFs(name: string | Buffer | null) {
    if (!name) return;
    const rel = String(name).split(path.sep).join("/");
    if (rel === ".git" || rel.startsWith(".git/")) {
      if (rel !== ".git/index") return; // index changes can change what git lists
    } else if (rel.includes("node_modules/") || rel.startsWith("node_modules")) return;
    else this.pending.add(rel);
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 150);
  }

  private flush() {
    this.timer = null;
    const changed = [...this.pending];
    this.pending = new Set();
    const setChanged = this.rebuild();
    const sig = this.recentSig();
    if (setChanged || sig !== this.lastRecent || this.statusSig !== this.lastStatusSig) this.broadcast("tree", {});
    this.lastRecent = sig;
    this.lastStatusSig = this.statusSig;
    if (changed.length) { checkEdits(this, changed); this.broadcast("change", changed); }
  }

  broadcast(event: string, data: unknown) {
    const msg = enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    for (const c of this.clients) { try { c.enqueue(msg); } catch { this.clients.delete(c); } }
    // the app's one stream: the same event, with the folder's name
    toAll(this.name, event, event === "change" ? { root: this.name, paths: data } : { root: this.name });
  }

  defaultFile(): string {
    for (const c of ["README.md", "readme.md", "Readme.md", "CLAUDE.md", "index.md"]) if (this.files.has(c)) return c;
    return [...this.files.keys()].sort(collator.compare)[0] ?? "";
  }

  resolveWiki(name: string): string | null {
    const raw = name.trim();
    if (this.files.has(raw)) return raw;
    const key = raw.toLowerCase();
    const b = path.posix.basename(key);
    const direct = this.byBase.get(b) ?? this.byBase.get(b + ".md");
    if (direct && direct.length === 1) return direct[0];
    if (direct && direct.length > 1) {
      const m = direct.filter((r) => r.toLowerCase().replace(/\.md$/, "").endsWith(key.replace(/\.md$/, "")));
      if (m.length === 1) return m[0];
    }
    return null;
  }

  tree(): Node {
    const root: Node = { dirs: new Map(), files: [], mtime: 0 };
    for (const [rel, e] of this.files) {
      const parts = rel.split("/");
      let n = root;
      n.mtime = Math.max(n.mtime, e.mtime);
      for (const p of parts.slice(0, -1)) {
        if (!n.dirs.has(p)) n.dirs.set(p, { dirs: new Map(), files: [], mtime: 0 });
        n = n.dirs.get(p)!;
        n.mtime = Math.max(n.mtime, e.mtime);
      }
      n.files.push(rel);
    }
    return root;
  }
}

const roots = new Map<string, Root>();
// The app's one live stream per browser tab (/_/events): every folder it may see, and the decision hub.
type StreamClient = { ctrl: ReadableStreamDefaultController<Uint8Array>; scope: Set<string> | null };
const allClients = new Set<StreamClient>();
// folder null: for every page
function toAll(folder: string | null, event: string, data: unknown) {
  if (!allClients.size) return;
  const msg = enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  for (const c of allClients) {
    if (folder && c.scope && !c.scope.has(folder)) continue;
    try { c.ctrl.enqueue(msg); } catch { allClients.delete(c); }
  }
}
// A scope limits which folders exist for a listener (null = all; the public listener passes its list).
type Scope = Set<string> | null;
const answersFor = new Map<string, AnswersCfg>();
function checkAnswers(a: unknown): AnswersCfg | null {
  if (!a || typeof a !== "object" || Array.isArray(a)) return null;
  const o = a as Record<string, unknown>;
  const file = typeof o.file === "string" ? o.file.trim() : "";
  if (!file || path.isAbsolute(file) || file.includes("\\") || file.split("/").some((x) => x === "" || x === "." || x === ".." || x === ".git")) return null;
  const after = Array.isArray(o.after) && o.after.length && o.after.every((x) => typeof x === "string" && x) ? (o.after as string[]).map((x, i) => (i ? x : expandHome(x))) : undefined;
  const message = typeof o.message === "string" && o.message.trim() ? o.message.trim().slice(0, 200) : undefined;
  return { file, after, message };
}
const visibleRoots = (scope: Scope) => [...roots.values()].filter((r) => !scope || scope.has(r.name));
function loadRoots() {
  let cfg: Config;
  try {
    cfg = readConfig();
  } catch (e) {
    console.log(`artipeek: config not loaded (${(e as Error).message}); keeping current roots`);
    return;
  }
  const want = new Map<string, string>();
  const nextAnswers = new Map<string, AnswersCfg>();
  for (const r of cfg.roots) {
    if (!r || typeof r.name !== "string" || !NAME_RE.test(r.name)) { console.log(`artipeek: bad root name ${JSON.stringify(r?.name)}`); continue; }
    try {
      const dir = realpathSync(path.resolve(expandHome(String(r.path))));
      if (!statSync(dir).isDirectory()) throw new Error("not a folder");
      if (dir === "/" || dir === os.homedir()) throw new Error("too wide (/ or home)");
      want.set(r.name, dir);
      if (r.answers !== undefined) {
        const a = checkAnswers(r.answers);
        if (a) nextAnswers.set(r.name, a); else console.log(`artipeek: root ${r.name}: bad "answers" (needs a relative file inside the folder), answers off`);
      }
    } catch (e) {
      console.log(`artipeek: root ${r.name} skipped: ${(e as Error).message}`);
    }
  }
  answersFor.clear();
  for (const [n, a] of nextAnswers) answersFor.set(n, a);
  for (const [name, root] of roots) {
    if (want.get(name) !== root.dir) { root.stop(); roots.delete(name); console.log(`artipeek: root ${name} removed`); }
  }
  for (const [name, dir] of want) {
    if (!roots.has(name)) {
      const r = new Root(name, dir);
      roots.set(name, r);
      console.log(`artipeek: root ${name} = ${dir} (${r.files.size} files)`);
    }
  }
  // keep config order
  const ordered = [...want.keys()].filter((n) => roots.has(n)).map((n) => [n, roots.get(n)!] as const);
  roots.clear();
  for (const [n, r] of ordered) roots.set(n, r);
}
loadRoots();

// Re-read the config when it changes (editors often replace the file, so watch the folder).
{
  let t: ReturnType<typeof setTimeout> | null = null;
  try {
    // Any event in the folder (a rename into place reports the temp name), debounced.
    const dbName = path.dirname(DECISIONS_DB) === path.dirname(CONFIG_PATH) ? path.basename(DECISIONS_DB) : "\0";
    watch(path.dirname(CONFIG_PATH), (_ev, f) => {
      if (f && String(f).startsWith(dbName)) return; // the decision hub's own writes (db, -wal, -shm)
      if (t) clearTimeout(t);
      t = setTimeout(() => { t = null; if (existsSync(CONFIG_PATH)) loadRoots(); }, 300);
    });
  } catch {}
}

setInterval(() => {
  const ping = enc.encode(`: ping\n\n`);
  for (const r of roots.values()) for (const c of r.clients) { try { c.enqueue(ping); } catch { r.clients.delete(c); } }
  for (const c of allClients) { try { c.ctrl.enqueue(ping); } catch { allClients.delete(c); } }
}, 25_000);

// ---------- markdown ----------
function resolveRel(fromRel: string, href: string): string | null {
  const dir = href.startsWith("/") ? "" : path.posix.dirname(fromRel);
  const joined = path.posix.normalize(path.posix.join(dir === "." ? "" : dir, href.replace(/^\/+/, "")));
  if (joined.startsWith("..") || joined.startsWith("/")) return null;
  return joined;
}
const isExternal = (href: string) => /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");
const slug = (s: string) => encodeURIComponent(String(s).trim().toLowerCase().replace(/\s+/g, "-"));

// A code block with a Copy button (the click is handled in CLIENT_JS).
const codeBlock = (pre: string) => `<div class="codeblock"><button type="button" class="copy" data-copy aria-label="Copy code">Copy</button>${pre}</div>`;

function makeMd(root: Root, currentRel: string) {
  const md = new MarkdownIt({
    html: true, // page CSP blocks scripts in rendered HTML
    linkify: true,
    typographer: false,
    highlight: (str, lang) => `<pre class="hljs"><code>${highlight(str, lang || undefined)}</code></pre>`,
  })
    .use(anchor, { permalink: anchor.permalink.headerLink() })
    .use(footnote)
    .use(taskLists, { enabled: false, label: true });

  const fence = md.renderer.rules.fence!;
  md.renderer.rules.fence = (...args) => codeBlock(fence(...args));

  // Obsidian [[name]], [[name|alias]], [[name#heading]]
  md.inline.ruler.before("link", "wikilink", (state, silent) => {
    const src = state.src;
    const start = state.pos;
    if (src.charCodeAt(start) !== 0x5b || src.charCodeAt(start + 1) !== 0x5b) return false;
    const end = src.indexOf("]]", start + 2);
    if (end < 0) return false;
    const inner = src.slice(start + 2, end);
    if (!inner || inner.includes("\n") || inner.includes("[")) return false;
    if (!silent) {
      const [target, alias] = inner.split("|");
      const [name, hash] = target.split("#");
      const found = name ? root.resolveWiki(name) : currentRel;
      if (found) {
        const open = state.push("link_open", "a", 1);
        open.attrSet("href", `${root.base}/view/${encPath(found)}${hash ? "#" + slug(hash) : ""}`);
        open.attrSet("class", "wikilink");
      } else {
        const open = state.push("span_open", "span", 1);
        open.attrSet("class", "wikilink broken");
        open.attrSet("title", "No unique file with this name");
      }
      const t = state.push("text", "", 0);
      t.content = alias ?? inner;
      state.push(found ? "link_close" : "span_close", found ? "a" : "span", -1);
    }
    state.pos = end + 2;
    return true;
  });

  const defLink = md.renderer.rules.link_open ?? ((t, i, o, _e, s) => s.renderToken(t, i, o));
  md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
    const t = tokens[idx];
    const href = t.attrGet("href");
    if (href && !href.startsWith("#") && !href.startsWith(root.base + "/") && !isExternal(href)) {
      const [p, hash] = href.split("#");
      let decoded = p;
      try { decoded = decodeURIComponent(p); } catch {}
      const r = p ? resolveRel(currentRel, decoded) : currentRel;
      if (r) t.attrSet("href", `${root.base}/view/${encPath(r)}${hash ? "#" + hash : ""}`);
      if (r && !root.files.has(r)) t.attrJoin("class", "missing");
    } else if (href && isExternal(href)) {
      t.attrSet("target", "_blank");
      t.attrSet("rel", "noopener noreferrer");
    }
    return defLink(tokens, idx, opts, env, self);
  };
  const defImg = md.renderer.rules.image!;
  md.renderer.rules.image = (tokens, idx, opts, env, self) => {
    const t = tokens[idx];
    const src = t.attrGet("src");
    if (src && !isExternal(src) && !src.startsWith("data:")) {
      let decoded = src;
      try { decoded = decodeURIComponent(src); } catch {}
      const r = resolveRel(currentRel, decoded);
      if (r) t.attrSet("src", `${root.base}/raw/${encPath(r)}`);
    }
    return defImg(tokens, idx, opts, env, self);
  };
  return md;
}

function frontMatter(src: string): { fm: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { fm: "", body: src };
  let rows = "";
  try {
    const data = Bun.YAML.parse(m[1]) as Record<string, unknown>;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      for (const [k, v] of Object.entries(data)) {
        const val = typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
        rows += `<tr><th>${esc(k)}</th><td>${esc(val)}</td></tr>`;
      }
    }
  } catch {}
  if (!rows) rows = `<tr><td><pre>${esc(m[1])}</pre></td></tr>`;
  return { fm: `<table class="frontmatter">${rows}</table>`, body: src.slice(m[0].length) };
}

// ---------- page parts ----------
const MENU_BTN = `<button type="button" class="menu" aria-label="Files" data-menu>☰</button>`;

// The status of the file (or of its folder), under the file bar. Always present (maybe empty) so the page
// can swap it live when a Markdown file next to it changes.
function statusBar(root: Root, rel: string): string {
  const st = root.statusFor(rel);
  if (!st) return `<div id="stbar" hidden></div>`;
  const src = st.from === rel ? "" : ` <a class="stfrom" href="${root.base}/view/${encPath(st.from)}">${esc(path.posix.basename(st.from))}</a>`;
  return `<div id="stbar" class="statusbar">${statusBadge(st)}<span class="sttext">${esc(st.text)}</span>${src}</div>`;
}

// The bar on top of a file: where it is, size, age, and the other views of it (edit, raw).
function fileBar(root: Root, rel: string, links: string): string {
  const e = root.files.get(rel)!;
  const dir = path.posix.dirname(rel);
  return `<div class="filebar">${MENU_BTN}<span class="crumbs" title="${esc(root.name + "/" + rel)}">${iconFor(rel, extOf(rel))} <span class="rootname">${esc(root.name)}/</span>${dir !== "." ? `<span class="dirname">${esc(dir)}/</span>` : ""}<b>${esc(path.posix.basename(rel))}</b></span><span class="meta">${fmtSize(e.size)} · ${ageTag(e.mtime)}${links}</span></div>`;
}

async function renderMain(root: Root, rel: string, abs: string, canEdit = false): Promise<string> {
  const e = root.files.get(rel)!;
  const ext = extOf(rel);
  const raw = `${root.base}/raw/${encPath(rel)}`;
  const edit = canEdit && editable(root) && !IMAGE_EXT.has(ext) && e.size <= MAX_EDIT ? ` · <a href="${root.base}/edit/${encPath(rel)}" class="editlink">edit</a>` : "";
  const head = `${fileBar(root, rel, `${edit} · <a href="${raw}" target="_blank">raw</a>`)}${statusBar(root, rel)}${editBar(root, rel)}`;

  if (ext === "html" || ext === "htm") {
    return `${head}<iframe class="htmlframe" sandbox="allow-scripts" referrerpolicy="no-referrer" src="${raw}?t=${Date.now()}"></iframe>`;
  }
  if (IMAGE_EXT.has(ext)) {
    return `${head}<div class="imgwrap"><img src="${raw}?t=${Date.now()}" alt="${esc(rel)}"></div>`;
  }
  const buf = new Uint8Array(await readFile(abs));
  if (isBinary(buf)) {
    return `${head}<div class="binary"><p><b>${esc(path.posix.basename(rel))}</b></p><p>Binary file, ${fmtSize(buf.length)}.</p><p><a href="${raw}" download>Download</a></p></div>`;
  }
  const text = new TextDecoder().decode(buf.length > MAX_INLINE ? buf.subarray(0, MAX_INLINE) : buf);
  const cut = buf.length > MAX_INLINE ? `<p class="note">Large file: showing the first ${fmtSize(MAX_INLINE)} only.</p>` : "";
  if (ext === "md" || ext === "markdown") {
    const { fm, body } = frontMatter(text);
    return `${head}${cut}<article class="markdown">${fm}${makeMd(root, rel).render(body)}</article>`;
  }
  const lang = EXT_LANG[ext] ?? (ext === "" ? "bash" : undefined);
  return `${head}${cut}${codeBlock(`<pre class="hljs code"><code>${highlight(text, lang)}</code></pre>`)}`;
}

type Sort = "name" | "mtime";
const SORT_COOKIE = "artipeek_sort";
function sortFrom(req: Request, url: URL): { sort: Sort; fromParam: boolean } {
  const q = url.searchParams.get("sort");
  if (q === "name" || q === "mtime") return { sort: q, fromParam: true };
  const m = /(?:^|;\s*)artipeek_sort=(name|mtime)\b/.exec(req.headers.get("cookie") ?? "");
  return { sort: (m?.[1] as Sort) ?? "name", fromParam: false };
}
const sortCookie = (s: Sort) => `${SORT_COOKIE}=${s}; Path=/; Max-Age=31536000; SameSite=Lax`;

// One folder's files and folders, for its node in the file list.
const fileLink = (root: Root, rel: string, label: string, current: string, withAge = false) =>
  `<a href="${root.base}/view/${encPath(rel)}" data-base="${root.base}" data-path="${esc(rel)}"${rel === current ? ' class="current"' : ""}>${iconFor(rel, extOf(rel))}<span class="name">${esc(label)}</span>${statusBadge(root.rowStatus(rel), rel)}${editMark(root, rel)}${withAge ? ageTag(root.files.get(rel)!.mtime) : ""}</a>`;
function renderTree(root: Root, current: string, sort: Sort = "name"): string {
  const byTime = sort === "mtime";
  const walk = (n: Node, prefix: string): string => {
    // Name: folders first, then files, natural order. Modified: folders and files together, newest first.
    type Item = { kind: 0 | 1; name: string; mtime: number; html: () => string };
    const items: Item[] = [];
    for (const [d, child] of n.dirs) {
      const p = prefix ? `${prefix}/${d}` : d;
      const open = current.startsWith(p + "/") ? " open" : "";
      items.push({
        kind: 0, name: d, mtime: child.mtime,
        html: () => `<li class="dir"><details data-dir="${esc(p)}"${open}><summary>${DIR_ICON}<span class="name">${esc(d)}</span>${statusBadge(root.dirStatus.get(p))}${byTime ? ageTag(child.mtime) : ""}</summary><ul>${walk(child, p)}</ul></details></li>`,
      });
    }
    for (const f of n.files) {
      const name = path.posix.basename(f);
      items.push({ kind: 1, name, mtime: root.files.get(f)!.mtime, html: () => `<li class="file">${fileLink(root, f, name, current, byTime)}</li>` });
    }
    items.sort(byTime
      ? (a, b) => b.mtime - a.mtime || a.kind - b.kind || collator.compare(a.name, b.name)
      : (a, b) => a.kind - b.kind || collator.compare(a.name, b.name));
    return items.map((i) => i.html()).join("");
  };
  return walk(root.tree(), "");
}
// The 10 newest files of every folder this listener shows.
function renderRecent(scope: Scope, active: Root | null, current: string): string {
  const all = visibleRoots(scope).flatMap((r) => r.recent(10).map((e) => ({ r, e })));
  all.sort((a, b) => b.e.mtime - a.e.mtime);
  return all.slice(0, 10).map(({ r, e }) => `<li>${fileLink(r, e.rel, e.rel, r === active ? current : "", true).replace('<span class="name">', `<span class="rroot">${esc(r.name)}</span><span class="name">`)}</li>`).join("");
}
// The file list: Decisions, Recent, then every folder; a folder opens to its files (loaded when opened, except the
// one in view).
function renderNav(scope: Scope, active: Root | null, current: string, sort: Sort, onDecisions: boolean): string {
  const dc = dec.counts(scope);
  const open = Object.values(dc).reduce((n, c) => n + c.open, 0), urgent = Object.values(dc).reduce((n, c) => n + c.urgent, 0);
  const decLink = `<a class="navdec${onDecisions ? " current" : ""}" href="/decisions"><span class="fi fi-dec" aria-hidden="true"></span><span class="name">Decisions</span><span class="nd-open" title="open">${open || ""}</span><span class="nd-urg" title="urgent">${urgent || ""}</span></a>`;
  const nodes = visibleRoots(scope).map((r) => {
    const here = r === active;
    return `<li class="dir rootnode"><details data-root="${esc(r.name)}"${here ? " open" : ""}><summary>${DIR_ICON}<span class="name">${esc(r.name)}</span>${statusBadge(r.dirStatus.get(""))}</summary><ul class="tree" data-root="${esc(r.name)}"${here ? "" : " data-lazy"}>${here ? renderTree(r, current, sort) : ""}</ul></details></li>`;
  }).join("");
  return `${decLink}<details class="recent" open><summary>Recent</summary><ul>${renderRecent(scope, active, current)}</ul></details><ul class="rootlist" data-sort="${sort}">${nodes}</ul>`;
}

// The app in the browser (tabs, file list, live updates). Plain JS files, inline with the page's nonce.
const CLIENT_JS = readFileSync(path.join(import.meta.dir, "client", "app.js"), "utf8");

// Added to an HTML page shown in artipeek's own frame. The sandbox stops the page from opening tabs (and artipeek's
// pages can't load inside a frame), so a click on a link to a file here asks the parent page to open it.
const FRAME_LINKS = `<script>document.addEventListener("click",function(e){if(e.defaultPrevented||e.button||e.ctrlKey||e.metaKey||e.shiftKey||e.altKey)return;var a=e.target.closest&&e.target.closest("a[href]");if(!a||a.hasAttribute("download"))return;var u=new URL(a.href);if(u.origin!==location.origin||u.pathname===location.pathname||!/^\\/r\\/[^/]+\\/(view|raw)\\//.test(u.pathname))return;e.preventDefault();parent.postMessage({artipeek:"open",href:u.href},location.origin)})</script>`;

// Added after FRAME_LINKS to every HTML page in artipeek's frame. A live reload swaps in a new frame, so the page
// tells the parent where it is scrolled (and, in folders with answers, what is typed in its text boxes with an id
// and which per-question picks are on);
// a new frame of the same file asks for it back ("ready") and gets it ("restore"; the scroll stops trying after
// about a second, or at once when you touch, scroll or press a key). Kept in the browser tab's
// sessionStorage, by the parent, never sent to the server.
// Per-question picks (see frameAnswers), only in folders with answers: other pages never get answer markup.
const PICKS_SAVE = `var P=[];document.querySelectorAll('[data-artipeek-answer][data-question][data-artipeek-picked="true"]').forEach(function(b){P.push([b.getAttribute("data-artipeek-answer"),b.getAttribute("data-question"),b.getAttribute("data-value")])});if(P.length)o["artipeek:picks"]=JSON.stringify(P);`;
const PICKS_RESTORE = `if(F&&typeof f["artipeek:picks"]==="string"){try{var P=JSON.parse(f["artipeek:picks"]);document.querySelectorAll("[data-artipeek-answer][data-question]").forEach(function(b){var on=P.some(function(x){return x[0]===b.getAttribute("data-artipeek-answer")&&x[1]===b.getAttribute("data-question")&&x[2]===b.getAttribute("data-value")});if(on)b.setAttribute("data-artipeek-picked","true");else b.removeAttribute("data-artipeek-picked");b.setAttribute("aria-pressed",on?"true":"false")})}catch(x){}}`;
const PICKS_LISTEN = `document.addEventListener("artipeek:pick",send);`;
const frameState = (fields: boolean) => `<script>(function(){var F=${fields ? 1 : 0},tm=0,busy=false;function vals(){var o={};if(!F)return o;document.querySelectorAll("textarea[id],input[id]").forEach(function(el){var ty=(el.getAttribute("type")||"text").toLowerCase();if(el.tagName==="INPUT"&&!/^(text|search|email|url|tel|number)$/.test(ty))return;o[el.id]=el.value});${fields ? PICKS_SAVE : ""}return o}function send(){clearTimeout(tm);tm=setTimeout(function(){if(!busy)parent.postMessage({artipeek:"state",y:scrollY,fields:vals()},location.origin)},250)}addEventListener("scroll",send,{passive:true});document.addEventListener("input",send);${fields ? PICKS_LISTEN : ""}addEventListener("message",function(e){if(e.source!==parent||!e.data||e.data.artipeek!=="restore")return;var f=e.data.fields||{};if(F)for(var k in f){var el=document.getElementById(k);if(el&&(el.tagName==="TEXTAREA"||el.tagName==="INPUT")&&typeof f[k]==="string")el.value=f[k]}${fields ? PICKS_RESTORE : ""}var y=Number(e.data.y)||0;if(y>0){busy=true;var n=0,stop=function(){busy=false;n=99};["wheel","touchstart","pointerdown","keydown"].forEach(function(t){addEventListener(t,stop,{once:true,passive:true})});(function go(){if(n>=99)return;scrollTo(0,y);if(Math.abs(scrollY-y)>2&&n++<20)setTimeout(go,50);else busy=false})()}});parent.postMessage({artipeek:"ready"},location.origin)})()</script>`;

// Added after FRAME_LINKS in folders with answers. A click on an element with data-artipeek-answer="<id>" asks the
// parent page to send an answer: data-value (a fixed choice) and/or data-input (a CSS selector of a text box in the
// page), joined as "<value>: <text>". The parent shows its own sheet; nothing is sent from here. When an answer is
// saved, and again on every load for answers saved in the last 48 hours (so a live reload doesn't forget them), the
// page hears it: elements with that id get data-artipeek-state="saved", the one whose data-value matches gets
// data-artipeek-chosen="true", and the document gets an "artipeek:answer-saved" event (detail: id, text, at, uid,
// restored). After a live save, the clicked button's text box is emptied.
// Several questions in one decision: a button with data-question="Q1" (and data-value) is a pick, not a send: a click
// toggles data-artipeek-picked="true" (and aria-pressed) within that id and question, and fires "artipeek:pick". A
// button with data-artipeek-picks sends them all, in page order, as "Q1 A, Q2 —, Q3 B" (— = no pick; plus ": <text>"
// with data-input). A saved answer marks the matching picks chosen and picked again.
const frameAnswers = (recent: string) => `<script>(function(){var A=${recent},last={};function at(b,n){return (b.getAttribute(n)||"").trim()}function same(id){return Array.prototype.filter.call(document.querySelectorAll("[data-artipeek-answer]"),function(b){return b.getAttribute("data-artipeek-answer")===id})}function note(b){var s=b.getAttribute("data-input");if(!s)return "";try{var el=document.querySelector(s);return el&&typeof el.value==="string"?el.value.trim():""}catch(x){return ""}}function qs(id){var o=[];same(id).forEach(function(b){var q=at(b,"data-question");if(q&&o.indexOf(q)<0)o.push(q)});return o}function picked(id,q){var v="";same(id).forEach(function(b){if(at(b,"data-question")===q&&b.getAttribute("data-artipeek-picked")==="true")v=at(b,"data-value")});return v}function setPick(b,on){if(on)b.setAttribute("data-artipeek-picked","true");else b.removeAttribute("data-artipeek-picked");b.setAttribute("aria-pressed",on?"true":"false")}function pick(b,on){var q=at(b,"data-question");same(b.getAttribute("data-artipeek-answer")).forEach(function(c){if(at(c,"data-question")===q)setPick(c,on&&c===b)})}function txt(b){var id=b.getAttribute("data-artipeek-answer"),v=at(b,"data-value"),n=note(b);if(b.hasAttribute("data-artipeek-picks")){var got=0;v=qs(id).map(function(q){var p=picked(id,q);if(p)got++;return q+" "+(p||"—")}).join(", ");if(!got)v=""}return v&&n?v+": "+n:v||n}function mark(id,t,restored){var parts=t.split(": ")[0].split(", "),seen={};same(id).forEach(function(b){var q=at(b,"data-question");if(q&&b.getAttribute("data-artipeek-picked")==="true")seen[q]=1});same(id).forEach(function(b){b.setAttribute("data-artipeek-state","saved");var v=at(b,"data-value"),q=at(b,"data-question"),on;if(q){on=!!v&&parts.indexOf(q+" "+v)>=0;if(!restored||!seen[q])setPick(b,on)}else on=!!v&&(t===v||t.indexOf(v+":")===0);if(on)b.setAttribute("data-artipeek-chosen","true");else b.removeAttribute("data-artipeek-chosen")})}function fire(d){mark(d.id,d.text,d.restored);document.dispatchEvent(new CustomEvent("artipeek:answer-saved",{detail:d}))}document.addEventListener("click",function(e){var b=e.target.closest&&e.target.closest("[data-artipeek-answer]");if(!b)return;e.preventDefault();var id=b.getAttribute("data-artipeek-answer");if(at(b,"data-question")){var on=b.getAttribute("data-artipeek-picked")!=="true";pick(b,on);document.dispatchEvent(new CustomEvent("artipeek:pick",{detail:{id:id,question:at(b,"data-question"),value:on?at(b,"data-value"):""}}));return}var t=txt(b);if(!t){b.setAttribute("data-artipeek-state","empty");return}last[id]=b;parent.postMessage({artipeek:"answer",id:id,text:t},location.origin)});addEventListener("message",function(e){if(e.source!==parent||!e.data||e.data.artipeek!=="answer-saved")return;var id=String(e.data.id);fire({id:id,text:String(e.data.text||""),at:String(e.data.at||""),uid:String(e.data.uid||""),restored:false});var b=last[id],s=b&&b.getAttribute("data-input");if(s){try{var el=document.querySelector(s);if(el&&typeof el.value==="string"){el.value="";el.dispatchEvent(new Event("input",{bubbles:true}))}}catch(x){}}});function restore(){document.querySelectorAll("[data-artipeek-answer][data-question]").forEach(function(b){if(!b.hasAttribute("aria-pressed"))b.setAttribute("aria-pressed","false")});A.forEach(function(a){fire({id:a.id,text:a.text,at:a.at,uid:a.uid,restored:true})})}if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",function(){setTimeout(restore,0)});else setTimeout(restore,0)})()</script>`;

// Latest answer per id from the last 48 hours, as JSON safe inside a <script> (no "<", ">", "&", U+2028/9).
function recentAnswers(root: Root, cfg: AnswersCfg): string {
  let txt = "";
  try {
    const file = path.join(root.dir, cfg.file);
    const size = statSync(file).size, len = Math.min(size, 262_144);
    const buf = Buffer.alloc(len), fd = openSync(file, "r");
    try { readSync(fd, buf, 0, len, size - len); } finally { closeSync(fd); }
    txt = buf.toString("utf8");
  } catch { return "[]"; }
  const since = Date.now() - 48 * 3600_000;
  const latest = new Map<string, { id: string; text: string; at: string; uid: string }>();
  for (const line of txt.split("\n")) {
    let r: any;
    try { r = JSON.parse(line); } catch { continue; } // also the first, cut-off line
    if (r && typeof r.id === "string" && ANSWER_ID_RE.test(r.id) && typeof r.text === "string" && Date.parse(r.at) >= since)
      latest.set(r.id, { id: r.id, text: r.text.slice(0, 2000), at: String(r.at), uid: String(r.uid ?? "").slice(0, 32) });
  }
  return safeJson([...latest.values()]);
}
// JSON safe inside a <script> (no "<", ">", "&", U+2028/9).
const safeJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

const CSS = ICON_CSS + `
:root { --tabh:0px; color-scheme: light dark; --bg:#fff; --fg:#1f2328; --muted:#59636e; --side:#f6f8fa; --line:#d1d9e0; --accent:#0969da; --cur:#ddf4ff; --code:#f6f8fa; }
@media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --fg:#e6edf3; --muted:#9198a1; --side:#151b23; --line:#30363d; --accent:#4493f8; --cur:#1f3a5f; --code:#151b23; } }
* { box-sizing: border-box; }
html, body { margin:0; background:var(--bg); color:var(--fg); font: 15px/1.55 -apple-system, "Segoe UI", system-ui, sans-serif; -webkit-text-size-adjust:100%; }
body.app { display:grid; grid-template-columns: minmax(220px, 320px) 1fr; min-height:100dvh; }
aside { background:var(--side); border-right:1px solid var(--line); height:100dvh; display:flex; flex-direction:column; position:sticky; top:0; }
aside header { padding:10px 12px 8px; border-bottom:1px solid var(--line); }
.headrow { display:flex; align-items:center; gap:8px; }
.headrow .brand { flex:1; min-width:0; font-weight:600; font-size:14px; color:var(--fg); text-decoration:none; }
/* the file list: Decisions, Recent, then every folder */
#tree a.navdec { margin:2px 0 6px; padding:5px 8px; font-weight:600; border-bottom:1px solid var(--line); border-radius:6px 6px 0 0; }
#tree a.navdec .fi-dec { width:16px; height:16px; flex:none; border-radius:4px; background:var(--accent); -webkit-mask:none; mask:none; position:relative; }
#tree a.navdec .fi-dec::after { content:"?"; position:absolute; inset:0; color:#fff; font:700 11px/16px system-ui, sans-serif; text-align:center; }
#tree a.navdec .nd-open, #tree a.navdec .nd-urg { font-size:11px; font-weight:600; padding:0 6px; border-radius:999px; line-height:17px; }
#tree a.navdec .nd-open { margin-left:auto; background:var(--cur); color:var(--accent); }
#tree a.navdec .nd-urg { background:#cf222e; color:#fff; }
#tree a.navdec .nd-open:empty, #tree a.navdec .nd-urg:empty { display:none; }
#tree ul.rootlist { padding-left:4px; }
#tree li.rootnode > details > summary { font-weight:600; }
#tree li.rootnode > details > ul.tree { padding-left:12px; }
#tree ul.tree[data-lazy]:empty::before { content:"Loading…"; display:block; padding:2px 8px; color:var(--muted); font-style:italic; }
#tree .rroot { flex:none; font-size:10.5px; color:var(--muted); background:var(--bg); border:1px solid var(--line); border-radius:999px; padding:0 5px; max-width:90px; overflow:hidden; text-overflow:ellipsis; }
#tree a.navdec[hidden], #tree details.recent[hidden], #tree li.rootnode[hidden] { display:none; }
details.roots { position:relative; flex:1; min-width:0; }
details.roots > summary { cursor:pointer; font-weight:600; font-size:14px; list-style:none; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
details.roots > summary::after { content:" ▾"; color:var(--muted); font-weight:400; }
details.roots > summary::-webkit-details-marker { display:none; }
details.roots ul { position:absolute; z-index:5; left:0; top:24px; min-width:220px; margin:0; padding:4px; list-style:none; background:var(--bg); border:1px solid var(--line); border-radius:8px; box-shadow:0 8px 24px rgba(0,0,0,.25); }
details.roots a { display:block; padding:6px 10px; border-radius:6px; color:var(--fg); text-decoration:none; }
details.roots a:hover { background:var(--line); }
details.roots a.current { color:var(--accent); font-weight:600; }
#sort { display:inline-flex; border:1px solid var(--line); border-radius:6px; overflow:hidden; flex:none; }
#sort button { font:inherit; font-size:11px; padding:2px 8px; border:0; background:var(--bg); color:var(--muted); cursor:pointer; }
#sort button[aria-pressed="true"] { background:var(--cur); color:var(--accent); font-weight:600; }
#filter { width:100%; margin-top:8px; padding:6px 8px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--fg); font-size:14px; }
#tree { position:relative; overflow:auto; flex:1; padding:6px 4px 24px; font-size:13px; overscroll-behavior:contain; }
#tree ul { list-style:none; margin:0; padding-left:12px; }
#tree > ul.tree, #tree > details > ul { padding-left:4px; }
#tree summary { display:list-item; cursor:pointer; padding:1px 4px; border-radius:4px; user-select:none; color:var(--fg); }
#tree summary .name { display:inline; }
#tree li.dir > details > summary { display:flex; align-items:center; gap:6px; padding:1px 6px; list-style:none; }
#tree li.dir > details > summary::-webkit-details-marker { display:none; }
#tree li.dir > details > summary .age { float:none; margin-right:0; }
/* status labels */
.st { flex:none; font-size:10.5px; line-height:1; font-weight:600; padding:2px 6px; border-radius:999px; white-space:nowrap; letter-spacing:.02em; border:1px solid transparent; }
.st-sent, .st-done { color:#1a7f37; background:#dafbe1; border-color:#aceebb; }
.st-waiting { color:#9a6700; background:#fff8c5; border-color:#f2e08b; }
.st-draft { color:var(--muted); background:var(--side); border-color:var(--line); }
.st-other { color:#0969da; background:#ddf4ff; border-color:#b6e3ff; }
.st-sent::before, .st-done::before { content:"✓ "; }
@media (prefers-color-scheme: dark) {
  .st-sent, .st-done { color:#3fb950; background:rgba(46,160,67,.15); border-color:rgba(46,160,67,.4); }
  .st-waiting { color:#d29922; background:rgba(187,128,9,.15); border-color:rgba(187,128,9,.4); }
  .st-other { color:#4493f8; background:rgba(56,139,253,.15); border-color:rgba(56,139,253,.4); }
}
.statusbar { display:flex; align-items:center; gap:8px; margin:-8px 0 14px; padding:6px 10px; border:1px solid var(--line); border-radius:8px; background:var(--side); font-size:13px; }
.statusbar .sttext { flex:1; min-width:0; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
.statusbar .stfrom { flex:none; font-size:12px; color:var(--muted); }
.statusbar .stfrom::before { content:"from "; }
#tree li.dir > details > summary { font-weight:500; }
#tree a { display:flex; align-items:center; gap:6px; padding:1px 6px; border-radius:4px; color:var(--fg); text-decoration:none; white-space:nowrap; overflow:hidden; }
#tree .name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; min-width:0; }
.age { color:var(--muted); font-size:11px; font-weight:400; font-variant-numeric:tabular-nums; }
#tree .age { margin-left:auto; }
#tree summary .age { float:right; margin-right:6px; }
#tree a:hover, #tree summary:hover { background:var(--line); }
#tree a.current { background:var(--cur); color:var(--accent); font-weight:600; }
#tree details.recent { margin-bottom:6px; padding-bottom:6px; border-bottom:1px solid var(--line); }
#tree details.recent > summary { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
#tree details.recent a .name { color:var(--muted); direction:rtl; text-align:left; }
body.offline aside header::after { content:"live update off"; display:block; color:#d1242f; font-size:12px; }
main { min-width:0; padding:0 32px 60px; }
/* app tabs */
body.has-tabs { --tabh:36px; }
#tabs { position:sticky; top:0; z-index:3; display:flex; align-items:flex-end; gap:2px; height:36px; margin:0 -32px; padding:0 32px; overflow-x:auto; scrollbar-width:none; background:var(--side); border-bottom:1px solid var(--line); }
#tabs[hidden] { display:none; }
#tabs::-webkit-scrollbar { display:none; }
.tab { flex:none; display:flex; align-items:center; max-width:240px; height:31px; margin-bottom:-1px; border:1px solid transparent; border-bottom:0; border-radius:6px 6px 0 0; font-size:13px; }
.tab a { flex:1; min-width:0; padding:5px 2px 5px 10px; color:var(--muted); text-decoration:none; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.tab button { flex:none; width:22px; height:22px; margin-right:3px; padding:0; font:inherit; line-height:1; border:0; border-radius:4px; background:none; color:var(--muted); cursor:pointer; }
.tab button:hover, .tab:not(.active):hover { background:var(--line); }
.tab.active { background:var(--bg); border-color:var(--line); }
.tab.active a { color:var(--fg); font-weight:600; }
.pane [id] { scroll-margin-top:calc(var(--tabh) + 52px); }
.filebar { position:sticky; top:var(--tabh); background:var(--bg); display:flex; align-items:center; gap:10px; padding:10px 0; border-bottom:1px solid var(--line); margin-bottom:16px; font-size:13px; z-index:2; }
.filebar .crumbs { font-family:ui-monospace, monospace; overflow-wrap:anywhere; flex:1; min-width:0; }
.filebar .rootname, .filebar .dirname { color:var(--muted); }
.filebar .meta { color:var(--muted); white-space:nowrap; }
button.menu { display:none; font-size:20px; line-height:1; padding:6px 10px; border:1px solid var(--line); border-radius:8px; background:var(--side); color:var(--fg); cursor:pointer; }
#scrim { display:none; }
a { color:var(--accent); }
.markdown { max-width:900px; overflow-wrap:break-word; }
.markdown h1, .markdown h2 { border-bottom:1px solid var(--line); padding-bottom:.3em; }
.markdown a.header-anchor { color:inherit; text-decoration:none; }
.markdown table { border-collapse:collapse; margin:12px 0; display:block; overflow:auto; max-width:100%; }
.markdown th, .markdown td { border:1px solid var(--line); padding:5px 10px; vertical-align:top; }
.markdown tr:nth-child(2n) td { background:var(--code); }
.markdown code { font-family:ui-monospace, "JetBrains Mono", monospace; font-size:.88em; background:var(--code); padding:.15em .35em; border-radius:4px; overflow-wrap:anywhere; }
.markdown pre code { background:none; padding:0; overflow-wrap:normal; }
pre.hljs { background:var(--code); padding:12px 14px; border-radius:6px; overflow:auto; font: 13px/1.5 ui-monospace, "JetBrains Mono", monospace; }
.codeblock { position:relative; }
.codeblock button.copy { position:absolute; top:6px; right:6px; font:12px/1 system-ui, sans-serif; padding:5px 9px; border-radius:6px; border:1px solid var(--line); background:var(--bg); color:var(--muted); cursor:pointer; opacity:0; transition:opacity .15s; }
.codeblock:hover button.copy, .codeblock button.copy:focus-visible, .codeblock button.copy.done { opacity:1; }
.codeblock button.copy.done { color:var(--accent); border-color:var(--accent); }
@media (hover: none) { .codeblock button.copy { opacity:.85; } }
.markdown blockquote { margin:0; padding:0 1em; color:var(--muted); border-left:.25em solid var(--line); }
.markdown img { max-width:100%; }
.markdown li.task-list-item { list-style:none; margin-left:-1.3em; }
.markdown .footnotes { font-size:.9em; color:var(--muted); }
table.frontmatter { font-size:13px; margin-top:0 !important; }
table.frontmatter th { text-align:left; color:var(--muted); font-weight:500; }
.wikilink.broken { color:#d1242f; border-bottom:1px dashed; }
a.missing { color:#d1242f; }
iframe.htmlframe { width:100%; height:calc(100dvh - 100px - var(--tabh)); border:1px solid var(--line); border-radius:6px; background:#fff; }
.imgwrap img { max-width:100%; }
.note { color:var(--muted); font-style:italic; }
.binary { padding:20px 0; }
/* home */
body.home main { max-width:760px; margin:0 auto; padding:16px; }
.home h1 { font-size:20px; margin:8px 0 16px; }
.rootcard { border:1px solid var(--line); border-radius:10px; padding:12px 14px; margin-bottom:12px; background:var(--side); }
.rootcard h2 { margin:0 0 6px; font-size:17px; display:flex; align-items:baseline; gap:8px; }
.rootcard h2 a { color:var(--fg); text-decoration:none; }
.rootcard h2 .count { color:var(--muted); font-size:12px; font-weight:400; margin-left:auto; }
.rootcard ul { list-style:none; margin:0; padding:0; font-size:14px; }
.rootcard li a { display:flex; align-items:center; gap:8px; padding:5px 0; text-decoration:none; color:var(--fg); border-top:1px solid var(--line); }
.rootcard li a .name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; direction:rtl; text-align:left; }
.deccard { border-color:var(--accent); }
.deccard .name { direction:ltr !important; }
.hot { color:#cf222e; }
/* highlight.js: GitHub-like light/dark */
.hljs-comment,.hljs-quote{color:#6e7781}.hljs-keyword,.hljs-selector-tag,.hljs-type{color:#cf222e}.hljs-string,.hljs-regexp,.hljs-addition{color:#0a3069}.hljs-number,.hljs-literal,.hljs-built_in,.hljs-attr,.hljs-variable,.hljs-template-variable{color:#0550ae}.hljs-title,.hljs-section,.hljs-name{color:#8250df}.hljs-deletion{color:#82071e}.hljs-meta{color:#953800}
@media (prefers-color-scheme: dark){.hljs-comment,.hljs-quote{color:#8b949e}.hljs-keyword,.hljs-selector-tag,.hljs-type{color:#ff7b72}.hljs-string,.hljs-regexp,.hljs-addition{color:#a5d6ff}.hljs-number,.hljs-literal,.hljs-built_in,.hljs-attr,.hljs-variable,.hljs-template-variable{color:#79c0ff}.hljs-title,.hljs-section,.hljs-name{color:#d2a8ff}.hljs-deletion{color:#ffa198}.hljs-meta{color:#ffa657}}
/* answer sheet: artipeek's own confirm step for answer buttons in a page */
.answersheet { position:fixed; inset:0; z-index:50; background:rgba(0,0,0,.45); display:flex; align-items:center; justify-content:center; padding:16px; }
.answersheet .box { background:var(--bg); color:var(--fg); border:1px solid var(--line); border-radius:12px; width:min(520px, 100%); padding:16px; box-shadow:0 10px 40px rgba(0,0,0,.35); }
.answersheet .q { margin:0 0 4px; font-weight:600; font-size:16px; }
.answersheet .aid { margin:0; color:var(--muted); font-size:13px; }
.answersheet pre.atext { white-space:pre-wrap; word-break:break-word; background:var(--code); padding:10px 12px; border-radius:8px; margin:8px 0; font-family:inherit; font-size:16px; max-height:40vh; overflow:auto; }
.answersheet .afrom { margin:0; color:var(--muted); font-size:12px; overflow-wrap:anywhere; }
.answersheet .amsg { min-height:1.4em; margin:8px 0 0; font-size:14px; }
.answersheet .btns { display:flex; gap:10px; justify-content:flex-end; margin-top:8px; }
.answersheet button { font:inherit; padding:10px 18px; border-radius:8px; border:1px solid var(--line); background:var(--side); color:var(--fg); cursor:pointer; }
.answersheet button.asend { background:var(--accent); border-color:var(--accent); color:#fff; font-weight:600; }
.answersheet button:disabled { opacity:.6; cursor:default; }
@media (max-width: 760px) { .answersheet { align-items:flex-end; } }
/* edit requests: the edit view, the sheet before Send, the bar on the file and its mark in the list */
.editmark { flex:none; font-size:12px; line-height:1; color:#9a6700; }
.editor { display:flex; flex-direction:column; gap:8px; }
.editor .ehint, .editor .echanged { margin:0; font-size:13px; color:var(--muted); }
.editor .echanged { color:#9a6700; }
.editor textarea { font:inherit; color:var(--fg); background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:10px 12px; width:100%; }
.editor textarea:focus { outline:2px solid var(--accent); outline-offset:-1px; }
.editor .etext { font:13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; min-height:calc(100dvh - 300px - var(--tabh)); resize:vertical; tab-size:4; }
.editor .enotel { display:flex; flex-direction:column; gap:4px; font-size:13px; color:var(--muted); }
.editor .ebtns { display:flex; gap:10px; justify-content:flex-end; align-items:center; }
.editor .ebtns a, .editor .ebtns button, .editor .ehint button, .editor .echanged button { font:inherit; padding:8px 16px; border-radius:8px; border:1px solid var(--line); background:var(--side); color:var(--fg); cursor:pointer; text-decoration:none; }
.editor .ehint button, .editor .echanged button { padding:2px 10px; font-size:13px; }
.editor .esend { background:var(--accent) !important; border-color:var(--accent) !important; color:#fff !important; font-weight:600; }
.editbar { margin:-6px 0 14px; padding:6px 10px; border:1px solid #f2e08b; border-radius:8px; background:#fff8c5; font-size:13px; }
.editbar.done { border-color:#aceebb; background:#dafbe1; }
.editbar.declined { border-color:var(--line); background:var(--side); }
.editbar p { margin:0; }
.editbar summary { cursor:pointer; color:var(--muted); margin-top:2px; }
.editbar .enoteview { margin:6px 0 0; white-space:pre-wrap; }
pre.diff { margin:6px 0 0; padding:8px 0; background:var(--bg); border:1px solid var(--line); border-radius:6px; font:12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; max-height:50vh; overflow:auto; white-space:pre; }
pre.diff span { display:inline-block; min-width:100%; padding:0 10px; }
pre.diff .da, .dstat .da { color:#1a7f37; } pre.diff .da { background:#dafbe1; }
pre.diff .dd, .dstat .dd { color:#cf222e; } pre.diff .dd { background:#ffebe9; }
pre.diff .dh, pre.diff .dn { color:var(--muted); }
.answersheet.editsheet .box { width:min(760px, 100%); }
.answersheet.editsheet pre.diff { max-height:45vh; }
@media (prefers-color-scheme: dark) {
  .editmark, .editor .echanged { color:#d29922; }
  .editbar { border-color:rgba(187,128,9,.4); background:rgba(187,128,9,.12); }
  .editbar.done { border-color:rgba(46,160,67,.4); background:rgba(46,160,67,.12); }
  .editbar.declined { border-color:var(--line); background:var(--side); }
  pre.diff .da { background:rgba(46,160,67,.15); color:#3fb950; } .dstat .da { color:#3fb950; }
  pre.diff .dd { background:rgba(248,81,73,.15); color:#ff7b72; } .dstat .dd { color:#ff7b72; }
}
@media (max-width: 760px) { .editor .etext { font-size:16px; min-height:calc(100dvh - 330px - var(--tabh)); } /* no iOS zoom on focus */ }
${DECISIONS_CSS}
/* phone: the sidebar becomes a drawer */
@media (max-width: 760px) {
  body.app { display:block; }
  aside { position:fixed; z-index:20; left:0; top:0; width:min(88vw, 360px); height:100dvh; transform:translateX(-102%); transition:transform .18s ease; box-shadow:0 0 30px rgba(0,0,0,.35); }
  body.nav-open aside { transform:none; }
  body.nav-open #scrim { display:block; position:fixed; inset:0; z-index:15; background:rgba(0,0,0,.4); }
  body.nav-open { overflow:hidden; }
  button.menu { display:inline-block; }
  main { padding:0 12px 40px; }
  .filebar { padding:8px 0; gap:8px; }
  .filebar .dirname, .filebar .rootname { display:none; }
  .filebar .meta { font-size:12px; }
  #tree { font-size:15px; }
  #tree a, #tree summary, #tree li.dir > details > summary { padding:6px 8px; }
  #sort button { font-size:12px; padding:4px 9px; }
  #filter { font-size:16px; } /* no iOS zoom on focus */
  pre.hljs { font-size:12px; }
  iframe.htmlframe { height:calc(100dvh - 70px - var(--tabh)); }
  #tabs { margin:0 -12px; padding:0 12px; }
  .tab { max-width:180px; }
  .markdown { font-size:16px; }
}
`;

function shell(opts: { title: string; bodyClass: string; data?: Record<string, string>; aside?: string; main: string; nonce: string }) {
  const data = Object.entries(opts.data ?? {}).map(([k, v]) => ` data-${k}="${esc(v)}"`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer"><meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#0d1117" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/_/icon.svg" type="image/svg+xml"><link rel="icon" href="/favicon.ico" sizes="48x48"><link rel="apple-touch-icon" href="/_/apple-touch-icon.png"><link rel="manifest" href="/_/manifest.webmanifest">
<meta name="apple-mobile-web-app-title" content="artipeek">
<title>${esc(opts.title)} · artipeek</title><link rel="stylesheet" href="/_/style.css"></head>
<body class="${opts.bodyClass}"${data}>${opts.aside ?? ""}<div id="scrim"></div><main id="main">${opts.main}</main>
<script nonce="${opts.nonce}">${DECISIONS_JS}</script><script nonce="${opts.nonce}">${CLIENT_JS}</script></body></html>`;
}

// The app: the file list (every folder) on the left, tabs, and one tab's pane (a file, or Decisions).
function appAside(scope: Scope, active: Root | null, current: string, sort: Sort, onDecisions: boolean): string {
  return `<aside><header><div class="headrow"><a class="brand" href="/">artipeek</a><span id="sort" role="group" aria-label="Sort"><button type="button" data-sort="name" aria-pressed="${sort === "name"}">Name</button><button type="button" data-sort="mtime" aria-pressed="${sort === "mtime"}">Modified</button></span></div><input id="filter" type="search" placeholder="Filter files…" autocomplete="off" enterkeyhint="go"></header>
<nav id="tree">${renderNav(scope, active, current, sort, onDecisions)}</nav></aside>`;
}
function filePage(root: Root, current: string, mainHtml: string, nonce: string, sort: Sort, scope: Scope, mode: "view" | "edit" = "view"): string {
  return shell({ title: (mode === "edit" ? "Edit " : "") + (current ? `${path.posix.dirname(current) === "." ? "" : path.posix.basename(path.posix.dirname(current)) + "/"}${path.posix.basename(current)} · ${root.name}` : root.name), bodyClass: "app", data: { kind: "file", base: root.base, path: current, mode }, aside: appAside(scope, root, current, sort, false), main: `<nav id="tabs" aria-label="Open tabs" hidden></nav><section class="pane">${mainHtml}</section>`, nonce });
}
function decisionsPage(scope: Scope, q: string, paneHtml: string, nonce: string, sort: Sort): string {
  return shell({ title: "Decisions", bodyClass: "app", data: { kind: "dec", q }, aside: appAside(scope, null, "", sort, true), main: `<nav id="tabs" aria-label="Open tabs" hidden></nav><section class="pane">${paneHtml}</section>`, nonce });
}

function homePage(nonce: string, scope: Scope): string {
  const dc = dec.counts(scope);
  const withDec = Object.entries(dc).filter(([, c]) => c.all > 0);
  const open = withDec.reduce((n, [, c]) => n + c.open, 0), urgent = withDec.reduce((n, [, c]) => n + c.urgent, 0);
  const decCard = withDec.length ? `<section class="rootcard deccard"><h2><a href="/decisions">Decisions</a><span class="count">${open} open${urgent ? ` · <b class="hot">${urgent} urgent</b>` : ""}</span></h2><ul>${withDec.map(([p, c]) => `<li><a href="/r/${esc(encodeURIComponent(p))}/decisions"><span class="name">${esc(p)}</span><span class="age">${c.open} open${c.urgent ? `, <b class="hot">${c.urgent} urgent</b>` : ""}</span></a></li>`).join("")}</ul></section>` : "";
  const cards = visibleRoots(scope).map((r) => {
    const rec = r.recent(5).map((e) => `<li><a href="${r.base}/view/${encPath(e.rel)}">${iconFor(e.rel, extOf(e.rel))}<span class="name">${esc(e.rel)}</span>${statusBadge(r.rowStatus(e.rel), e.rel)}${ageTag(e.mtime)}</a></li>`).join("");
    return `<section class="rootcard"><h2><a href="${r.base}/">${esc(r.name)}</a><span class="count">${r.files.size} files</span></h2><ul>${rec}</ul></section>`;
  }).join("");
  return shell({ title: "Folders", bodyClass: "home", main: `<div class="home"><h1>artipeek</h1>${decCard}${cards || '<p class="note">No folders in the config.</p>'}</div>`, nonce });
}

// ---------- http ----------
const SEC_HEADERS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" };

// App icons (assets/), read once at start. Same rules as every other path (the public listener still needs a login).
const ASSET_DIR = path.join(import.meta.dir, "assets");
const MANIFEST = JSON.stringify({
  name: "artipeek", short_name: "artipeek", start_url: "/", display: "standalone",
  background_color: "#0d1117", theme_color: "#0d1117",
  icons: [
    { src: "/_/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/_/icon-512.png", sizes: "512x512", type: "image/png" },
    { src: "/_/icon.svg", sizes: "any", type: "image/svg+xml" },
  ],
});
const STATIC = new Map<string, { body: Uint8Array | string; type: string }>();
for (const [url, file, type] of [
  ["/_/icon.svg", "icon.svg", "image/svg+xml"],
  ["/favicon.ico", "favicon.ico", "image/x-icon"],
  ["/_/apple-touch-icon.png", "apple-touch-icon.png", "image/png"],
  ["/apple-touch-icon.png", "apple-touch-icon.png", "image/png"], // iOS also asks for this path by itself
  ["/_/icon-192.png", "icon-192.png", "image/png"],
  ["/_/icon-512.png", "icon-512.png", "image/png"],
] as const) {
  try { STATIC.set(url, { body: new Uint8Array(readFileSync(path.join(ASSET_DIR, file))), type }); } catch { console.log(`artipeek: icon ${file} missing`); }
}
STATIC.set("/_/manifest.webmanifest", { body: MANIFEST, type: "application/manifest+json" });
const HTML = { ...SEC_HEADERS, "Content-Type": "text/html; charset=utf-8" };
const pageCsp = (nonce: string) =>
  `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
// Raw files: sandboxed (opaque origin) with no fetch/XHR/WebSocket and no remote scripts, images or fonts.
// HTML inside artipeek's own file page also gets allow-scripts + inline scripts (see the raw route), never
// allow-same-origin, so a page can't read artipeek's cookie or other files.
const RAW_CSP = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src 'self' data:";
const RAW_CSP_HTML = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; img-src 'self' data:; style-src 'unsafe-inline'; font-src 'self' data:";
const notFound = () => new Response("Not found", { status: 404, headers: SEC_HEADERS });
const decode = (s: string): string | null => { try { return decodeURIComponent(s); } catch { return null; } };

// Who is asking: a Cloudflare Access login (public listener), a tailnet device, or null (127.0.0.1).
type Who = { email: string } | { device: string } | null;

const dec = createDecisionsWeb({ hub, visibleRoots, broadcast: toAll });
// A device registered through the public listener only hears about the public folders.
const PUBLIC_ROOTS: Scope = new Set((config0.public?.roots ?? []).filter((n) => typeof n === "string"));
const pushApns = config0.push?.apns;
const push = createPush({
  hub,
  config: config0.push && { ...config0.push, apns: pushApns && { ...pushApns, ...(typeof pushApns.keyPath === "string" ? { keyPath: expandHome(pushApns.keyPath) } : {}) } },
  projectsFor: (s) => visibleRoots(s === "public" ? PUBLIC_ROOTS : null).map((r) => r.name),
});
// Who may send answers from a page: a Cloudflare Access login, or a device in answerDevices. Never plain 127.0.0.1.
const answerBy = (who: Who) => who && "email" in who ? who.email : who && "device" in who && ANSWER_DEVICES.has(who.device.split(".")[0]) ? who.device : "";

async function handle(req: Request, scope: Scope = null, who: Who = null): Promise<Response> {
  const p0 = new URL(req.url).pathname;
  // Agents' decision API: a project token on every call; never on the public listener (see decisions/web.ts).
  if (p0.startsWith("/api/")) return dec.api(req, p0, scope);
  if (req.method === "POST") {
    const am = /^\/r\/([^/]+)\/answer$/.exec(p0);
    if (am) return answer(req, am[1], scope, who);
    const em = /^\/r\/([^/]+)\/edit$/.exec(p0);
    if (em) return submitEdit(req, em[1], scope, who);
    // the iOS app's push registration: the person only, like answers (see push/notify.ts)
    if (p0.startsWith("/_/push/")) return push.http(req, p0, answerBy(who), who && "email" in who ? "public" : "all");
  }
  if (req.method !== "GET" && req.method !== "HEAD")
    return new Response("Read-only", { status: 405, headers: { ...SEC_HEADERS, Allow: "GET, HEAD" } });
  const url = new URL(req.url);
  const p = url.pathname;

  const st = STATIC.get(p);
  if (st) return new Response(st.body, { headers: { ...SEC_HEADERS, "Content-Type": st.type, "Cache-Control": "private, max-age=86400", ...(st.type === "image/svg+xml" ? { "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" } : {}) } });
  if (p === "/_/style.css") return new Response(CSS, { headers: { ...SEC_HEADERS, "Content-Type": "text/css; charset=utf-8" } });
  if (p === "/" || p === "") {
    const nonce = randomBytes(16).toString("base64");
    return new Response(homePage(nonce, scope), { headers: { ...HTML, "Content-Security-Policy": pageCsp(nonce) } });
  }
  // the app's one live stream: file changes in every folder this listener shows, and the decision hub
  if (p === "/_/events") {
    let c: StreamClient;
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) { c = { ctrl, scope }; allClients.add(c); ctrl.enqueue(enc.encode(`retry: 2000\n: hello\n\n`)); },
      cancel() { allClients.delete(c); },
    });
    req.signal.addEventListener("abort", () => allClients.delete(c));
    return new Response(stream, { headers: { ...SEC_HEADERS, "Content-Type": "text/event-stream", Connection: "keep-alive" } });
  }
  if (p === "/_/part/recent") {
    const { sort } = sortFrom(req, url);
    return new Response(renderRecent(scope, null, ""), { headers: HTML });
  }
  if (p.startsWith("/decisions/part/")) return dec.part(url, scope, !!answerBy(who)) ?? notFound();
  {
    const f = dec.pageFilter(url, scope);
    if (f) { // the app, with the Decisions tab open
      const nonce = randomBytes(16).toString("base64");
      const q = new URLSearchParams({ status: f.status, ...(f.urgent ? { urgent: "1" } : {}), ...(f.project ? { project: f.project } : {}) }).toString();
      const { sort } = sortFrom(req, url);
      return new Response(decisionsPage(scope, q, dec.pane(scope, f, !!answerBy(who)), nonce, sort), { headers: { ...HTML, "Content-Security-Policy": pageCsp(nonce) } });
    }
  }

  // /r/<root>/<action>/<path>
  const m = /^\/r\/([^/]+)(\/.*)?$/.exec(p);
  if (!m) return notFound();
  const rootName = decode(m[1]);
  const root = rootName && (!scope || scope.has(rootName)) ? roots.get(rootName) : undefined;
  if (!root) return notFound();
  const rest = m[2] ?? "/";

  if (rest === "/" || rest === "") {
    const d = root.defaultFile();
    return d ? Response.redirect(`${root.base}/view/${encPath(d)}`, 302) : notFound();
  }

  if (rest === "/events") {
    let ctrl: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) { ctrl = c; root.clients.add(c); c.enqueue(enc.encode(`retry: 2000\n: hello\n\n`)); },
      cancel() { root.clients.delete(ctrl); },
    });
    req.signal.addEventListener("abort", () => root.clients.delete(ctrl));
    return new Response(stream, { headers: { ...SEC_HEADERS, "Content-Type": "text/event-stream", Connection: "keep-alive" } });
  }

  if (rest === "/part/tree") {
    const { sort } = sortFrom(req, url);
    return new Response(renderTree(root, url.searchParams.get("current") ?? "", sort), { headers: HTML });
  }

  const am = /^\/(view|raw|edit|part\/main|part\/status|part\/edit)\/(.+)$/.exec(rest);
  if (!am) return notFound();
  // An old bookmark of the folder's own decisions page (any file named decisions.html, e.g. docs/explainers/) goes to
  // the hub, once the folder has decisions there. ?file=1 still shows the file.
  if (am[1] === "view" && /(^|\/)decisions\.html$/.test(am[2]) && !url.searchParams.has("file") && Object.keys(hub.counts([root.name])).length)
    return Response.redirect(`${root.base}/decisions`, 302);
  const rel = decode(am[2]);
  const f = rel ? root.resolve(rel) : null;
  if (!f) return notFound();

  if (am[1] === "part/status") return new Response(statusBar(root, f.rel) + editBar(root, f.rel), { headers: HTML });
  if (am[1] === "edit" || am[1] === "part/edit") {
    const editHtml = await renderEdit(root, f.rel, !!answerBy(who));
    if (am[1] === "part/edit") return new Response(editHtml, { headers: HTML });
    const nonce = randomBytes(16).toString("base64");
    const { sort } = sortFrom(req, url);
    return new Response(filePage(root, f.rel, editHtml, nonce, sort, scope, "edit"), { headers: { ...HTML, "Content-Security-Policy": pageCsp(nonce) } });
  }
  if (am[1] === "raw") {
    const ext = extOf(f.rel);
    // HTML may run its own inline scripts only inside artipeek's file page: the browser says so with
    // Sec-Fetch-Dest: iframe + Sec-Fetch-Site: same-origin, and that page's CSP (frame-src 'self') stops the
    // frame from navigating to another site. Opened directly in a tab (or framed by another site), a page
    // could navigate itself elsewhere and take its own text along, so there it gets no scripts at all.
    const inOurFrame = req.headers.get("sec-fetch-dest") === "iframe" && req.headers.get("sec-fetch-site") === "same-origin";
    const type = MIME[ext] ?? "text/plain; charset=utf-8";
    const framed = (ext === "html" || ext === "htm") && inOurFrame;
    const acfg = framed ? answersFor.get(root.name) : undefined;
    const hubOn = framed && !acfg && Object.keys(hub.counts([root.name])).length > 0; // explainers in a hub-only folder
    const recent = acfg ? recentAnswers(root, acfg) : hubOn ? safeJson(hub.recentAnswers(root.name, new Date(Date.now() - 48 * 3600_000).toISOString())) : "";
    const inject = framed ? FRAME_LINKS + frameState(!!acfg || hubOn) + (acfg || hubOn ? frameAnswers(recent) : "") : "";
    return new Response(framed ? Buffer.concat([await readFile(f.abs), Buffer.from(inject)]) : Bun.file(f.abs), {
      headers: {
        ...SEC_HEADERS,
        "Content-Type": type,
        // Raw files always get an opaque origin (no cookies, no same-origin reads) and no fetch/XHR/remote loads.
        "Content-Security-Policy": framed ? RAW_CSP_HTML : RAW_CSP,
        Vary: "Sec-Fetch-Dest, Sec-Fetch-Site",
      },
    });
  }
  const mainHtml = await renderMain(root, f.rel, f.abs, !!answerBy(who));
  if (am[1] === "part/main") return new Response(mainHtml, { headers: HTML });
  const nonce = randomBytes(16).toString("base64");
  const { sort, fromParam } = sortFrom(req, url);
  return new Response(filePage(root, f.rel, mainHtml, nonce, sort, scope), {
    headers: { ...HTML, ...(fromParam ? { "Set-Cookie": sortCookie(sort) } : {}), "Content-Security-Policy": pageCsp(nonce) },
  });
}

// ---------- answers ----------
const ANSWER_ID_RE = /^[A-Za-z][A-Za-z0-9._-]{0,31}$/;
const APP_PAGES = new Set(["artipeek:decisions", "artipeek:push", "artipeek:watch"]);
const ANSWER_DEVICES = new Set((config0.answerDevices ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean));
const answerQueue = new Map<string, Promise<unknown>>();
const jsonRes = (status: number, o: unknown) => new Response(JSON.stringify(o), { status, headers: { ...SEC_HEADERS, "Content-Type": "application/json" } });

async function answer(req: Request, rawName: string, scope: Scope, who: Who): Promise<Response> {
  const name = decode(rawName);
  const root = name && (!scope || scope.has(name)) ? roots.get(name) : undefined;
  const cfg = root && answersFor.get(root.name);
  // A folder takes answers if it has "answers" set, or decisions in the hub (checked again per id below).
  if (!root || (!cfg && !Object.keys(hub.counts([root.name])).length)) return notFound();
  // Never from plain 127.0.0.1: every local process (an agent, a script) can reach that port. A tailnet device must be
  // in answerDevices; the public listener has already checked the Access login.
  const by = answerBy(who);
  if (!by) return jsonRes(403, { ok: false, error: "answers need the public link (login) or a device in answerDevices" });
  // Only a same-origin fetch from artipeek's own page: the browser sets Sec-Fetch-Site (a page can't), and the custom
  // header + JSON type turn any cross-site request into a CORS preflight, which gets 405.
  if (req.headers.get("sec-fetch-site") !== "same-origin" || req.headers.get("x-artipeek") !== "answer")
    return jsonRes(403, { ok: false, error: "not from artipeek's page" });
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return jsonRes(415, { ok: false, error: "JSON only" });
  const raw = await req.text();
  if (raw.length > 8192) return jsonRes(413, { ok: false, error: "too big" });
  let b: any;
  try { b = JSON.parse(raw); } catch { return jsonRes(400, { ok: false, error: "bad JSON" }); }
  const id = typeof b?.id === "string" ? b.id : "";
  let text = typeof b?.text === "string" ? b.text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim() : "";
  if (!ANSWER_ID_RE.test(id) || !text || text.length > 2000) return jsonRes(400, { ok: false, error: "bad id or text" });
  const inHub = hub.has(root.name, id);
  if (!cfg && !inHub) return jsonRes(404, { ok: false, error: `${id} is not a decision of ${root.name}` });
  // "Explain this": asks the desk for an explainer page. Its text always starts with EXPLAIN:, so a desk that reads
  // only the text still can't take it for a choice.
  const kind = b?.kind === "explain" ? "explain" : "answer";
  if (kind === "explain" && !inHub) return jsonRes(400, { ok: false, error: "explainer requests are for decisions in the hub" });
  if (kind === "explain" && !/^EXPLAIN:/.test(text)) text = `EXPLAIN: ${text}`.slice(0, 2000);
  // where it was sent from: the decisions page, a button on a push, the Watch app (both native: they send the login cookie
  // and these same headers), or a file of the folder
  const page = APP_PAGES.has(b?.page) ? b.page : typeof b?.page === "string" && b.page.length <= 400 ? root.resolve(b.page)?.rel ?? "" : "";
  const rec: Record<string, string> = { at: new Date().toISOString(), uid: randomBytes(6).toString("hex"), id, text, by, page, ...(kind === "explain" ? { kind } : {}) };
  if (inHub) {
    try { hub.recordAnswer({ uid: rec.uid, project: root.name, decisionId: id, at: rec.at, by, kind, text, page }); }
    catch (e) { console.log(`artipeek: answer ${id} for ${root.name} not saved in the hub: ${(e as Error).message}`); return jsonRes(500, { ok: false, error: "not saved" }); }
    if (!cfg) {
      console.log(`artipeek: ${kind} ${id} saved in the hub for ${root.name} by ${by}`);
      return jsonRes(200, { ok: true, at: rec.at, uid: rec.uid, committed: false, hub: true });
    }
  }
  const job = (answerQueue.get(root.name) ?? Promise.resolve()).then(() => saveAnswer(root, cfg!, rec));
  answerQueue.set(root.name, job.catch(() => {}));
  try {
    const committed = await job;
    // Keep this line's exact shape: desks' watchers match it in the journal ("answer <id> saved in <folder> by <who>, …").
    console.log(`artipeek: ${kind} ${id} saved in ${root.name} by ${by}${committed ? ", committed" : ", not committed"}`);
    if (inHub) console.log(`artipeek: ${kind} ${id} also in the decision hub (${root.name})`);
    return jsonRes(200, { ok: true, at: rec.at, uid: rec.uid, committed, hub: inHub });
  } catch (e) {
    console.log(`artipeek: answer ${id} for ${root.name} not saved: ${(e as Error).message}`);
    return jsonRes(500, { ok: false, error: inHub ? "saved on the decisions page, but not in the folder's answers file (the desk may not see it)" : "not saved" });
  }
}

// Appends one line; returns true if it was committed. The file must stay inside the folder (no symlinks out).
async function saveAnswer(root: Root, cfg: AnswersCfg, rec: Record<string, string>): Promise<boolean> {
  const file = path.join(root.dir, cfg.file);
  await mkdir(path.dirname(file), { recursive: true });
  const parent = realpathSync(path.dirname(file));
  if (parent !== root.dir && !parent.startsWith(root.dir + path.sep)) throw new Error("answers file outside the folder");
  try { if (lstatSync(file).isSymbolicLink()) throw new Error("answers file is a symlink"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  await appendFile(file, JSON.stringify(rec) + "\n", { mode: 0o644 });
  if (!existsSync(path.join(root.dir, ".git"))) return false;
  const rel = path.relative(root.dir, file);
  const git = (args: string[]) => Bun.spawnSync(["git", "-C", root.dir, "-c", "user.name=artipeek", "-c", `user.email=artipeek@${os.hostname()}`, "-c", "commit.gpgsign=false", ...args], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
  const msg = (cfg.message ?? "answer {id} via artipeek").replace(/\{id\}/g, rec.id);
  let ok = false;
  for (let i = 0; i < 5 && !ok; i++) { // another git command (a sync) may hold the index lock for a moment
    if (i) await Bun.sleep(300 * i);
    ok = git(["add", "--", rel]) && git(["commit", "-q", "-m", msg, "--", rel]);
  }
  if (!ok) { console.log(`artipeek: answers in ${root.name}: git commit failed; the line is saved, the next answer commits it`); return false; }
  if (cfg.after) {
    try {
      const pr = Bun.spawn(cfg.after, { cwd: root.dir, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      pr.exited.then((c) => { if (c) console.log(`artipeek: answers in ${root.name}: after-command exited ${c}`); });
    } catch (e) { console.log(`artipeek: answers in ${root.name}: after-command failed to start: ${(e as Error).message}`); }
  }
  return true;
}

// ---------- edit requests ----------
// The edit view (/r/<folder>/edit/<path>): the person changes a text file there, and artipeek hands the new text to the
// folder's agent as an edit request (E1, E2…), through the same channel as answers: the hub (GET /api/answers, kind
// "edit") and, with "answers" set, one line in the answers file + a commit + the after command. artipeek never writes the
// file: the agent updates it, then marks the request done or declined (artipeek-decide edit done|decline). Only in
// folders with an agent (answers set, or an agent token), and only from the person (a login or an answer device).
const MAX_EDIT = 512 * 1024; // bytes
const EDIT_SHOWN_MS = 3 * 86400_000; // a done or declined edit stays on the file's page this long
function editable(root: Root): boolean { return answersFor.has(root.name) || hub.hasToken(root.name); }
// The file list's marks (path → pending edit id), per folder; dropped when an edit changes.
const editMarks = new Map<string, Map<string, string>>();
function marksFor(root: Root): Map<string, string> {
  let m = editMarks.get(root.name);
  if (!m) editMarks.set(root.name, (m = hub.pendingPaths(root.name)));
  return m;
}
function editMark(root: Root, rel: string): string {
  const id = marksFor(root).get(rel);
  return id ? `<span class="editmark" title="Edit ${esc(id)} sent: waiting for the agent">✎</span>` : "";
}
hub.onEdit((project, rel) => { editMarks.delete(project); toAll(project, "edit", { root: project, path: rel }); });

// The file as text, if the edit view takes it: not an image, not binary, valid UTF-8, at most MAX_EDIT.
async function editText(root: Root, rel: string): Promise<string | null> {
  const f = root.resolve(rel);
  if (!f || IMAGE_EXT.has(extOf(rel))) return null;
  try {
    if (statSync(f.abs).size > MAX_EDIT) return null;
    const buf = new Uint8Array(await readFile(f.abs));
    return isBinary(buf) ? null : new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch { return null; }
}
// A pending edit is done by itself when the file comes to have exactly the person's text.
function checkEdits(root: Root, rels: string[]) {
  const marks = marksFor(root);
  for (const rel of rels) {
    const id = marks.get(rel);
    const f = id ? root.resolve(rel) : null;
    if (!id || !f) continue;
    try {
      const e = hub.edit(root.name, id);
      if (e?.status === "pending" && sha256(new TextDecoder().decode(readFileSync(f.abs))) === e.textSha)
        hub.resolveEdit(root.name, id, { status: "done", note: "The file now has your text." }, "artipeek");
    } catch {}
  }
}

// Under the status bar of a file: its pending edit, or the last one the agent resolved (for a few days).
function editBar(root: Root, rel: string): string {
  const e = hub.shownEdit(root.name, rel, new Date(Date.now() - EDIT_SHOWN_MS).toISOString());
  if (!e) return `<div id="edbar" hidden></div>`;
  const d = editDiff(rel, e.base, e.text);
  const change = `<details><summary>Your change <span class="dstat"><span class="da">+${d.added}</span> <span class="dd">−${d.removed}</span></span></summary>${d.html}${e.note ? `<p class="enoteview">Your note: ${esc(e.note)}</p>` : ""}</details>`;
  if (e.status === "pending") {
    let since = "";
    try { const f = root.resolve(rel); if (f && sha256(new TextDecoder().decode(readFileSync(f.abs))) !== e.baseSha) since = " The file changed since; the agent hasn't marked the edit done yet."; } catch {}
    return `<div id="edbar" class="editbar pending" data-edit="${esc(e.id)}"><p><b>✎ Edit ${esc(e.id)} sent</b> ${ageTag(Date.parse(e.createdAt))}: waiting for the agent to update the file.${since}</p>${change}</div>`;
  }
  const what = e.resolvedBy === "artipeek" ? "The file now has your text." : e.status === "done" ? `The agent updated the file${e.resolution ? `: ${esc(e.resolution)}` : "."}` : `The agent declined it${e.resolution ? `: ${esc(e.resolution)}` : "."}`;
  return `<div id="edbar" class="editbar ${e.status}" data-edit="${esc(e.id)}"><p><b>${e.status === "done" ? "✓" : "✗"} Edit ${esc(e.id)} ${e.status}</b> ${ageTag(Date.parse(e.updatedAt))}. ${what}</p>${change}</div>`;
}

// The edit view's pane: the file's text (or the pending edit's, to change it further), a note, Send.
async function renderEdit(root: Root, rel: string, canEdit: boolean): Promise<string> {
  const view = `${root.base}/view/${encPath(rel)}`;
  const head = `${fileBar(root, rel, ` · editing · <a href="${view}">view</a> · <a href="${root.base}/raw/${encPath(rel)}" target="_blank">raw</a>`)}${statusBar(root, rel)}${editBar(root, rel)}`;
  const stop = (why: string) => `${head}<p class="note">${why} <a href="${view}">Back to the file</a></p>`;
  if (!editable(root)) return stop("Edits go to the folder's agent, and this folder has none (no answers file, no agent token).");
  if (!canEdit) return stop("This device can't send edits. Use the public link (login) or an answer device.");
  const text = await editText(root, rel);
  if (text === null) return stop(`This file can't be edited here (an image, binary, or over ${MAX_EDIT / 1024} kB).`);
  const pending = hub.pendingEdit(root.name, rel);
  const start = pending ? pending.text : text;
  const md = /\.(md|markdown|txt)$/i.test(rel);
  const hint = pending
    ? `You're changing your pending edit <b>${esc(pending.id)}</b>: sending replaces it. <button type="button" class="ewithdraw" data-ewithdraw="${esc(pending.id)}">Take ${esc(pending.id)} back</button>`
    : "Nothing changes here when you send: your edit goes to the folder's agent as a request, and the agent updates the file.";
  // The newline after <textarea> is dropped by the HTML parser, so a file that starts with one keeps it.
  return `${head}<div class="editor" data-start="${sha256(start)}"${pending ? ` data-pending="${esc(pending.id)}"` : ""}><p class="ehint">${hint}</p>`
    + `<p class="echanged" hidden>The file changed on disk since you opened it. <button type="button" data-ereload>Load the new version</button> (drops your changes), or send anyway: artipeek checks first.</p>`
    + `<textarea class="etext" aria-label="Text of ${esc(path.posix.basename(rel))}" spellcheck="${md}" autocapitalize="off" autocomplete="off" autocorrect="off"${md ? "" : ' wrap="off"'}>\n${esc(start)}</textarea>`
    + `<label class="enotel">Note for the agent (optional)<textarea class="enote" rows="2" maxlength="2000"></textarea></label>`
    + `<div class="ebtns"><a class="ecancel" href="${view}">Cancel</a><button type="button" class="esend" data-esend>Send to the agent…</button></div></div>`;
}

// POST /r/<folder>/edit {path, start, text, note, preview?} or {path, withdraw: "E3", preview?}. start = sha256 of the
// text the editor began with: the file's, or the pending edit's. Same rules as answer(): the person only, from
// artipeek's own page.
async function submitEdit(req: Request, rawName: string, scope: Scope, who: Who): Promise<Response> {
  const name = decode(rawName);
  const root = name && (!scope || scope.has(name)) ? roots.get(name) : undefined;
  if (!root || !editable(root)) return notFound();
  const by = answerBy(who);
  if (!by) return jsonRes(403, { ok: false, error: "edits need the public link (login) or a device in answerDevices" });
  if (req.headers.get("sec-fetch-site") !== "same-origin" || req.headers.get("x-artipeek") !== "edit")
    return jsonRes(403, { ok: false, error: "not from artipeek's page" });
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return jsonRes(415, { ok: false, error: "JSON only" });
  const raw = await req.text();
  if (raw.length > 3 * MAX_EDIT) return jsonRes(413, { ok: false, error: "too big" });
  let b: any;
  try { b = JSON.parse(raw); } catch { return jsonRes(400, { ok: false, error: "bad JSON" }); }
  const f = typeof b?.path === "string" && b.path.length <= 1000 ? root.resolve(b.path) : null;
  if (!f) return jsonRes(404, { ok: false, error: "no such file" });
  const cur = await editText(root, f.rel);
  if (cur === null) return jsonRes(400, { ok: false, error: "this file can't be edited here" });
  const pending = hub.pendingEdit(root.name, f.rel);
  const preview = b.preview === true;
  const withdraw = async (e: Edit) => {
    if (preview) return jsonRes(200, { ok: true, preview: true, withdraw: e.id });
    const w = hub.withdrawEdit(root.name, e.id);
    const committed = await deliverEdit(root, w, "withdrawn", by);
    return jsonRes(200, { ok: true, id: w.id, withdrawn: true, at: w.updatedAt, committed });
  };
  if (b.withdraw !== undefined) {
    if (!pending || pending.id !== b.withdraw) return jsonRes(409, { ok: false, error: "that edit is no longer pending" });
    return withdraw(pending);
  }
  if (typeof b.text !== "string" || b.text.length > MAX_EDIT) return jsonRes(400, { ok: false, error: `send the text (at most ${MAX_EDIT / 1024} kB)` });
  let text = b.text.replace(/\r\n?/g, "\n");
  if (cur.includes("\r\n")) text = text.replace(/\n/g, "\r\n"); // keep the file's line endings
  const note = typeof b.note === "string" ? b.note.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, 2000) || null : null;
  if (b.start !== sha256(cur) && !(pending && b.start === pending.textSha))
    return jsonRes(409, { ok: false, changed: true, error: "The file changed since you opened it. Load the new version, then make your change again." });
  if (text === cur) {
    if (!pending) return jsonRes(400, { ok: false, error: "Nothing to send: this is the file as it is." });
    return withdraw(pending); // the file's own text again: take the pending edit back
  }
  if (pending && text === pending.text) return jsonRes(400, { ok: false, error: `That's your edit ${pending.id} as it is; it's already with the agent.` });
  const d = editDiff(f.rel, cur, text);
  if (preview) return jsonRes(200, { ok: true, preview: true, added: d.added, removed: d.removed, diff: d.html, replaces: pending?.id ?? null });
  const e = hub.createEdit({ project: root.name, path: f.rel, base: cur, text, note, by });
  const committed = await deliverEdit(root, e, "sent", by);
  return jsonRes(200, { ok: true, id: e.id, at: e.createdAt, replaces: e.replaces, committed });
}
// Tells the agent: one line in the answers file (+ commit + after), when the folder has one. It is in the hub already
// (GET /api/answers lists it as kind "edit").
async function deliverEdit(root: Root, e: Edit, what: "sent" | "withdrawn", by: string): Promise<boolean> {
  const cfg = answersFor.get(root.name);
  if (!cfg) { console.log(`artipeek: edit ${e.id} ${what} in the hub for ${root.name} by ${by}`); return false; }
  const rec: Record<string, string> = { at: what === "sent" ? e.createdAt : e.updatedAt, uid: randomBytes(6).toString("hex"), id: e.id, text: editLine(e, what), by, page: e.path, kind: "edit" };
  const job = (answerQueue.get(root.name) ?? Promise.resolve()).then(() => saveAnswer(root, cfg, rec));
  answerQueue.set(root.name, job.catch(() => {}));
  try {
    const committed = await job;
    console.log(`artipeek: edit ${e.id} ${what === "sent" ? "saved" : "withdrawn"} in ${root.name} by ${by}${committed ? ", committed" : ", not committed"}`);
    return committed;
  } catch (err) {
    console.log(`artipeek: edit ${e.id} for ${root.name} not in the answers file: ${(err as Error).message}`);
    return false;
  }
}

const server = Bun.serve({ hostname: HOST, port: PORT, idleTimeout: 0 /* SSE streams stay open */, fetch: (req) => handle(req) });
console.log(`artipeek: http://${HOST}:${server.port}  config=${CONFIG_PATH}  roots=${[...roots.keys()].join(",")}`);
for (const r of roots.values()) checkEdits(r, [...marksFor(r).keys()]); // files the agent changed while artipeek was off

// ---------- tailnet ----------
// Also listen on this machine's Tailscale IPv4 (100.x). The laptop can switch tailnets (its IP
// changes) and Tailscale may start after us, so check every 15 s and move the listener.
// Device check: served only if `tailscale whois` names a device <host>.<tailnet> with host in
// allowDevices and tailnet in tailnets. Everything else gets 403. 127.0.0.1 is always served.
const ALLOW_DEVICES = new Set((config0.allowDevices ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean));
const TAILNETS = (config0.tailnets ?? []).map((x) => x.trim().toLowerCase().replace(/^\.|\.$/g, "")).filter(Boolean);
const whoisCache = new Map<string, { name: string; until: number }>();

async function whoisName(ip: string): Promise<string> {
  const c = whoisCache.get(ip);
  if (c && c.until > Date.now()) return c.name;
  let name = "";
  try {
    const pr = Bun.spawn(["tailscale", "whois", "--json", ip], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(pr.stdout).text();
    if ((await pr.exited) === 0) name = String(JSON.parse(out).Node?.Name ?? "").toLowerCase().replace(/\.$/, "");
  } catch {}
  whoisCache.set(ip, { name, until: Date.now() + 60_000 });
  return name;
}
function deviceAllowed(nodeName: string): boolean {
  const dot = nodeName.indexOf(".");
  if (dot < 1) return false;
  return ALLOW_DEVICES.has(nodeName.slice(0, dot)) && TAILNETS.includes(nodeName.slice(dot + 1));
}

if (config0.tailnet) {
  if (!ALLOW_DEVICES.size || !TAILNETS.length) {
    console.log("artipeek (tailnet): allowDevices and tailnets are required; tailnet listener off");
  } else {
    let current: { ip: string; srv: ReturnType<typeof Bun.serve> } | null = null;
    const guarded = async (req: Request, srv: ReturnType<typeof Bun.serve>): Promise<Response> => {
      const ip = srv.requestIP(req)?.address ?? "";
      const name = ip ? await whoisName(ip) : "";
      if (!deviceAllowed(name)) {
        console.log(`artipeek (tailnet): refused ${ip} (${name || "unknown"}) ${req.method} ${new URL(req.url).pathname.slice(0, 80)}`);
        return new Response("This device is not allowed.\n", { status: 403, headers: { ...SEC_HEADERS, "Content-Type": "text/plain" } });
      }
      return handle(req, null, { device: name });
    };
    const check = () => {
      const r = Bun.spawnSync(["tailscale", "ip", "-4"], { stdout: "pipe", stderr: "pipe" });
      const ip = r.exitCode === 0 ? r.stdout.toString().trim().split("\n")[0] : "";
      if (current && current.ip === ip) return;
      if (current) {
        current.srv.stop(true);
        console.log(`artipeek (tailnet): ${current.ip} gone, listener stopped`);
        current = null;
        whoisCache.clear();
      }
      if (!/^100\.\d+\.\d+\.\d+$/.test(ip)) return;
      try {
        const srv = Bun.serve({ hostname: ip, port: PORT, idleTimeout: 0, fetch: guarded });
        current = { ip, srv };
        const st = Bun.spawnSync(["tailscale", "status", "--self", "--peers=false", "--json"], { stdout: "pipe" });
        let name = "";
        try { name = String(JSON.parse(st.stdout.toString()).Self?.DNSName ?? "").replace(/\.$/, ""); } catch {}
        console.log(`artipeek (tailnet): http://${ip}:${PORT}${name ? `  http://${name}:${PORT}` : ""}  allow=${[...ALLOW_DEVICES].join(",")} tailnets=${TAILNETS.join(",")}`);
      } catch {
        console.log(`artipeek (tailnet): bind ${ip}:${PORT} failed, retry in 15 s`);
      }
    };
    check();
    setInterval(check, 15_000);
  }
}

// ---------- public (Cloudflare Tunnel + Access) ----------
// cloudflared connects from 127.0.0.1, and the main listener trusts 127.0.0.1. So the tunnel must
// point at this separate listener instead, where every request needs a valid Cloudflare Access JWT
// (header Cf-Access-Jwt-Assertion, or the CF_Authorization cookie): RS256 signature against the
// team's certs, aud, iss, exp/nbf, and an email from public.emails. Anything else gets 403. Only the
// folders in public.roots exist here. This holds even if the Access app is misconfigured or deleted.
type Jwk = JsonWebKey & { kid?: string };
const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const b64json = (s: string) => JSON.parse(new TextDecoder().decode(b64url(s)));

function makeAccessVerifier(pub: NonNullable<Config["public"]>) {
  const team = pub.teamDomain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const iss = `https://${team}`;
  const certsUrl = pub.certsUrl ?? `${iss}/cdn-cgi/access/certs`;
  const aud = pub.aud.trim();
  const emails = new Set(pub.emails.map((e) => e.trim().toLowerCase()).filter(Boolean));
  let keys = new Map<string, CryptoKey>();
  let fetchedAt = 0;
  let inflight: Promise<void> | null = null;

  async function refresh() {
    const r = await fetch(certsUrl, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`certs ${r.status}`);
    const body = (await r.json()) as { keys?: Jwk[] };
    const next = new Map<string, CryptoKey>();
    for (const k of body.keys ?? []) {
      if (!k.kid || k.kty !== "RSA") continue;
      try { next.set(k.kid, await crypto.subtle.importKey("jwk", k, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"])); } catch {}
    }
    if (next.size) keys = next;
    fetchedAt = Date.now();
  }
  async function keyFor(kid: string): Promise<CryptoKey | undefined> {
    const stale = Date.now() - fetchedAt > 3600_000;
    // Unknown kid (keys rotated): refetch, at most every 30 s.
    if (stale || (!keys.has(kid) && Date.now() - fetchedAt > 30_000)) {
      inflight ??= refresh().catch((e) => console.log(`artipeek (public): certs fetch failed: ${(e as Error).message}`)).finally(() => { inflight = null; });
      await inflight;
    }
    return keys.get(kid);
  }

  // Returns the email if the token is good, else a short reason (never the token).
  return async function verify(req: Request): Promise<{ email: string } | { reason: string }> {
    let tok = req.headers.get("cf-access-jwt-assertion") ?? "";
    if (!tok) tok = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1] ?? "";
    if (!tok) return { reason: "no token" };
    const parts = tok.split(".");
    if (parts.length !== 3) return { reason: "malformed" };
    let h: any, p: any;
    try { h = b64json(parts[0]); p = b64json(parts[1]); } catch { return { reason: "malformed" }; }
    if (h?.alg !== "RS256" || typeof h.kid !== "string") return { reason: "bad alg/kid" };
    const key = await keyFor(h.kid);
    if (!key) return { reason: "unknown kid" };
    let good = false;
    try { good = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`)); } catch {}
    if (!good) return { reason: "bad signature" };
    const now = Date.now() / 1000;
    const auds = Array.isArray(p.aud) ? p.aud : [p.aud];
    if (!auds.includes(aud)) return { reason: "wrong aud" };
    if (p.iss !== iss) return { reason: "wrong iss" };
    if (typeof p.exp !== "number" || p.exp < now - 30) return { reason: "expired" };
    if (typeof p.nbf === "number" && p.nbf > now + 30) return { reason: "not yet valid" };
    const email = String(p.email ?? "").toLowerCase();
    if (!emails.has(email)) return { reason: `email not allowed (${email.slice(0, 80) || "none"})` };
    return { email };
  };
}

if (config0.public) {
  const pub = config0.public;
  const okCfg = Number.isInteger(pub.port) && pub.port > 0 && pub.port !== PORT && typeof pub.teamDomain === "string" && pub.teamDomain
    && typeof pub.aud === "string" && pub.aud && Array.isArray(pub.emails) && pub.emails.length && Array.isArray(pub.roots);
  if (!okCfg) {
    console.log("artipeek (public): needs port (not the main port), teamDomain, aud, emails, roots; public listener off");
  } else {
    const verify = makeAccessVerifier(pub);
    const scope: Scope = new Set(pub.roots.filter((n) => typeof n === "string" && NAME_RE.test(n)));
    const srv = Bun.serve({
      hostname: HOST, port: pub.port, idleTimeout: 0,
      fetch: async (req) => {
        const v = await verify(req);
        if ("reason" in v) {
          console.log(`artipeek (public): refused (${v.reason}) ${req.method} ${new URL(req.url).pathname.slice(0, 80)}`);
          return new Response("Forbidden\n", { status: 403, headers: { ...SEC_HEADERS, "Content-Type": "text/plain" } });
        }
        return handle(req, scope, { email: v.email });
      },
    });
    console.log(`artipeek (public): http://${HOST}:${srv.port} (Cloudflare Access ${pub.teamDomain}, roots=${[...scope].join(",")})`);
  }
}
