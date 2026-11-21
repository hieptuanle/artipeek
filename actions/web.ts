// Actions: work only the person can do, raised by an agent as a checklist of steps (see db/schema.ts "Actions").
//   /actions, /r/<project>/actions          the app with the Actions tab open (project filter set by the second)
//   /actions/part/page|list|counts, /actions/part/card/<project>/<id>   fragments (same shape as the Decisions tab's,
//                                            so decisions/client.js drives both tabs)
//   /api/actions/<project>[/<id>[/steps/<n>]]   agents, with the project's token (never on the public listener)
// The person ticks steps, says all are done, or asks the agent to do it: POST /r/<folder>/action (server.ts). The agent
// hears that like an answer (GET /api/answers kind "action", the answers file), checks the steps and closes the action.
import { createHash } from "node:crypto";
import { Hub, InputError, ID_RE, type FullAction, type Step, type ListOpts } from "../db/store.ts";
import { ACTION_STATUSES } from "../db/schema.ts";
import { esc, md, timeTag, hrefOf, linkAttrs, URGENT_MS, PAGE, isUrgent, type Deps, type Scope } from "../decisions/web.ts";

// Filters: what waits for the person, what is with the agent (doing it, or checking), what is closed.
export const ACT_FILTERS: Record<string, string[] | null> = { open: ["open"], agent: ["agent", "checking"], done: ["done", "withdrawn"], all: null };
const ACT_NEWEST = new Set(["done", "all"]);
const FILTER_LABEL: Record<string, string> = { open: "To do", agent: "With the agent", done: "Done", all: "All" };
const EMPTY: Record<string, string> = { open: "Nothing for you to do.", agent: "Nothing with the agent.", done: "No done actions.", all: "No actions." };
export const ACT_LABEL: Record<string, string> = { open: "to do", agent: "asked the agent", checking: "checking", done: "done", withdrawn: "withdrawn" };
const domId = (project: string, id: string) => `a:${project}:${id}`;
const live = (status: string) => status === "open" || status === "agent" || status === "checking";

function stepHtml(a: FullAction, x: Step, canTick: boolean): string {
  const on = x.state !== "todo";
  const locked = !canTick || x.state === "verified" || x.state === "skipped";
  const when = (iso: string | null) => (iso ? ` ${timeTag(iso)}` : "");
  const st = {
    todo: x.note && x.checkedAt ? `<b>Not done yet</b>${when(x.checkedAt)}: ${esc(x.note)}` : "",
    done: `Ticked${when(x.doneAt)}. The agent hears it in a moment (untick if it was a slip).`,
    checking: `Ticked${when(x.doneAt)} · <b>the agent is checking it</b>${x.note ? `: ${esc(x.note)}` : "."}`,
    verified: `<b>✓ Verified</b> by the agent${when(x.checkedAt)}${x.note ? `: ${esc(x.note)}` : "."}`,
    skipped: `<b>Verify skipped</b>${when(x.checkedAt)}${x.note ? `: ${esc(x.note)}` : " (the agent couldn't check it)."}`,
  }[x.state];
  const cmd = x.command ? `<div class="codeblock acmd"><button type="button" class="copy" data-copy aria-label="Copy the command of step ${x.n}">Copy</button><pre><code>${esc(x.command)}</code></pre></div>` : "";
  const links = x.links.length ? `<ul class="dlinks">${x.links.map((l) => `<li><a ${linkAttrs(hrefOf(a.project, l.href))}>${esc(l.label)}</a></li>`).join("")}</ul>` : "";
  return `<li class="as as-${esc(x.state)}" data-n="${x.n}" data-a="s${x.n}"><button type="button" class="atick" data-tick="${x.n}" role="checkbox" aria-checked="${on}" aria-label="Step ${x.n} done"${locked ? " disabled" : ""}></button>`
    + `<span class="asn">${x.n}</span><div class="asb"><div class="markdown">${md(a.project, x.text)}</div>`
    + (x.where ? `<p class="awhere"><b>Where:</b> ${esc(x.where)}</p>` : "") + cmd + links
    + (st ? `<p class="astate">${st}</p>` : "") + `</div></li>`;
}

