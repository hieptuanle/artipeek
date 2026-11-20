// Decision hub pages and the agents' API.
//   /decisions                      every project you can see (filter by project at the top)
//   /r/<project>/decisions          one project
//   /decisions/events               live stream (no reload: the page patches cards in place)
//   /decisions/part/list, /part/card/<project>/<id>   fragments for the page
//   /api/decisions/<project>[/<id>[/notes]], /api/answers/<project>   agents, with the project's token
// The API is never on the public listener. Agents can create and change decisions; only the person (artipeek's own
// sheet, see server.ts answer()) can answer them.
import MarkdownIt from "markdown-it";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Hub, InputError, ID_RE, type Full, type Ref } from "../db/store.ts";
import { STATUSES, type Question } from "../db/schema.ts";

export const DECISIONS_JS = readFileSync(path.join(import.meta.dir, "client.js"), "utf8");
export const DECISIONS_CSS = readFileSync(path.join(import.meta.dir, "style.css"), "utf8");

export type Scope = Set<string> | null;
type RootLike = { name: string; base: string; resolve(rel: string): { rel: string; abs: string } | null };
export type Deps = {
  hub: Hub;
  visibleRoots: (scope: Scope) => RootLike[];
  shell: (o: { title: string; bodyClass: string; main: string; nonce: string; extraJs?: string; data?: Record<string, string> }) => string;
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const enc = new TextEncoder();
export const FILTERS: Record<string, string[] | null> = {
  open: ["open"], later: ["later"], answered: ["answered", "relayed"], closed: ["closed", "withdrawn"], all: null,
};
const FILTER_LABEL: Record<string, string> = { open: "Open", later: "Later", answered: "Answered", closed: "Closed", all: "All" };
const STATUS_LABEL: Record<string, string> = { open: "open", later: "later", answered: "answered", relayed: "relayed to the desk", closed: "closed", withdrawn: "withdrawn" };
export const URGENT_MS = 24 * 3600_000;
export const isUrgent = (d: { status: string; urgent: boolean; deadline: string | null }, at = Date.now()) =>
  d.status === "open" && (d.urgent || (!!d.deadline && Date.parse(d.deadline) - at < URGENT_MS));

// Server-side text for times; the page rewrites them in the viewer's own time zone.
const p2 = (n: number) => String(n).padStart(2, "0");
const fmtTime = (iso: string) => { const d = new Date(iso); return `${p2(d.getDate())}/${p2(d.getMonth() + 1)} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };
const timeTag = (iso: string, rel = false) => `<time datetime="${esc(iso)}" data-ts${rel ? " data-rel" : ""}>${esc(fmtTime(iso))}</time>`;
const domId = (project: string, id: string) => `d:${project}:${id}`;

// Agent text is Markdown without raw HTML. Paths become links into the project's folder; links open in a new tab
// (or, for an .html file, in the page's own viewer) so the list keeps its place.
function makeMd(project: string) {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false });
  const base = `/r/${encodeURIComponent(project)}`;
  const def = md.renderer.rules.link_open ?? ((t, i, o, _e, s) => s.renderToken(t, i, o));
  md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
    const t = tokens[idx];
    let href = t.attrGet("href") ?? "";
    if (href && !href.startsWith("#") && !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("//")) {
      if (!href.startsWith("/")) href = `${base}/view/${href.replace(/^\.\//, "")}`;
      t.attrSet("href", href);
      if (/^\/r\/[^/]+\/(view|raw)\/.+\.html?(#.*)?$/i.test(href)) t.attrSet("data-viewer", "");
    }
    if (!href.startsWith("#")) { t.attrSet("target", "_blank"); t.attrSet("rel", "noopener noreferrer"); }
    return def(tokens, idx, opts, env, self);
  };
  return md;
}
const mdCache = new Map<string, MarkdownIt>();
const md = (project: string, src: string) => {
  let m = mdCache.get(project);
  if (!m) { m = makeMd(project); mdCache.set(project, m); }
  return m.render(src);
};

function hrefOf(project: string, h: string): string {
  if (/^https?:/i.test(h) || h.startsWith("/")) return h;
  return `/r/${encodeURIComponent(project)}/view/${h.replace(/^\.\//, "")}`;
}
const linkAttrs = (href: string) => `href="${esc(href)}" target="_blank" rel="noopener noreferrer"${/^\/r\/[^/]+\/(view|raw)\/.+\.html?(#.*)?$/i.test(href) ? " data-viewer" : ""}`;

function refs(label: string, list: Ref[], d: Full): string {
  if (!list.length) return "";
  const items = list.map((r) => {
    const other = r.project !== d.project;
    const text = (other ? `${r.project}:` : "") + r.id;
    const tip = r.title ? `${r.title}${r.status ? ` (${STATUS_LABEL[r.status] ?? r.status})` : ""}` : "not in the hub";
    return `<a class="ref${r.title ? "" : " missing"}${r.status && r.status !== "open" ? " done" : ""}" href="#${esc(domId(r.project, r.id))}" data-ref="${esc(r.project)}/${esc(r.id)}" title="${esc(tip)}">${esc(text)}</a>`;
  }).join(", ");
  return `<span class="rel"><span class="rl">${label}</span> ${items}</span>`;
}

// What the latest answer picked: "A", "A: note", or "Q1 A, Q2 —: note".
function chosen(text: string, multi: boolean): Set<string> {
  const head = text.split(": ")[0];
  if (multi) return new Set(head.split(", ").map((x) => x.trim()));
  return new Set([text.includes(":") ? text.slice(0, text.indexOf(":")).trim() : text.trim()]);
}

function questionsHtml(d: Full, key: string): string {
  const qs: Question[] = d.questions ?? [];
  const multi = qs.length > 1;
  const last = d.answers.find((a) => a.kind === "answer");
  const picked = last ? chosen(last.text, multi) : new Set<string>();
  const fs = qs.map((q) => {
    const qk = q.key ?? "";
    const legend = multi || q.text ? `<legend>${multi ? `<b>${esc(qk)}</b> ` : ""}${q.text ? esc(q.text) : ""}</legend>` : "";
    const opts = q.options.map((o) => {
      const on = multi ? picked.has(`${qk} ${o.value}`) : picked.has(o.value);
      return `<button type="button" class="opt${o.recommended ? " rec" : ""}" data-v="${esc(o.value)}"${multi ? ` data-q="${esc(qk)}" aria-pressed="false"` : ""}${on ? ' data-chosen="true"' : ""}><span class="ov">${esc(o.value)}</span><span class="ol">${esc(o.label)}${o.recommended ? ' <span class="rectag">Recommended</span>' : ""}${o.effect ? `<span class="eff">If ${esc(o.value)}: ${esc(o.effect)}</span>` : ""}</span></button>`;
    }).join("");
    return `<fieldset class="q"${multi ? ` data-q="${esc(qk)}"` : ""}>${legend}${opts}</fieldset>`;
  }).join("");
  const note = `<textarea class="dnote-in" id="n:${esc(key)}" rows="2" placeholder="${qs.length ? "Optional note, or your own answer" : "Your answer"}"></textarea>`;
  const btns = [
    multi ? `<button type="button" class="send" data-send>Send my answers</button>` : "",
    `<button type="button" class="own" data-own>${qs.length ? "Send my own answer" : "Send my answer"}</button>`,
    `<button type="button" class="expl" data-explain title="Ask the desk for a page that illustrates this decision and its options">Explain this</button>`,
  ].join("");
  return `<div class="dq" data-a="q">${fs}${note}<div class="dacts">${btns}</div></div>`;
}

function explainerHtml(d: Full, root: RootLike | undefined): string {
  if (d.explainerPath) {
    const found = root?.resolve(d.explainerPath);
    const raw = `${root?.base ?? `/r/${encodeURIComponent(d.project)}`}/raw/${d.explainerPath.split("/").map(encodeURIComponent).join("/")}`;
    const view = raw.replace("/raw/", "/view/");
    if (!found) return `<div class="dexpl wait" data-a="x">Explainer <code>${esc(d.explainerPath)}</code> is not in the folder yet.</div>`;
    const isHtml = /\.html?$/i.test(d.explainerPath);
    return `<div class="dexpl ready" data-a="x">${isHtml ? `<button type="button" class="xopen" data-xopen="${esc(raw)}" data-xview="${esc(view)}">Open explainer</button>` : `<a class="xopen" ${linkAttrs(view)}>Open explainer</a>`} <span class="xpath">${esc(d.explainerPath)}</span></div>`;
  }
  if (d.explainerRequestedAt) return `<div class="dexpl wait" data-a="x">Explainer asked for ${timeTag(d.explainerRequestedAt)}. The desk is making it; it shows here when ready.</div>`;
  return "";
}

export function cardHtml(d0: Full, o: { showProject: boolean; root?: RootLike; visible: Set<string> }): string {
  // links to folders this listener doesn't show (the public one) are left out: not even their titles
  const seen = (l: Ref[]) => l.filter((r) => o.visible.has(r.project));
  const d: Full = { ...d0, from: seen(d0.from), dependsOn: seen(d0.dependsOn), ledTo: seen(d0.ledTo), neededBy: seen(d0.neededBy) };
  const key = `${d.project}/${d.id}`;
  const urgent = isUrgent(d);
  const open = d.status === "open" || d.status === "later";
  const lastAns = d.answers.find((a) => a.kind === "answer");
  const answers = d.answers.filter((a) => a.kind === "answer");
  const head = `<header class="dh" data-a="h"><div class="dl1">${o.showProject ? `<a class="pj" href="/r/${esc(encodeURIComponent(d.project))}/decisions">${esc(d.project)}</a>` : ""}<a class="did" href="#${esc(domId(d.project, d.id))}">${esc(d.id)}</a><span class="dst dst-${esc(d.status)}">${esc(STATUS_LABEL[d.status] ?? d.status)}</span><span class="durg">Urgent</span>${d.lane ? `<span class="lane">${esc(d.lane)}</span>` : ""}</div>`
    + `<h2 class="dt">${esc(d.title)}</h2>`
    + `<div class="dm">Raised ${timeTag(d.createdAt)}${d.deadline ? ` · <span class="ddl">Deadline ${timeTag(d.deadline, true)}</span>` : ""}${d.deadlineNote ? ` · <span class="ddn">${esc(d.deadlineNote)}</span>` : ""}</div>`
    + `${d.from.length || d.dependsOn.length || d.ledTo.length || d.neededBy.length ? `<div class="drel">${[refs("From", d.from, d), refs("Depends on", d.dependsOn, d), refs("Led to", d.ledTo, d), refs("Needed by", d.neededBy, d)].filter(Boolean).join("")}</div>` : ""}</header>`;
  const ctx = d.context ? `<div class="dctx markdown" data-a="c">${md(d.project, d.context)}</div>` : "";
  const notes = d.notes.length ? `<ol class="dnotes">${d.notes.map((n) => `<li class="dn dn-${esc(n.kind)}" data-a="n${n.seq}"><div class="dnh">${n.kind === "done" ? "Done" : "Update"} ${timeTag(n.at)}</div><div class="markdown">${md(d.project, n.body)}</div></li>`).join("")}</ol>` : "";
  const noAns = d.ifNoAnswer && open ? `<p class="dna" data-a="na"><b>If no answer:</b> ${esc(d.ifNoAnswer)}</p>` : "";
  const links = d.links.length ? `<ul class="dlinks" data-a="l">${d.links.map((l) => `<li><a ${linkAttrs(hrefOf(d.project, l.href))}>${esc(l.label)}</a></li>`).join("")}</ul>` : "";
  const ans = lastAns ? `<div class="dans" data-a="a">You answered <b class="atext">${esc(lastAns.text)}</b> · ${timeTag(lastAns.at)}${answers.length > 1 ? `<details class="older"><summary>Earlier (${answers.length - 1})</summary><ul>${answers.slice(1).map((a) => `<li>${esc(a.text)} · ${timeTag(a.at)}</li>`).join("")}</ul></details>` : ""}</div>` : "";
  const res = d.resolution ? `<div class="dres" data-a="r"><b>Desk:</b> ${esc(d.resolution)}</div>` : "";
  const body = ctx + notes + noAns + links + explainerHtml(d, o.root) + questionsHtml(d, key);
  const html = `<article class="dc dc-${esc(d.status)}${urgent ? " urgent" : ""}" id="${esc(domId(d.project, d.id))}" data-k="${esc(key)}" data-project="${esc(d.project)}" data-id="${esc(d.id)}" data-status="${esc(d.status)}" data-flag="${d.urgent ? 1 : 0}"${d.deadline ? ` data-deadline="${esc(d.deadline)}"` : ""} data-multi="${(d.questions?.length ?? 0) > 1 ? 1 : 0}"${lastAns ? ` data-answer="${esc(lastAns.text)}"` : ""}>`
    + head + ans + res + (open ? body : `<details class="dmore" data-a="m"><summary>Details and answer again</summary>${body}</details>`) + `</article>`;
  // a version for the live patcher: same html = nothing to do
  return html.replace("<article ", `<article data-v="${createHash("sha1").update(html).digest("hex").slice(0, 12)}" `);
}

export const outlineItem = (d: Full, showProject: boolean) =>
  `<li class="oi oi-${esc(d.status)}${isUrgent(d) ? " urgent" : ""}" data-k="${esc(d.project)}/${esc(d.id)}"><a href="#${esc(domId(d.project, d.id))}"><span class="oid">${esc(d.id)}</span><span class="ot">${esc(d.title)}</span>${showProject ? `<span class="opj">${esc(d.project)}</span>` : ""}</a></li>`;

export function createDecisionsWeb(deps: Deps) {
  const { hub } = deps;
  const projectsIn = (scope: Scope) => deps.visibleRoots(scope).map((r) => r.name);
  const rootOf = (scope: Scope, project: string) => deps.visibleRoots(scope).find((r) => r.name === project);

  function listFor(scope: Scope, project: string | null, filter: string): Full[] {
    const ps = project ? [project] : projectsIn(scope);
    return hub.list({ projects: ps, statuses: FILTERS[filter] ?? FILTERS.open! });
  }
  function counts(scope: Scope, project: string | null) {
    const ps = project ? [project] : projectsIn(scope);
    const c = hub.counts(ps);
    // per project: open/later/answered/closed/all, plus urgent among open
    const urg: Record<string, number> = {};
    for (const d of hub.list({ projects: ps, statuses: ["open"] })) if (isUrgent(d)) urg[d.project] = (urg[d.project] ?? 0) + 1;
    const out: Record<string, Record<string, number>> = {};
    for (const p of ps) {
      const s = c[p] ?? {};
      const g = (k: string) => (FILTERS[k] ?? STATUSES).reduce((n, st) => n + (s[st] ?? 0), 0);
      out[p] = { open: g("open"), later: g("later"), answered: g("answered"), closed: g("closed"), all: g("all"), urgent: urg[p] ?? 0 };
    }
    return out;
  }
  function listPart(scope: Scope, project: string | null, filter: string) {
    const list = listFor(scope, project, filter);
    const show = !project;
    const visible = new Set(projectsIn(scope));
    return {
      html: list.map((d) => cardHtml(d, { showProject: show, root: rootOf(scope, d.project), visible })).join(""),
      outline: list.map((d) => outlineItem(d, show)).join(""),
      counts: counts(scope, project),
    };
  }

  function page(scope: Scope, project: string | null, filter: string, nonce: string, canAnswer: boolean): string {
    const part = listPart(scope, project, filter);
    const projects = projectsIn(scope).filter((p) => (part.counts[p]?.all ?? 0) > 0);
    const segs = Object.keys(FILTERS).map((f) => `<button type="button" data-status="${f}" aria-pressed="${f === filter}">${FILTER_LABEL[f]} <i data-count="${f}"></i></button>`).join("");
    const pjs = project ? "" : `<div class="pjs" role="group" aria-label="Project"><button type="button" data-project="" aria-pressed="true">All projects</button>${projects.map((p) => `<button type="button" data-project="${esc(p)}" aria-pressed="false">${esc(p)} <i data-pcount="${esc(p)}"></i></button>`).join("")}</div>`;
    const title = project ? `${project} decisions` : "Decisions";
    const top = `<header class="dtop" id="dtop"><div class="dr1"><a class="home" href="/">artipeek</a><span class="sep">/</span>${project ? `<a href="/decisions">decisions</a><span class="sep">/</span><b>${esc(project)}</b>` : "<b>decisions</b><span class=\"allp\">all projects</span>"}<span class="live" title="Live updates">live</span><button type="button" class="obtn" data-outline aria-label="Outline">Outline</button></div>`
      + `<div class="dfl"><div class="seg" role="group" aria-label="Status">${segs}</div><button type="button" class="urgf" data-urgent aria-pressed="false">Urgent <i data-count="urgent"></i></button></div>${pjs}`
      + (canAnswer ? "" : `<p class="ro">This device can't send answers. Use the public link (login) or an answer device.</p>`) + `</header>`;
    const main = `<div class="dwrap">${top}<div class="dgrid"><section id="dlist" class="dlist" aria-live="off">${part.html}</section><p class="dempty" id="dempty" hidden>Nothing here.</p>`
      + `<nav class="dout" id="dout" aria-label="Outline"><div class="doh">Outline <button type="button" class="oclose" data-outline aria-label="Close outline">×</button></div><ol id="olist">${part.outline}</ol></nav></div></div>`
      + `<button type="button" class="ofab" data-outline aria-label="Outline">☰ Outline</button><div id="dscrim" data-outline></div><script type="application/json" id="dcounts">${JSON.stringify(part.counts).replace(/</g, "\\u003c")}</script>`;
    return deps.shell({ title, bodyClass: "dhub", main, nonce, extraJs: DECISIONS_JS, data: { project: project ?? "", filter, can: canAnswer ? "1" : "0" } });
  }

  // ----- live stream -----
  type Client = { ctrl: ReadableStreamDefaultController<Uint8Array>; scope: Scope; project: string | null };
  const clients = new Set<Client>();
  const send = (c: Client, ev: string, data: unknown) => { try { c.ctrl.enqueue(enc.encode(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { clients.delete(c); } };
  hub.onChange((project, id) => {
    for (const c of clients) {
      if (c.scope && !c.scope.has(project)) continue;
      if (c.project && c.project !== project) {
        // a change elsewhere can still change a link shown here (title, status): cheap to let the page re-check
        if (id) send(c, "ref", { project, id });
        continue;
      }
      send(c, id ? "d" : "all", { project, id });
    }
  });
  let ver = hub.dataVersion();
  setInterval(() => { // another process (import, admin CLI) wrote the file
    const v = hub.dataVersion();
    if (v !== ver) { ver = v; for (const c of clients) send(c, "all", {}); }
  }, 1000);
  setInterval(() => { const ping = enc.encode(`: ping\n\n`); for (const c of clients) { try { c.ctrl.enqueue(ping); } catch { clients.delete(c); } } }, 25_000);
  // Deadlines cross the 24 h line without any write: tell pages once a minute so counts stay right.
  setInterval(() => { for (const c of clients) send(c, "tick", {}); }, 60_000);

  function events(req: Request, scope: Scope, project: string | null): Response {
    let c: Client;
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) { c = { ctrl, scope, project }; clients.add(c); ctrl.enqueue(enc.encode(`retry: 2000\n: hello\n\n`)); },
      cancel() { clients.delete(c); },
    });
    req.signal.addEventListener("abort", () => clients.delete(c));
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", Connection: "keep-alive", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  }

  // ----- agents' API -----
  const json = (status: number, o: unknown) => new Response(JSON.stringify(o, null, 1), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  async function body(req: Request): Promise<any> {
    if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) throw new InputError("send Content-Type: application/json");
    const raw = await req.text();
    if (raw.length > 256_000) throw new InputError("body over 256 kB");
    try { return JSON.parse(raw); } catch { throw new InputError("bad JSON"); }
  }
  // Every API call needs the project's token: Authorization: Bearer <token>. Even from 127.0.0.1.
  async function api(req: Request, p: string, scope: Scope): Promise<Response> {
    if (scope) return json(404, { ok: false, error: "not here" });
    const m = /^\/api\/(decisions|answers)\/([^/]+)(?:\/([^/]+))?(?:\/(notes))?\/?$/.exec(p);
    if (!m) return json(404, { ok: false, error: "unknown path" });
    let project: string, id: string | undefined;
    try { project = decodeURIComponent(m[2]); id = m[3] && decodeURIComponent(m[3]); } catch { return json(400, { ok: false, error: "bad path" }); }
    if (!projectsIn(null).includes(project)) return json(404, { ok: false, error: `no folder named ${project} in artipeek's config` });
    const tok = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
    if (!hub.tokenOk(project, tok)) {
      console.log(`artipeek: decisions API refused for ${project} (bad or missing token) ${req.method} ${p.slice(0, 80)}`);
      return json(401, { ok: false, error: `token missing or wrong for ${project} (artipeek decisions token ${project})` });
    }
    if (id && !ID_RE.test(id)) return json(400, { ok: false, error: "bad id" });
    const url = new URL(req.url);
    try {
      if (m[1] === "answers") {
        if (req.method !== "GET" || id) return json(405, { ok: false, error: "GET /api/answers/<project>?since=<ISO>" });
        return json(200, { ok: true, answers: hub.answersSince(project, url.searchParams.get("since") ?? undefined) });
      }
      if (!id) {
        if (req.method === "GET") {
          const st = url.searchParams.get("status");
          const statuses = st ? st.split(",").filter((x) => (STATUSES as readonly string[]).includes(x)) : undefined;
          return json(200, { ok: true, decisions: hub.list({ projects: [project], statuses }) });
        }
        if (req.method === "POST") {
          const newId = hub.create(project, await body(req));
          return json(201, { ok: true, id: newId, url: `/r/${encodeURIComponent(project)}/decisions#${domId(project, newId)}` });
        }
        return json(405, { ok: false, error: "GET or POST" });
      }
      if (m[4] === "notes") {
        if (req.method !== "POST") return json(405, { ok: false, error: "POST" });
        const seq = hub.addNote(project, id, await body(req));
        return json(201, { ok: true, seq });
      }
      if (req.method === "GET") {
        const d = hub.get(project, id);
        return d ? json(200, { ok: true, decision: d }) : json(404, { ok: false, error: `${id} not found` });
      }
      if (req.method === "PATCH") {
        hub.update(project, id, await body(req));
        return json(200, { ok: true, decision: hub.get(project, id) });
      }
      return json(405, { ok: false, error: "GET or PATCH" });
    } catch (e) {
      if (e instanceof InputError) return json(400, { ok: false, error: e.message });
      console.log(`artipeek: decisions API error: ${(e as Error).message}`);
      return json(500, { ok: false, error: "server error" });
    }
  }

  // ----- routes (GET) -----
  // Returns null when the path isn't the hub's.
  function route(req: Request, url: URL, scope: Scope, nonce: () => string, canAnswer: boolean): Response | null {
    const p = url.pathname;
    const html = (s: string, csp?: string) => new Response(s, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", ...(csp ? { "Content-Security-Policy": csp } : {}) } });
    const filterOf = () => { const f = url.searchParams.get("status") ?? "open"; return f in FILTERS ? f : "open"; };
    const projOf = (raw: string | null): string | null | false => {
      if (!raw) return null;
      return projectsIn(scope).includes(raw) ? raw : false;
    };
    let m: RegExpExecArray | null;
    if (p === "/decisions" || p === "/decisions/") return pageRes(null);
    if ((m = /^\/r\/([^/]+)\/decisions\/?$/.exec(p))) {
      let name: string;
      try { name = decodeURIComponent(m[1]); } catch { return null; }
      const pj = projOf(name);
      return pj ? pageRes(pj) : null;
    }
    if (p === "/decisions/events") {
      const pj = projOf(url.searchParams.get("project"));
      return pj === false ? null : events(req, scope, pj);
    }
    if (p === "/decisions/part/list") {
      const pj = projOf(url.searchParams.get("project"));
      if (pj === false) return null;
      return json(200, listPart(scope, pj, filterOf()));
    }
    if ((m = /^\/decisions\/part\/card\/([^/]+)\/([^/]+)$/.exec(p))) {
      let name: string, id: string;
      try { name = decodeURIComponent(m[1]); id = decodeURIComponent(m[2]); } catch { return null; }
      const pj = projOf(name);
      if (!pj || !ID_RE.test(id)) return null;
      const d = hub.get(pj, id);
      if (!d) return json(404, { ok: false });
      const show = url.searchParams.get("all") === "1";
      return json(200, { ok: true, html: cardHtml(d, { showProject: show, root: rootOf(scope, pj), visible: new Set(projectsIn(scope)) }), item: outlineItem(d, show), status: d.status, counts: counts(scope, show ? null : pj) });
    }
    return null;
    function pageRes(project: string | null) {
      const n = nonce();
      return html(page(scope, project, filterOf(), n, canAnswer), `default-src 'self'; script-src 'nonce-${n}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
    }
  }

  return { route, api, page, counts, isUrgent };
}
