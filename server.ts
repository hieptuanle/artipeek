// artipeek: read-only preview of several folders (repos) in a browser, built for the phone.
//
// - Folders ("roots") come from a JSON config file, re-read when it changes.
// - Only files git would list (tracked + untracked-not-ignored) are listed or served, minus a hard
//   deny list (env files, keys). Every path resolves inside its root (symlinks too).
// - GET/HEAD only. Listens on 127.0.0.1 and, if enabled, on this machine's Tailscale IP, where every
//   request is checked with `tailscale whois` against an allow-list of devices.
// - Optional public listener (config "public") for Cloudflare Tunnel: every request needs a valid
//   Cloudflare Access JWT, and only public.roots exist there.
// - Never logs file contents. Sends nothing anywhere (except fetching the Access certs).
//
//   bun server.ts [--config FILE] [--port N]

import { watch, realpathSync, lstatSync, statSync, readdirSync, readFileSync, existsSync, openSync, readSync, closeSync, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import MarkdownIt from "markdown-it";
import anchor from "markdown-it-anchor";
import footnote from "markdown-it-footnote";
import taskLists from "markdown-it-task-lists";
import hljs from "highlight.js";
import { iconFor, DIR_ICON, ICON_CSS } from "./icons.ts";

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
  roots: { name: string; path: string }[];
  // Public listener for Cloudflare Tunnel + Access. Every request needs a valid Access JWT.
  public?: {
    port: number;
    teamDomain: string; // <team>.cloudflareaccess.com
    aud: string; // Access application AUD tag
    emails: string[];
    roots: string[]; // only these folders exist on this listener
    certsUrl?: string; // tests only: default https://<teamDomain>/cdn-cgi/access/certs
  };
};
function readConfig(): Config {
  const c = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Config;
  if (!Array.isArray(c.roots)) throw new Error("config: roots must be a list");
  return c;
}
const config0 = readConfig();
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

// ---------- status ("Status:" line near the top of a Markdown file) ----------
// Agents write e.g. "STATUS: **SENT 2026-10-15 …**", "- Status: for your yes", "Status: drafted …; not sent".
// The first such line in the first 20 lines gives the file a status. A folder takes the status of its
// README.md / index.md or, if every Markdown file directly inside it has the same status, that status.
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
  const label = kind !== "other" ? kind : (/^[a-z][a-z-]*/.exec(t)?.[0] ?? "status").slice(0, 14);
  return { kind, label, text, from };
}
function readStatus(abs: string, rel: string): Status | null {
  let head = "";
  try {
    const fd = openSync(abs, "r");
    try { const b = Buffer.alloc(4096); head = b.subarray(0, readSync(fd, b, 0, 4096, 0)).toString("utf8"); } finally { closeSync(fd); }
  } catch { return null; }
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
const dirOf = (rel: string) => { const i = rel.lastIndexOf("/"); return i < 0 ? "" : rel.slice(0, i); };
const statusBadge = (st: Status | null | undefined) =>
  st ? `<span class="st st-${st.kind}" title="${esc(st.text)}">${esc(st.label)}</span>` : "";

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
      if (!isMd(rel)) continue;
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
      const main = list.find((st) => /^(readme|index)\.(md|markdown)$/i.test(st.from.slice(d ? d.length + 1 : 0)));
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
    if (changed.length) this.broadcast("change", changed);
  }

  broadcast(event: string, data: unknown) {
    const msg = enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    for (const c of this.clients) { try { c.enqueue(msg); } catch { this.clients.delete(c); } }
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
// A scope limits which folders exist for a listener (null = all; the public listener passes its list).
type Scope = Set<string> | null;
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
  for (const r of cfg.roots) {
    if (!r || typeof r.name !== "string" || !NAME_RE.test(r.name)) { console.log(`artipeek: bad root name ${JSON.stringify(r?.name)}`); continue; }
    try {
      const dir = realpathSync(path.resolve(expandHome(String(r.path))));
      if (!statSync(dir).isDirectory()) throw new Error("not a folder");
      if (dir === "/" || dir === os.homedir()) throw new Error("too wide (/ or home)");
      want.set(r.name, dir);
    } catch (e) {
      console.log(`artipeek: root ${r.name} skipped: ${(e as Error).message}`);
    }
  }
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
    watch(path.dirname(CONFIG_PATH), () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => { t = null; if (existsSync(CONFIG_PATH)) loadRoots(); }, 300);
    });
  } catch {}
}

