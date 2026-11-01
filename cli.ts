#!/usr/bin/env bun
// artipeek admin CLI. Edits ~/.config/artipeek/config.json (atomic write), restarts the service when a
// setting is read only at start, and talks to Cloudflare with ~/.config/artipeek/cf-token (never printed).
//   artipeek help
import { readFileSync, writeFileSync, renameSync, existsSync, realpathSync, statSync, copyFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const HOME = os.homedir();
const expandHome = (p: string) => (p === "~" || p.startsWith("~/") ? path.join(HOME, p.slice(1)) : p);
const CONFIG = path.resolve(expandHome(process.env.ARTIPEEK_CONFIG ?? "~/.config/artipeek/config.json"));
const TOKEN_FILE = path.join(path.dirname(CONFIG), "cf-token");
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SERVICE = "artipeek";

type CfIds = { accountId: string; zoneId: string; tunnelId: string; appId: string; policyId: string; dnsId: string };
type Config = {
  port?: number; tailnet?: boolean; tailnets?: string[]; allowDevices?: string[];
  roots: { name: string; path: string }[];
  public?: { port: number; hostname?: string; teamDomain: string; aud: string; emails: string[]; roots: string[]; cloudflare?: CfIds; certsUrl?: string };
  [k: string]: unknown;
};

// ---------- output ----------
const tty = process.stdout.isTTY;
const c = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = c(32), red = c(31), yellow = c(33), dim = c(2), bold = c(1);
class Fail extends Error {}
const die = (msg: string): never => { throw new Fail(msg); };

// ---------- config ----------
function load(): Config {
  if (!existsSync(CONFIG)) die(`no config at ${CONFIG}`);
  const cfg = JSON.parse(readFileSync(CONFIG, "utf8")) as Config;
  if (!Array.isArray(cfg.roots)) die("config: roots must be a list");
  return cfg;
}
function save(cfg: Config) {
  copyFileSync(CONFIG, CONFIG + ".prev"); // one-step undo: artipeek undo-config
  const tmp = CONFIG + ".tmp";
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o644 });
  renameSync(tmp, CONFIG);
}
const needPublic = (cfg: Config) => cfg.public ?? die("no `public` section in the config");
// The public hostname (e.g. artipeek.example.com), from public.hostname.
const hostOf = (cfg: Config) => needPublic(cfg).hostname ?? die("config: public.hostname missing");

// ---------- service ----------
function sh(cmd: string[], opts: { inherit?: boolean } = {}) {
  const r = Bun.spawnSync(cmd, { stdout: opts.inherit ? "inherit" : "pipe", stderr: opts.inherit ? "inherit" : "pipe" });
  return { code: r.exitCode, out: r.stdout?.toString() ?? "", err: r.stderr?.toString() ?? "" };
}
function restart(why: string) {
  if (process.env.ARTIPEEK_NO_RESTART) return console.log(dim(`(restart skipped: ${why})`)); // tests
  console.log(dim(`restarting ${SERVICE} (${why})…`));
  const r = sh(["systemctl", "--user", "restart", SERVICE]);
  if (r.code !== 0) die(`restart failed: ${r.err.trim()}`);
  Bun.sleepSync(1500);
  const a = sh(["systemctl", "--user", "is-active", SERVICE]).out.trim();
  console.log(a === "active" ? green("service active") : red(`service ${a}; see: artipeek logs`));
}
async function httpCode(url: string, headers: Record<string, string> = {}): Promise<string> {
  try {
    const r = await fetch(url, { redirect: "manual", headers, signal: AbortSignal.timeout(8000) });
    return String(r.status);
  } catch { return "down"; }
}