export function actionCardHtml(a0: FullAction, o: { visible: Set<string> }): string {
  const a: FullAction = { ...a0, from: a0.from.filter((r) => o.visible.has(r.project)) };
  const key = `${a.project}/${a.id}`;
  const open = live(a.status);
  const urgent = isUrgent(a);
  const ticked = a.steps.filter((x) => x.state !== "todo").length;
  const from = a.from.length ? `<div class="drel"><span class="rel"><span class="rl">From</span> ${a.from.map((r) => {
    const text = (r.project !== a.project ? `${r.project}:` : "") + r.id;
    return `<a class="xref${r.title ? "" : " missing"}" href="/decisions#d:${esc(r.project)}:${esc(r.id)}" title="${esc(r.title ?? "not in the hub")}">${esc(text)}</a>`;
  }).join(", ")}</span></div>` : "";
  const head = `<header class="dh" data-a="h"><div class="dl1"><a class="pj" href="/r/${esc(encodeURIComponent(a.project))}/actions" data-project="${esc(a.project)}" title="Only ${esc(a.project)}">${esc(a.project)}</a><a class="did" href="#${esc(domId(a.project, a.id))}">${esc(a.id)}</a><span class="dst ast-${esc(a.status)}">${esc(ACT_LABEL[a.status] ?? a.status)}</span><span class="durg">Urgent</span>${a.lane ? `<span class="lane">${esc(a.lane)}</span>` : ""}<span class="aprog" title="steps ticked">${ticked}/${a.steps.length}</span></div>`
    + `<h2 class="dt">${esc(a.title)}</h2>`
    + `<div class="dm">Raised ${timeTag(a.createdAt)}${a.deadline ? ` · <span class="ddl">Deadline ${timeTag(a.deadline, true)}</span>` : ""}</div>${from}</header>`;
  const ctx = a.context ? `<div class="dctx markdown" data-a="c">${md(a.project, a.context)}</div>` : "";
  const links = a.links.length ? `<ul class="dlinks" data-a="l">${a.links.map((l) => `<li><a ${linkAttrs(hrefOf(a.project, l.href))}>${esc(l.label)}</a></li>`).join("")}</ul>` : "";
  const steps = `<ol class="asteps" data-a="s">${a.steps.map((x) => stepHtml(a, x, open)).join("")}</ol>`;
  const asked = a.status === "agent" && a.agentAskedAt
    ? `<div class="aagent" data-a="g">You asked the agent to do it ${timeTag(a.agentAskedAt)}${a.agentNote ? `: <i>${esc(a.agentNote)}</i>.` : "."} ${a.agentHeard ? "The agent has it." : "It goes to the agent in a moment."}</div>` : "";
  const res = a.resolution ? `<div class="dres" data-a="r"><b>Agent:</b> ${esc(a.resolution)}</div>` : "";
  const todo = a.steps.some((x) => x.state === "todo");
  const acts = open ? `<div class="dq aacts" data-a="b"><textarea class="dnote-in" id="n:${esc(key)}" rows="2" placeholder="Optional note for the agent"></textarea><div class="dacts">`
    + (todo ? `<button type="button" class="send" data-all>I've done all the steps</button>` : "")
    + (a.status !== "agent" ? `<button type="button" class="own" data-agent title="The agent tries to do it for you; it tells you if it can't">Ask the agent to do it</button>` : "")
    + `</div></div>` : "";
  const sent = a.signals.length ? `<details class="older asent" data-a="t"><summary>Sent to the agent (${a.signals.length})</summary><ul>${a.signals.map((g) => `<li>${esc(g.text.replace(/^ACTION: \S+ "(?:[^"\\]|\\.)*": /, ""))} · ${timeTag(g.at)}</li>`).join("")}</ul></details>` : "";
  const body = ctx + links + steps + acts + sent;
  const html = `<article class="dc ac dc-${esc(a.status)}${urgent ? " urgent" : ""}" id="${esc(domId(a.project, a.id))}" data-k="${esc(key)}" data-project="${esc(a.project)}" data-id="${esc(a.id)}" data-status="${esc(a.status)}" data-created="${esc(a.createdAt)}" data-flag="${a.urgent ? 1 : 0}"${a.deadline ? ` data-deadline="${esc(a.deadline)}"` : ""}>`
    + head + asked + res + (open ? body : `<details class="dmore" data-a="m"><summary>Steps and what was sent</summary>${body}</details>`) + `</article>`;
  return html.replace("<article ", `<article data-v="${createHash("sha1").update(html).digest("hex").slice(0, 12)}" `);
}

export const actionOutlineItem = (a: FullAction) =>
  `<li class="oi oi-${esc(a.status)}${isUrgent(a) ? " urgent" : ""}" data-k="${esc(a.project)}/${esc(a.id)}"><a href="#${esc(domId(a.project, a.id))}"><span class="oid">${esc(a.id)}</span><span class="ot">${esc(a.title)}</span><span class="opj">${a.steps.filter((x) => x.state !== "todo").length}/${a.steps.length} · ${esc(a.project)}</span></a></li>`;

type Filter = { status: string; project: string | null; urgent: boolean };
function filterFrom(q: URLSearchParams): Filter {
  const st = q.get("status") ?? "open";
  return { status: st in ACT_FILTERS ? st : "open", project: q.get("project") || null, urgent: q.get("urgent") === "1" };
}

export function createActionsWeb(deps: Deps) {
  const { hub } = deps;
  const projectsIn = (scope: Scope) => deps.visibleRoots(scope).map((r) => r.name);
  const listOpts = (scope: Scope, f: Filter): ListOpts => ({
    projects: f.project ? [f.project] : projectsIn(scope),
    statuses: ACT_FILTERS[f.status] ?? undefined,
    urgentAt: f.urgent ? new Date(Date.now() + URGENT_MS).toISOString() : undefined,
    newestFirst: ACT_NEWEST.has(f.status),
  });
  // Per project: open (to do), agent (with the agent), done, all, and urgent among open.
  function counts(scope: Scope) {
    const ps = projectsIn(scope);
    const c = hub.actionCounts(ps);
    const urgentAt = new Date(Date.now() + URGENT_MS).toISOString();
    const out: Record<string, Record<string, number>> = {};
    for (const p of ps) {
      const s = c[p] ?? {};
      const g = (k: string) => (ACT_FILTERS[k] ?? ACTION_STATUSES).reduce((n, st) => n + (s[st] ?? 0), 0);
      out[p] = { open: g("open"), agent: g("agent"), done: g("done"), all: g("all"), urgent: s.open ? hub.actionCount({ projects: [p], urgentAt }) : 0 };
    }
    return out;
  }
  function listPart(scope: Scope, f: Filter, offset = 0, limit = PAGE) {
    const o = listOpts(scope, f);
    const list = hub.actionList({ ...o, limit, offset });
    const total = hub.actionCount(o);
    const visible = new Set(projectsIn(scope));
    return {
      html: list.map((a) => actionCardHtml(a, { visible })).join(""),
      outline: list.map(actionOutlineItem).join(""),
      counts: counts(scope), total, next: offset + list.length < total ? offset + list.length : null,
      empty: f.urgent ? "Nothing urgent." : EMPTY[f.status],
    };
  }
  function pane(scope: Scope, f: Filter, canAct: boolean): string {
    const part = listPart(scope, f);
    const projects = projectsIn(scope).filter((p) => (part.counts[p]?.all ?? 0) > 0);
    const segs = Object.keys(ACT_FILTERS).map((s) => `<button type="button" data-status="${s}" aria-pressed="${s === f.status}">${FILTER_LABEL[s]} <i data-count="${s}"></i></button>`).join("");
    const pjs = `<div class="pjs" role="group" aria-label="Project"><button type="button" data-project="" aria-pressed="${!f.project}">All projects</button>${projects.map((p) => `<button type="button" data-project="${esc(p)}" aria-pressed="${f.project === p}">${esc(p)} <i data-pcount="${esc(p)}"></i></button>`).join("")}</div>`;
    const top = `<header class="dtop"><div class="dr1"><button type="button" class="menu" aria-label="Files" data-menu>☰</button><b class="dtitle">Actions</b><span class="live" title="Live updates">live</span><button type="button" class="obtn" data-outline aria-label="Outline">Outline</button></div>`
      + `<div class="dfl"><div class="seg" role="group" aria-label="Status">${segs}</div><button type="button" class="urgf" data-urgent aria-pressed="${f.urgent}">Urgent <i data-count="urgent"></i></button></div>${pjs}`
      + (canAct ? "" : `<p class="ro">This device can't tick steps. Use the public link (login) or an answer device.</p>`) + `</header>`;
    const more = `<div class="dmorebox"${part.next === null ? " hidden" : ""}><button type="button" class="dmorebtn" data-more>Show more</button></div>`;
    const filters = esc(JSON.stringify(ACT_FILTERS));
    return `<div class="dpane apane" data-kind="act" data-base="/actions" data-filters="${filters}" data-newest="${[...ACT_NEWEST].join(",")}" data-status="${f.status}" data-project="${esc(f.project ?? "")}" data-urgent="${f.urgent ? 1 : 0}" data-next="${part.next ?? ""}" data-total="${part.total}" data-can="${canAct ? 1 : 0}">${top}`
      + `<div class="dgrid"><div class="dcol"><section class="dlist" aria-live="off">${part.html}</section><p class="dempty"${part.html ? " hidden" : ""}>${esc(part.empty)}</p>${more}</div>`
      + `<nav class="dout" aria-label="Outline"><div class="doh">Outline <button type="button" class="oclose" data-outline aria-label="Close outline">×</button></div><ol class="olist">${part.outline}</ol><p class="oempty"${part.outline ? " hidden" : ""}>${esc(part.empty)}</p></nav></div>`
      + `<button type="button" class="ofab" data-outline aria-label="Outline">☰ Outline</button><div class="dscrim" data-outline></div>`
      + `<script type="application/json" class="dcounts">${JSON.stringify(part.counts).replace(/</g, "\\u003c")}</script></div>`;
  }

  // Live: one action changed ("a"); many ("all", sent by the decisions part when another process writes the file).
  hub.onAction((project, id) => deps.broadcast(project, id ? "a" : "all", { project, id }));

  function pageFilter(url: URL, scope: Scope): Filter | null {
    const p = url.pathname;
    const f = filterFrom(url.searchParams);
    if (p === "/actions" || p === "/actions/") return f.project && !projectsIn(scope).includes(f.project) ? { ...f, project: null } : f;
    const m = /^\/r\/([^/]+)\/actions\/?$/.exec(p);
    if (!m) return null;
    let name: string;
    try { name = decodeURIComponent(m[1]); } catch { return null; }
    return projectsIn(scope).includes(name) ? { ...f, project: name } : null;
  }
  const json = (status: number, o: unknown) => new Response(JSON.stringify(o, null, 1), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  function part(url: URL, scope: Scope, canAct: boolean): Response | null {
    const p = url.pathname;
    const f = filterFrom(url.searchParams);
    if (f.project && !projectsIn(scope).includes(f.project)) f.project = null;
    if (p === "/actions/part/page") return new Response(pane(scope, f, canAct), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
    if (p === "/actions/part/list") {
      const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || PAGE));
      return json(200, listPart(scope, f, offset, limit));
    }
    if (p === "/actions/part/counts") return json(200, { counts: counts(scope) });
    const m = /^\/actions\/part\/card\/([^/]+)\/([^/]+)$/.exec(p);
    if (m) {
      let name: string, id: string;
      try { name = decodeURIComponent(m[1]); id = decodeURIComponent(m[2]); } catch { return null; }
      if (!projectsIn(scope).includes(name) || !ID_RE.test(id)) return null;
      const a = hub.action(name, id);
      if (!a) return json(404, { ok: false });
      return json(200, { ok: true, html: actionCardHtml(a, { visible: new Set(projectsIn(scope)) }), item: actionOutlineItem(a), status: a.status, urgent: isUrgent(a), created: a.createdAt, counts: counts(scope) });
    }
    return null;
  }

  // ----- agents' API: the project's token on every call, never on the public listener -----
  async function body(req: Request): Promise<any> {
    if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) throw new InputError("send Content-Type: application/json");
    const raw = await req.text();
    if (raw.length > 256_000) throw new InputError("body over 256 kB");
    try { return JSON.parse(raw); } catch { throw new InputError("bad JSON"); }
  }
  const out = (a: FullAction) => ({ ...a, url: `/r/${encodeURIComponent(a.project)}/actions#${domId(a.project, a.id)}` });
  async function api(req: Request, p: string, scope: Scope): Promise<Response> {
    if (scope) return json(404, { ok: false, error: "not here" });
    const m = /^\/api\/actions\/([^/]+)(?:\/([^/]+)(?:\/steps\/(\d{1,3}))?)?\/?$/.exec(p);
    if (!m) return json(404, { ok: false, error: "unknown path" });
    let project: string, id: string | undefined;
    try { project = decodeURIComponent(m[1]); id = m[2] && decodeURIComponent(m[2]); } catch { return json(400, { ok: false, error: "bad path" }); }
    if (!projectsIn(null).includes(project)) return json(404, { ok: false, error: `no folder named ${project} in artipeek's config` });
    const tok = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
    if (!hub.tokenOk(project, tok)) {
      console.log(`artipeek: actions API refused for ${project} (bad or missing token) ${req.method} ${p.slice(0, 80)}`);
      return json(401, { ok: false, error: `token missing or wrong for ${project} (artipeek decisions token ${project})` });
    }
    if (id && !ID_RE.test(id)) return json(400, { ok: false, error: "bad id" });
    try {
      if (!id) {
        if (req.method === "GET") {
          const st = new URL(req.url).searchParams.get("status") ?? "open,agent,checking";
          const statuses = st === "all" ? undefined : st.split(",").filter((x) => (ACTION_STATUSES as readonly string[]).includes(x));
          return json(200, { ok: true, actions: hub.actionList({ projects: [project], statuses }).map(out) });
        }
        if (req.method === "POST") {
          const newId = hub.createAction(project, await body(req));
          return json(201, { ok: true, id: newId, url: out(hub.action(project, newId)!).url });
        }
        return json(405, { ok: false, error: "GET or POST" });
      }
      if (m[3]) {
        if (req.method !== "PATCH") return json(405, { ok: false, error: "PATCH" });
        hub.setStep(project, id, Number(m[3]), await body(req));
        return json(200, { ok: true, action: out(hub.action(project, id)!) });
      }
      if (req.method === "GET") {
        const a = hub.action(project, id);
        return a ? json(200, { ok: true, action: out(a) }) : json(404, { ok: false, error: `${id} is not an action of ${project}` });
      }
      if (req.method === "PATCH") {
        // fields (title, context, steps…) and/or {status: done|withdrawn|open, note, force}
        const b = await body(req);
        if (!b || typeof b !== "object" || Array.isArray(b)) throw new InputError("send a JSON object");
        const { status, note, force, ...fields } = b;
        if (status === undefined && (note !== undefined || force !== undefined)) throw new InputError("note and force go with status");
        if (Object.keys(fields).length) hub.updateAction(project, id, fields);
        if (status !== undefined) hub.resolveAction(project, id, { status, note, force });
        return json(200, { ok: true, action: out(hub.action(project, id)!) });
      }
      return json(405, { ok: false, error: "GET or PATCH" });
    } catch (e) {
      if (e instanceof InputError) return json(400, { ok: false, error: e.message });
      console.log(`artipeek: actions API error: ${(e as Error).message}`);
      return json(500, { ok: false, error: "server error" });
    }
  }

  return { api, pane, part, pageFilter, counts };
}