setInterval(() => {
  const ping = enc.encode(`: ping\n\n`);
  for (const r of roots.values()) for (const c of r.clients) { try { c.enqueue(ping); } catch { r.clients.delete(c); } }
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

async function renderMain(root: Root, rel: string, abs: string): Promise<string> {
  const e = root.files.get(rel)!;
  const ext = extOf(rel);
  const raw = `${root.base}/raw/${encPath(rel)}`;
  const dir = path.posix.dirname(rel);
  const head = `<div class="filebar">${MENU_BTN}<span class="crumbs" title="${esc(root.name + "/" + rel)}">${iconFor(rel, ext)} <span class="rootname">${esc(root.name)}/</span>${dir !== "." ? `<span class="dirname">${esc(dir)}/</span>` : ""}<b>${esc(path.posix.basename(rel))}</b></span><span class="meta">${fmtSize(e.size)} · ${ageTag(e.mtime)} · <a href="${raw}" target="_blank">raw</a></span></div>${statusBar(root, rel)}`;

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
  return `${head}${cut}<pre class="hljs code"><code>${highlight(text, lang)}</code></pre>`;
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

function renderSidebar(root: Root, current: string, sort: Sort = "name"): string {
  // Tree rows show a file's own status (its folder row shows the folder's); Recent also shows the folder's.
  const own = (rel: string) => root.status.get(rel);
  const link = (rel: string, label: string, withAge = false, st: (rel: string) => Status | undefined = own) =>
    `<a href="${root.base}/view/${encPath(rel)}" data-path="${esc(rel)}"${rel === current ? ' class="current"' : ""}>${iconFor(rel, extOf(rel))}<span class="name">${esc(label)}</span>${statusBadge(st(rel))}${withAge ? ageTag(root.files.get(rel)!.mtime) : ""}</a>`;
  const rec = root.recent().map((e) => `<li>${link(e.rel, e.rel, true, (r) => root.statusFor(r))}</li>`).join("");
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
        html: () => `<li class="dir"><details data-dir="${esc(p)}"${open}><summary>${DIR_ICON}<span class="name">${esc(d)}</span>${byTime ? ageTag(child.mtime) : ""}${statusBadge(root.dirStatus.get(p))}</summary><ul>${walk(child, p)}</ul></details></li>`,
      });
    }
    for (const f of n.files) {
      const name = path.posix.basename(f);
      items.push({ kind: 1, name, mtime: root.files.get(f)!.mtime, html: () => `<li class="file">${link(f, name, byTime)}</li>` });
    }
    items.sort(byTime
      ? (a, b) => b.mtime - a.mtime || a.kind - b.kind || collator.compare(a.name, b.name)
      : (a, b) => a.kind - b.kind || collator.compare(a.name, b.name));
    return items.map((i) => i.html()).join("");
  };
  return `<details class="recent" open><summary>Recent</summary><ul>${rec}</ul></details><ul class="tree" data-sort="${sort}">${walk(root.tree(), "")}</ul>`;
}

function rootSwitcher(current: string, scope: Scope): string {
  const items = visibleRoots(scope)
    .map((r) => `<li><a href="${r.base}/"${r.name === current ? ' class="current"' : ""}>${esc(r.name)}</a></li>`)
    .join("");
  return `<details class="roots"><summary>${esc(current)}</summary><ul><li><a href="/">All folders</a></li>${items}</ul></details>`;
}