// ---------- cloudflare ----------
async function cf(method: string, p: string, body?: unknown): Promise<any> {
  if (!existsSync(TOKEN_FILE)) die(`no API token at ${TOKEN_FILE}`);
  const token = readFileSync(TOKEN_FILE, "utf8").trim();
  const r = await fetch(`https://api.cloudflare.com/client/v4${p}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  const d = (await r.json().catch(() => ({}))) as any;
  if (!d.success) die(`Cloudflare ${method} ${p.replace(/[0-9a-f-]{32,36}/g, "…")}: ${JSON.stringify(d.errors ?? r.status)}`);
  return d.result;
}
const ids = (cfg: Config): CfIds => needPublic(cfg).cloudflare ?? die("config: public.cloudflare (Cloudflare IDs) missing");

// Make the Access policy allow exactly these emails (keeps the policy's other fields).
async function syncPolicy(cfg: Config, emails: string[]) {
  const i = ids(cfg);
  const base = `/accounts/${i.accountId}/access/apps/${i.appId}/policies/${i.policyId}`;
  const pol = await cf("GET", base);
  const body = {
    name: pol.name, decision: pol.decision, precedence: pol.precedence, session_duration: pol.session_duration,
    include: emails.map((email) => ({ email: { email } })), exclude: pol.exclude ?? [], require: pol.require ?? [],
  };
  await cf("PUT", base, body);
  console.log(green(`Access policy now allows: ${emails.join(", ")}`));
}

// ---------- commands ----------
const usage = `${bold("artipeek")}: manage the artipeek file preview

${bold("Overview")}
  status                       service, listeners, folders, public link
  check                        Cloudflare: app, policy, DNS, tunnel rule, token expiry

${bold("Folders")} (picked up within a second, no restart)
  folders                      list folders (★ = also on the public link)
  add <name> <path> [--public] add a folder
  remove <name>                remove a folder (also from the public link)
  rename <old> <new>           rename a folder (URLs change)

${bold("Public link")} public.hostname via Cloudflare Tunnel + Access (restarts the service)
  public                       list public folders
  public add <name>            show a folder on the public link
  public remove <name>         hide it from the public link

${bold("Who may log in")} (updates the Cloudflare Access policy + artipeek's own check)
  emails                       list allowed emails
  emails add <email>
  emails remove <email>
  emails sync                  push the config's list to the Access policy (if \`check\` shows a mismatch)

${bold("Tailnet devices")} (restarts the service)
  devices                      list allowed device names
  devices add <name>           e.g. my-ipad
  devices remove <name>

${bold("Service")}
  restart | stop | start
  logs [-f] [-n N]             service log
  refused [--since 24h]        refused requests (device / login), grouped
  test                         run the test suite (temp folders only)
  undo-config                  put back the config from before the last change
  config                       print the config (no secrets in it)
`;

async function cmdStatus() {
  const cfg = load();
  const active = sh(["systemctl", "--user", "is-active", SERVICE]).out.trim();
  console.log(`${bold("service")}   ${active === "active" ? green(active) : red(active)}`);
  const port = cfg.port ?? 4321;
  console.log(`${bold("local")}     http://127.0.0.1:${port}  → ${await httpCode(`http://127.0.0.1:${port}/`)}`);
  if (cfg.tailnet) {
    const ip = sh(["tailscale", "ip", "-4"]).out.trim().split("\n")[0];
    const st = sh(["tailscale", "status", "--self", "--peers=false", "--json"]).out;
    let dns = ""; try { dns = String(JSON.parse(st).Self?.DNSName ?? "").replace(/\.$/, ""); } catch {}
    console.log(`${bold("tailnet")}   ${ip ? `http://${dns || ip}:${port}` : yellow("Tailscale not up")}  devices: ${(cfg.allowDevices ?? []).join(", ")}`);
  }
  if (cfg.public) {
    const p = cfg.public;
    const local = await httpCode(`http://127.0.0.1:${p.port}/`);
    const host = hostOf(cfg);
    const pub = await httpCode(`https://${host}/`);
    console.log(`${bold("public")}    https://${host} → ${pub === "302" ? green("302 (login page)") : red(pub)}   127.0.0.1:${p.port} without login → ${local === "403" ? green("403") : red(local)}`);
    console.log(`${bold("logins")}    ${p.emails.join(", ")}`);
  }
  console.log();
  cmdFolders(cfg);
}

function cmdFolders(cfg = load()) {
  const pub = new Set(cfg.public?.roots ?? []);
  for (const r of cfg.roots) {
    let state = "";
    try { if (!statSync(realpathSync(expandHome(r.path))).isDirectory()) state = red(" (not a folder)"); } catch { state = red(" (missing)"); }
    console.log(`${pub.has(r.name) ? yellow("★") : " "} ${r.name.padEnd(24)} ${dim(r.path)}${state}`);
  }
  for (const n of pub) if (!cfg.roots.some((r) => r.name === n)) console.log(`${yellow("★")} ${n.padEnd(24)} ${red("(in public.roots but not a folder in roots)")}`);
  if (pub.size) console.log(dim(`★ = also on https://${cfg.public?.hostname ?? "the public link"}`));
}

function checkFolder(p: string): string {
  let dir: string;
  try { dir = realpathSync(path.resolve(expandHome(p))); } catch { return die(`no such folder: ${p}`); }
  if (!statSync(dir).isDirectory()) die(`not a folder: ${p}`);
  if (dir === "/" || dir === HOME) die("too wide: / and your home folder are refused");
  return dir;
}
const tilde = (abs: string) => (abs.startsWith(HOME + "/") ? "~" + abs.slice(HOME.length) : abs);

async function cmdAdd(name: string, p: string, isPublic: boolean) {
  if (!name || !p) die("usage: artipeek add <name> <path> [--public]");
  if (!NAME_RE.test(name)) die("name: letters, digits, . _ - (max 64), starting with a letter or digit");
  const cfg = load();
  if (cfg.roots.some((r) => r.name === name)) die(`folder ${name} already exists`);
  const dir = checkFolder(p);
  const same = cfg.roots.find((r) => { try { return realpathSync(expandHome(r.path)) === dir; } catch { return false; } });
  if (same) console.log(yellow(`note: ${same.name} already points at this folder`));
  if (!existsSync(path.join(dir, ".git"))) console.log(yellow("note: not a git repo, so every file except .git and node_modules is shown"));
  cfg.roots.push({ name, path: tilde(dir) });
  if (isPublic) needPublic(cfg).roots.push(name);
  save(cfg);
  console.log(green(`added ${name} → ${tilde(dir)}`));
  if (isPublic) restart("public folders changed");
}

async function cmdRemove(name: string) {
  const cfg = load();
  if (!cfg.roots.some((r) => r.name === name)) die(`no folder ${name}`);
  cfg.roots = cfg.roots.filter((r) => r.name !== name);
  const wasPublic = !!cfg.public?.roots.includes(name);
  if (cfg.public) cfg.public.roots = cfg.public.roots.filter((n) => n !== name);
  save(cfg);
  console.log(green(`removed ${name} (files untouched)`));
  if (wasPublic) restart("public folders changed");
}

async function cmdRename(from: string, to: string) {
  if (!NAME_RE.test(to ?? "")) die("new name: letters, digits, . _ - (max 64)");
  const cfg = load();
  const r = cfg.roots.find((x) => x.name === from) ?? die(`no folder ${from}`);
  if (cfg.roots.some((x) => x.name === to)) die(`folder ${to} already exists`);
  r.name = to;
  const wasPublic = !!cfg.public?.roots.includes(from);
  if (cfg.public) cfg.public.roots = cfg.public.roots.map((n) => (n === from ? to : n));
  save(cfg);
  console.log(green(`renamed ${from} → ${to}`));
  if (wasPublic) restart("public folders changed");
}

async function cmdPublic(sub?: string, name?: string) {
  const cfg = load();
  const p = needPublic(cfg);
  if (!sub) { for (const n of p.roots) console.log(n); return; }
  if (!name) die(`usage: artipeek public ${sub} <name>`);
  if (sub === "add") {
    if (!cfg.roots.some((r) => r.name === name)) die(`no folder ${name}; add it first: artipeek add ${name} <path>`);
    if (p.roots.includes(name)) return console.log(`${name} is already public`);
    p.roots.push(name);
  } else if (sub === "remove") {
    if (!p.roots.includes(name)) return console.log(`${name} is not public`);
    p.roots = p.roots.filter((n) => n !== name);
  } else die(`unknown: public ${sub}`);
  save(cfg);
  console.log(green(`public folders: ${p.roots.join(", ") || "(none)"}`));
  restart("public folders changed");
}

async function cmdEmails(sub?: string, email?: string) {
  const cfg = load();
  const p = needPublic(cfg);
  if (!sub) { for (const e of p.emails) console.log(e); return; }
  if (sub === "sync") return syncPolicy(cfg, p.emails.map((x) => x.toLowerCase())); // fix drift that `check` shows
  if (!email || !EMAIL_RE.test(email)) die(`usage: artipeek emails ${sub} <email>`);
  const e = email.trim().toLowerCase();
  let next = p.emails.map((x) => x.toLowerCase());
  if (sub === "add") { if (next.includes(e)) return console.log(`${e} is already allowed`); next.push(e); }
  else if (sub === "remove") {
    if (!next.includes(e)) return console.log(`${e} is not in the list`);
    next = next.filter((x) => x !== e);
    if (!next.length) die("refusing to remove the last email (nobody could log in). To turn the public link off, see the README undo.");
  } else die(`unknown: emails ${sub}`);
  // Cloudflare first: if it fails, the config is unchanged.
  await syncPolicy(cfg, next);
  p.emails = next;
  save(cfg);
  restart("allowed emails changed");
  if (sub === "remove") console.log(yellow(`note: a browser that is already logged in as ${e} is refused by artipeek now, and by Cloudflare at its next login.`));
}

async function cmdDevices(sub?: string, name?: string) {
  const cfg = load();
  cfg.allowDevices ??= [];
  if (!sub) { for (const d of cfg.allowDevices) console.log(d); return; }
  const n = (name ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(n)) die(`usage: artipeek devices ${sub} <device-name>  (the Tailscale machine name, e.g. my-ipad)`);
  if (sub === "add") { if (cfg.allowDevices.includes(n)) return console.log(`${n} is already allowed`); cfg.allowDevices.push(n); }
  else if (sub === "remove") { if (!cfg.allowDevices.includes(n)) return console.log(`${n} is not in the list`); cfg.allowDevices = cfg.allowDevices.filter((d) => d !== n); }
  else die(`unknown: devices ${sub}`);
  save(cfg);
  console.log(green(`devices: ${cfg.allowDevices.join(", ")}`));
  restart("devices changed");
}

async function cmdCheck() {
  const cfg = load();
  const i = ids(cfg);
  const p = needPublic(cfg);
  const line = (ok: boolean, what: string, detail = "") => console.log(`${ok ? green("ok  ") : red("BAD ")} ${what}${detail ? dim("  " + detail) : ""}`);
  const tok = await cf("GET", "/user/tokens/verify");
  const days = tok.expires_on ? Math.round((Date.parse(tok.expires_on) - Date.now()) / 86400000) : Infinity;
  line(tok.status === "active" && days > 30, "API token", `${tok.status}, expires ${tok.expires_on ?? "never"}${days <= 30 ? yellow(` (in ${days} days: renew it)`) : ""}`);
  const app = await cf("GET", `/accounts/${i.accountId}/access/apps/${i.appId}`);
  line(app.domain === hostOf(cfg) && app.aud === p.aud, "Access app", `${app.domain}, session ${app.session_duration}, AUD ${app.aud === p.aud ? "matches config" : red("DIFFERS from config")}`);
  const pol = await cf("GET", `/accounts/${i.accountId}/access/apps/${i.appId}/policies/${i.policyId}`);
  const polEmails = (pol.include ?? []).map((x: any) => x.email?.email?.toLowerCase()).filter(Boolean).sort();
  const cfgEmails = p.emails.map((e) => e.toLowerCase()).sort();
  const others = (pol.include ?? []).filter((x: any) => !x.email);
  line(pol.decision === "allow" && JSON.stringify(polEmails) === JSON.stringify(cfgEmails) && !others.length, "Access policy",
    `${pol.decision}: ${polEmails.join(", ")}${others.length ? red(` + ${others.length} non-email rule(s)`) : ""}${JSON.stringify(polEmails) !== JSON.stringify(cfgEmails) ? red(" (config says " + cfgEmails.join(", ") + ")") : ""}`);
  const dns = await cf("GET", `/zones/${i.zoneId}/dns_records/${i.dnsId}`);
  line(dns.content === `${i.tunnelId}.cfargotunnel.com` && dns.proxied, "DNS", `${dns.name} → ${dns.content}${dns.proxied ? "" : red(" NOT proxied")}`);
  const tun = await cf("GET", `/accounts/${i.accountId}/cfd_tunnel/${i.tunnelId}/configurations`);
  const rule = (tun.config?.ingress ?? []).find((r: any) => r.hostname === hostOf(cfg));
  line(rule?.service === `http://127.0.0.1:${p.port}`, "Tunnel rule", `${rule ? rule.service : "missing"} (version ${tun.version})`);
  const edge = await httpCode(`https://${hostOf(cfg)}/`);
  line(edge === "302", "Public link without login", `${edge} (302 = sent to the login page)`);
  const local = await httpCode(`http://127.0.0.1:${p.port}/`, { "Cf-Access-Jwt-Assertion": "x.y.z" });
  line(local === "403", "artipeek's own check (fake login pass)", local);
}

function cmdRefused(since: string) {
  const r = sh(["journalctl", "--user", "-u", SERVICE, "--since", `-${since.replace(/^-/, "")}`, "--no-pager", "-o", "cat"]);
  const counts = new Map<string, number>();
  for (const l of r.out.split("\n")) {
    const m = /^artipeek \((tailnet|public)\): refused (.+?) (GET|HEAD|POST|PUT|DELETE|PATCH|OPTIONS) /.exec(l);
    if (m) counts.set(`${m[1]}  ${m[2]}`, (counts.get(`${m[1]}  ${m[2]}`) ?? 0) + 1);
  }
  if (!counts.size) return console.log(`no refused requests in the last ${since}`);
  for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(5)}  ${k}`);
}

// ---------- main ----------
async function main(argv: string[]) {
  const [cmd, ...a] = argv;
  const flag = (f: string) => { const i = a.indexOf(f); if (i < 0) return false; a.splice(i, 1); return true; };
  const opt = (f: string, d: string) => { const i = a.indexOf(f); if (i < 0) return d; const v = a[i + 1] ?? d; a.splice(i, 2); return v; };
  switch (cmd) {
    case undefined: case "status": return cmdStatus();
    case "help": case "-h": case "--help": return console.log(usage);
    case "folders": case "ls": return cmdFolders();
    case "add": { const pub = flag("--public"); return cmdAdd(a[0], a[1], pub); }
    case "remove": case "rm": return cmdRemove(a[0]);
    case "rename": return cmdRename(a[0], a[1]);
    case "public": return cmdPublic(a[0], a[1]);
    case "emails": return cmdEmails(a[0], a[1]);
    case "devices": return cmdDevices(a[0], a[1]);
    case "check": return cmdCheck();
    case "restart": return restart("asked");
    case "stop": case "start": { const r = sh(["systemctl", "--user", cmd, SERVICE], { inherit: true }); process.exitCode = r.code; return; }
    case "logs": {
      const n = opt("-n", "50");
      const args = ["journalctl", "--user", "-u", SERVICE, "--no-pager", "-o", "short-iso", "-n", n, ...(flag("-f") ? ["-f"] : [])];
      process.exitCode = sh(args, { inherit: true }).code; return;
    }
    case "refused": return cmdRefused(opt("--since", "24h"));
    case "test": process.exitCode = sh(["bash", path.join(import.meta.dir, "test.sh")], { inherit: true }).code; return;
    case "undo-config": {
      if (!existsSync(CONFIG + ".prev")) die("no previous config saved");
      copyFileSync(CONFIG, CONFIG + ".undone"); copyFileSync(CONFIG + ".prev", CONFIG);
      console.log(green("config restored from before the last change (the undone one is in config.json.undone)"));
      console.log(yellow("note: Cloudflare is not changed back. After undoing an `emails` change, run: artipeek check"));
      return restart("config restored");
    }
    case "config": return console.log(readFileSync(CONFIG, "utf8").trimEnd());
    default: die(`unknown command: ${cmd}\n\n${usage}`);
  }
}

main(process.argv.slice(2)).catch((e) => {
  console.error(red(e instanceof Fail ? e.message : String(e?.stack ?? e)));
  process.exit(1);
});