const CLIENT_JS = `
(() => {
  const body = document.body;
  const base = body.dataset.base || "";
  const cur = body.dataset.path || "";
  const main = document.getElementById("main");
  const tree = document.getElementById("tree");
  const filter = document.getElementById("filter");

  // phone menu (drawer)
  const closeNav = () => body.classList.remove("nav-open");
  document.addEventListener("click", (e) => {
    const t = e.target.closest ? e.target : null;
    if (t && t.closest("[data-menu]")) { body.classList.toggle("nav-open"); return; }
    if (t && t.closest("#scrim")) closeNav();
  });
  addEventListener("keydown", (e) => { if (e.key === "Escape") closeNav(); });

  function ages(scope) {
    const now = Date.now();
    (scope || document).querySelectorAll(".age[data-mtime]").forEach((el) => {
      const s = Math.max(0, Math.round((now - Number(el.dataset.mtime)) / 1000));
      el.textContent = s < 60 ? "now" : s < 3600 ? Math.floor(s / 60) + "m" : s < 86400 ? Math.floor(s / 3600) + "h"
        : s < 31536000 ? Math.floor(s / 86400) + "d" : Math.floor(s / 31536000) + "y";
    });
  }
  setInterval(ages, 30000);
  if (!tree) return; // home page

  const KEY = "artipeek-open:" + base;
  const load = () => { try { return new Set(JSON.parse(localStorage.getItem(KEY) || "[]")); } catch { return new Set(); } };
  const save = (s) => { try { localStorage.setItem(KEY, JSON.stringify([...s])); } catch {} };
  function restore() {
    const open = load();
    tree.querySelectorAll("details[data-dir]").forEach((d) => {
      if (open.has(d.dataset.dir)) d.open = true;
      d.addEventListener("toggle", () => { const s = load(); d.open ? s.add(d.dataset.dir) : s.delete(d.dataset.dir); save(s); });
    });
    applyFilter();
  }
  function applyFilter() {
    const q = filter.value.trim().toLowerCase();
    tree.querySelectorAll("ul.tree li.file").forEach((li) => {
      li.hidden = !!q && !li.firstElementChild.dataset.path.toLowerCase().includes(q);
    });
    tree.querySelectorAll("ul.tree li.dir").forEach((li) => {
      li.hidden = !!q && !li.querySelector("li.file:not([hidden])");
      if (q) li.firstElementChild.open = true;
    });
    const r = tree.querySelector("details.recent"); if (r) r.hidden = !!q;
  }
  filter.addEventListener("input", applyFilter);
  filter.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { const a = tree.querySelector("ul.tree li.file:not([hidden]) a"); if (a) location.href = a.href; }
    if (e.key === "Escape") { filter.value = ""; applyFilter(); }
  });
  const sortBtns = document.querySelectorAll("#sort button");
  const getSort = () => { const b = document.querySelector('#sort button[aria-pressed="true"]'); return b ? b.dataset.sort : "name"; };
  async function refreshTree() {
    const r = await fetch(base + "/part/tree?current=" + encodeURIComponent(cur) + "&sort=" + getSort());
    if (r.ok) { const top = tree.scrollTop; tree.innerHTML = await r.text(); restore(); tree.scrollTop = top; }
  }
  sortBtns.forEach((b) => b.addEventListener("click", () => {
    if (b.getAttribute("aria-pressed") === "true") return;
    sortBtns.forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    document.cookie = "${SORT_COOKIE}=" + b.dataset.sort + "; Path=/; Max-Age=31536000; SameSite=Lax";
    refreshTree();
  }));
  restore();
  const c = tree.querySelector("ul.tree a.current"); if (c) tree.scrollTop = c.offsetTop - tree.clientHeight / 2;

  function connect() {
    const es = new EventSource(base + "/events");
    es.addEventListener("change", async (ev) => {
      const paths = JSON.parse(ev.data);
      const curDir = cur.includes("/") ? cur.slice(0, cur.lastIndexOf("/")) : "";
      const nextToCur = (p) => /\\.(md|markdown)$/i.test(p) && (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "") === curDir;
      if (cur && !paths.includes(cur) && paths.some(nextToCur)) {
        const r = await fetch(base + "/part/status/" + cur.split("/").map(encodeURIComponent).join("/"));
        const el = document.getElementById("stbar");
        if (r.ok && el) el.outerHTML = await r.text();
      }
      if (cur && paths.includes(cur)) {
        const r = await fetch(base + "/part/main/" + cur.split("/").map(encodeURIComponent).join("/"));
        if (r.ok) { const y = scrollY; main.innerHTML = await r.text(); scrollTo(0, y); }
        else if (r.status === 404) main.innerHTML = '<div class="filebar"><button type="button" class="menu" data-menu>☰</button></div><p class="note">This file was removed.</p>';
      }
    });
    es.addEventListener("tree", refreshTree);
    es.onerror = () => body.classList.add("offline");
    es.onopen = () => body.classList.remove("offline");
  }
  connect();
})();
`;

const CSS = ICON_CSS + `
:root { color-scheme: light dark; --bg:#fff; --fg:#1f2328; --muted:#59636e; --side:#f6f8fa; --line:#d1d9e0; --accent:#0969da; --cur:#ddf4ff; --code:#f6f8fa; }
@media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --fg:#e6edf3; --muted:#9198a1; --side:#151b23; --line:#30363d; --accent:#4493f8; --cur:#1f3a5f; --code:#151b23; } }
* { box-sizing: border-box; }
html, body { margin:0; background:var(--bg); color:var(--fg); font: 15px/1.55 -apple-system, "Segoe UI", system-ui, sans-serif; -webkit-text-size-adjust:100%; }
body.app { display:grid; grid-template-columns: minmax(220px, 320px) 1fr; min-height:100dvh; }
aside { background:var(--side); border-right:1px solid var(--line); height:100dvh; display:flex; flex-direction:column; position:sticky; top:0; }
aside header { padding:10px 12px 8px; border-bottom:1px solid var(--line); }
.headrow { display:flex; align-items:center; gap:8px; }
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
#tree summary .fi { margin-right:5px; }
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
#tree summary .st { float:right; margin:2px 6px 0 0; } /* after the age in the HTML, so it sits left of it */
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
.filebar { position:sticky; top:0; background:var(--bg); display:flex; align-items:center; gap:10px; padding:10px 0; border-bottom:1px solid var(--line); margin-bottom:16px; font-size:13px; z-index:2; }
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
.markdown blockquote { margin:0; padding:0 1em; color:var(--muted); border-left:.25em solid var(--line); }
.markdown img { max-width:100%; }
.markdown li.task-list-item { list-style:none; margin-left:-1.3em; }
.markdown .footnotes { font-size:.9em; color:var(--muted); }
table.frontmatter { font-size:13px; margin-top:0 !important; }
table.frontmatter th { text-align:left; color:var(--muted); font-weight:500; }
.wikilink.broken { color:#d1242f; border-bottom:1px dashed; }
a.missing { color:#d1242f; }
iframe.htmlframe { width:100%; height:calc(100dvh - 100px); border:1px solid var(--line); border-radius:6px; background:#fff; }
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
/* highlight.js: GitHub-like light/dark */
.hljs-comment,.hljs-quote{color:#6e7781}.hljs-keyword,.hljs-selector-tag,.hljs-type{color:#cf222e}.hljs-string,.hljs-regexp,.hljs-addition{color:#0a3069}.hljs-number,.hljs-literal,.hljs-built_in,.hljs-attr,.hljs-variable,.hljs-template-variable{color:#0550ae}.hljs-title,.hljs-section,.hljs-name{color:#8250df}.hljs-deletion{color:#82071e}.hljs-meta{color:#953800}
@media (prefers-color-scheme: dark){.hljs-comment,.hljs-quote{color:#8b949e}.hljs-keyword,.hljs-selector-tag,.hljs-type{color:#ff7b72}.hljs-string,.hljs-regexp,.hljs-addition{color:#a5d6ff}.hljs-number,.hljs-literal,.hljs-built_in,.hljs-attr,.hljs-variable,.hljs-template-variable{color:#79c0ff}.hljs-title,.hljs-section,.hljs-name{color:#d2a8ff}.hljs-deletion{color:#ffa198}.hljs-meta{color:#ffa657}}
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
  #tree a, #tree summary { padding:6px 8px; }
  #sort button { font-size:12px; padding:4px 9px; }
  #filter { font-size:16px; } /* no iOS zoom on focus */
  pre.hljs { font-size:12px; }
  iframe.htmlframe { height:calc(100dvh - 70px); }
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
<script nonce="${opts.nonce}">${CLIENT_JS}</script></body></html>`;
}

function filePage(root: Root, current: string, mainHtml: string, nonce: string, sort: Sort, scope: Scope): string {
  const aside = `<aside><header><div class="headrow">${rootSwitcher(root.name, scope)}<span id="sort" role="group" aria-label="Sort"><button type="button" data-sort="name" aria-pressed="${sort === "name"}">Name</button><button type="button" data-sort="mtime" aria-pressed="${sort === "mtime"}">Modified</button></span></div><input id="filter" type="search" placeholder="Filter files…" autocomplete="off" enterkeyhint="go"></header>
<nav id="tree">${renderSidebar(root, current, sort)}</nav></aside>`;
  return shell({ title: path.posix.basename(current) || root.name, bodyClass: "app", data: { base: root.base, path: current }, aside, main: mainHtml, nonce });
}

function homePage(nonce: string, scope: Scope): string {
  const cards = visibleRoots(scope).map((r) => {
    const rec = r.recent(5).map((e) => `<li><a href="${r.base}/view/${encPath(e.rel)}">${iconFor(e.rel, extOf(e.rel))}<span class="name">${esc(e.rel)}</span>${statusBadge(r.statusFor(e.rel))}${ageTag(e.mtime)}</a></li>`).join("");
    return `<section class="rootcard"><h2><a href="${r.base}/">${esc(r.name)}</a><span class="count">${r.files.size} files</span></h2><ul>${rec}</ul></section>`;
  }).join("");
  return shell({ title: "Folders", bodyClass: "home", main: `<div class="home"><h1>artipeek</h1>${cards || '<p class="note">No folders in the config.</p>'}</div>`, nonce });
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

async function handle(req: Request, scope: Scope = null): Promise<Response> {
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
    return new Response(renderSidebar(root, url.searchParams.get("current") ?? "", sort), { headers: HTML });
  }

  const am = /^\/(view|raw|part\/main|part\/status)\/(.+)$/.exec(rest);
  if (!am) return notFound();
  const rel = decode(am[2]);
  const f = rel ? root.resolve(rel) : null;
  if (!f) return notFound();

  if (am[1] === "part/status") return new Response(statusBar(root, f.rel), { headers: HTML });
  if (am[1] === "raw") {
    const ext = extOf(f.rel);
    // HTML may run its own inline scripts only inside artipeek's file page: the browser says so with
    // Sec-Fetch-Dest: iframe + Sec-Fetch-Site: same-origin, and that page's CSP (frame-src 'self') stops the
    // frame from navigating to another site. Opened directly in a tab (or framed by another site), a page
    // could navigate itself elsewhere and take its own text along, so there it gets no scripts at all.
    const inOurFrame = req.headers.get("sec-fetch-dest") === "iframe" && req.headers.get("sec-fetch-site") === "same-origin";
    const type = MIME[ext] ?? "text/plain; charset=utf-8";
    return new Response(Bun.file(f.abs), {
      headers: {
        ...SEC_HEADERS,
        "Content-Type": type,
        // Raw files always get an opaque origin (no cookies, no same-origin reads) and no fetch/XHR/remote loads.
        "Content-Security-Policy": (ext === "html" || ext === "htm") && inOurFrame ? RAW_CSP_HTML : RAW_CSP,
        Vary: "Sec-Fetch-Dest, Sec-Fetch-Site",
      },
    });
  }
  const mainHtml = await renderMain(root, f.rel, f.abs);
  if (am[1] === "part/main") return new Response(mainHtml, { headers: HTML });
  const nonce = randomBytes(16).toString("base64");
  const { sort, fromParam } = sortFrom(req, url);
  return new Response(filePage(root, f.rel, mainHtml, nonce, sort, scope), {
    headers: { ...HTML, ...(fromParam ? { "Set-Cookie": sortCookie(sort) } : {}), "Content-Security-Policy": pageCsp(nonce) },
  });
}

const server = Bun.serve({ hostname: HOST, port: PORT, idleTimeout: 0 /* SSE streams stay open */, fetch: (req) => handle(req) });
console.log(`artipeek: http://${HOST}:${server.port}  config=${CONFIG_PATH}  roots=${[...roots.keys()].join(",")}`);

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
      return handle(req);
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
        return handle(req, scope);
      },
    });
    console.log(`artipeek (public): http://${HOST}:${srv.port} (Cloudflare Access ${pub.teamDomain}, roots=${[...scope].join(",")})`);
  }
}
