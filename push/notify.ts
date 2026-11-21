// Push for artipeek's iOS app: the person's devices, and a notice when a decision is raised or turns urgent.
//
// - Devices: POST /_/push/register, /_/push/unregister, /_/push/test, only from the person (a Cloudflare Access login,
//   or a device in answerDevices; never plain 127.0.0.1, never an agent token) and only as a same-origin fetch from
//   artipeek's own page (the app calls them from its web view), like answers. See server.ts.
// - Triggers: check() runs after every hub change, when another process writes the file, and once a minute (deadlines
//   cross the 24 h line without a write). Each decision gets at most one "new" and one "urgent" push, recorded in
//   push_sent, so a restart or a re-import never pushes again.
// - Actions (checklists for the person) get one "new" push when raised (same push_sent table: ids are unique within a
//   project across decisions and actions). Buttons (category artipeek.action, app 1.2): "Ask the agent…" (an optional
//   note, then Send: the app posts op "agent" like the page) and "Open"; a tap opens the action.
// - Badge: open decisions + actions to do (status open) the device can see. Actions with the agent don't count: they
//   wait on the agent, not the person. The app (WebController.refreshBadge, the Watch's app.json "badge") counts the same.
// - History never pushes: a decision first seen when it was raised (and last changed) more than FRESH_MS ago is marked
//   as seen without a push. That covers imports, decisions from before push was set up, and long downtime.
import { eq } from "drizzle-orm";
import type { Hub } from "../db/store.ts";
import * as s from "../db/schema.ts";
import { createApns, deadToken, type ApnsConfig, type Env, type SendResult } from "./apns.ts";

export type PushConfig = { apns?: Partial<ApnsConfig> };
export type DeviceScope = "public" | "all";
type Deps = {
  hub: Hub;
  config: PushConfig | undefined;
  // the folders a device of this scope may hear about
  projectsFor: (scope: DeviceScope) => string[];
};

export const FRESH_MS = 15 * 60_000; // a change newer than this is news
export const DEADLINE_GRACE_MS = 6 * 3600_000; // a deadline that crossed the 24 h line this recently still counts
const URGENT_MS = 24 * 3600_000;
export const MAX_OPTIONS = 4; // buttons on a push (the Watch shows four well)
const STATIC_CATEGORIES = new Set(["AB", "ABC", "ABCD", "YN"]); // must match the iOS app's fixed categories
const TOKEN_RE = /^[0-9a-f]{32,200}$/;
const BUNDLE_RE = /^[A-Za-z0-9.-]{1,155}$/;
const short = (t: string) => t.slice(0, 8) + "…";
const now = () => new Date().toISOString();

export function createPush(deps: Deps) {
  const { hub } = deps;
  const a = deps.config?.apns;
  const cfg: ApnsConfig | null = a && a.keyPath && a.keyId && a.teamId && a.bundleId
    ? { keyPath: a.keyPath, keyId: a.keyId, teamId: a.teamId, bundleId: a.bundleId, ...(a.origin ? { origin: a.origin } : {}) } : null;
  if (deps.config && !cfg) console.log("artipeek (push): push.apns needs keyPath, keyId, teamId, bundleId; push off");
  const apns = cfg ? createApns(cfg) : null;
  const db = hub.db;

  // ----- devices -----
  const devices = () => db.select().from(s.pushDevices).all();
  function drop(token: string, why: string) {
    db.delete(s.pushDevices).where(eq(s.pushDevices.token, token)).run();
    console.log(`artipeek (push): device ${short(token)} dropped (${why})`);
  }
  // The app's badge for a device of this scope: open decisions + actions to do.
  function badgeCount(scope: DeviceScope): number {
    const ps = deps.projectsFor(scope);
    return ps.length ? hub.count({ projects: ps, statuses: ["open"] }) + hub.actionCount({ projects: ps, statuses: ["open"] }) : 0;
  }

  async function sendTo(list: (typeof s.pushDevices.$inferSelect)[], build: (d: typeof s.pushDevices.$inferSelect) => { payload: unknown; headers?: Record<string, string> } | null) {
    let sent = 0, transient = 0;
    await Promise.all(list.map(async (d) => {
      const m = build(d);
      if (!m || !apns) return;
      const r: SendResult = await apns.send(d.token, d.environment as Env, m.payload, m.headers);
      if (r.status === 200) { sent++; return; }
      if (deadToken(r)) { drop(d.token, `${r.status} ${r.reason ?? ""}`.trim()); return; }
      if (r.status === 0 || r.status >= 500 || r.status === 429) transient++;
      console.log(`artipeek (push): device ${short(d.token)} (${d.environment}): ${r.status} ${r.reason ?? ""}`);
    }));
    return { sent, transient };
  }

  // ----- triggers -----
  type Row = { project: string; id: string; title: string; questions: string | null; urgent: number; deadline: string | null; createdAt: string; updatedAt: string; newAt: string | null; urgAt: string | null };
  function pending(): Row[] {
    return hub.sqlite.query(`SELECT d.project, d.id, d.title, d.questions, d.urgent, d.deadline, d.created_at AS createdAt, d.updated_at AS updatedAt, n.at AS newAt, u.at AS urgAt
      FROM decisions d
      LEFT JOIN push_sent n ON n.project = d.project AND n.decision_id = d.id AND n.kind = 'new'
      LEFT JOIN push_sent u ON u.project = d.project AND u.decision_id = d.id AND u.kind = 'urgent'
      WHERE d.status = 'open' AND (n.at IS NULL OR u.at IS NULL)`).all() as Row[];
  }
  function mark(project: string, id: string, kinds: ("new" | "urgent")[], sent: number) {
    const at = now();
    for (const kind of kinds) db.insert(s.pushSent).values({ project, decisionId: id, kind, at, sent }).onConflictDoNothing().run();
  }

  let running = false, again = false;
  async function check(): Promise<void> {
    if (running) { again = true; return; }
    running = true;
    try {
      do { again = false; await checkOnce(); } while (again);
    } catch (e) { console.log(`artipeek (push): check failed: ${(e as Error).message}`); }
    finally { running = false; }
  }
  async function checkOnce() {
    const t = Date.now();
    const fresh = (iso: string) => t - Date.parse(iso) < FRESH_MS;
    for (const r of pending()) {
      const urgentNow = !!r.urgent || (!!r.deadline && Date.parse(r.deadline) - t < URGENT_MS);
      const wantNew = !r.newAt, wantUrg = !r.urgAt && urgentNow;
      if (!wantNew && !wantUrg) continue;
      // Is this news? New: raised just now. Urgent: raised or changed just now (the flag set), or the deadline just
      // crossed the 24 h line.
      const newsNew = wantNew && fresh(r.createdAt);
      // (only for a decision seen before: one first seen now is history unless it was raised or changed just now)
      const crossed = !!r.newAt && !!r.deadline && Date.parse(r.deadline) - URGENT_MS > t - DEADLINE_GRACE_MS;
      const newsUrg = wantUrg && (fresh(r.createdAt) || fresh(r.updatedAt) || crossed);
      const kinds = [...(wantNew ? ["new" as const] : []), ...(wantUrg ? ["urgent" as const] : [])];
      if (!newsNew && !newsUrg) { mark(r.project, r.id, kinds, 0); continue; }
      const kind = newsUrg ? "urgent" : "new";
      const res = await notify(r, kind);
      // Nothing reached a device only because of a network or APNs hiccup: leave it unmarked, the next check retries
      // (while it is still news).
      if (res.sent === 0 && res.transient > 0) continue;
      mark(r.project, r.id, kinds, res.sent);
      if (res.sent) console.log(`artipeek (push): ${kind} ${r.id} in ${r.project} sent to ${res.sent} device(s)`);
    }
    const acts = hub.sqlite.query(`SELECT a.project, a.id, a.title, a.created_at AS createdAt, (SELECT count(*) FROM action_steps st WHERE st.project = a.project AND st.action_id = a.id) AS steps
      FROM actions a LEFT JOIN push_sent n ON n.project = a.project AND n.decision_id = a.id AND n.kind = 'new'
      WHERE a.status = 'open' AND n.at IS NULL`).all() as { project: string; id: string; title: string; createdAt: string; steps: number }[];
    for (const r of acts) {
      if (!fresh(r.createdAt)) { mark(r.project, r.id, ["new"], 0); continue; }
      const res = await notifyAction(r);
      if (res.sent === 0 && res.transient > 0) continue;
      mark(r.project, r.id, ["new"], res.sent);
      if (res.sent) console.log(`artipeek (push): action ${r.id} in ${r.project} sent to ${res.sent} device(s)`);
    }
  }
  function notifyAction(r: { project: string; id: string; title: string; steps: number }) {
    if (!apns) return Promise.resolve({ sent: 0, transient: 0 });
    const list = devices().filter((d) => deps.projectsFor(d.scope as DeviceScope).includes(r.project));
    return sendTo(list, (d) => d.bundle !== cfg!.bundleId ? null : {
      payload: {
        aps: { alert: { title: `${r.project} · ${r.id} · action for you`, body: `${r.title.slice(0, 240)}\n${r.steps} step${r.steps === 1 ? "" : "s"}` }, sound: "default", badge: badgeCount(d.scope as DeviceScope), "thread-id": r.project, category: "artipeek.action" },
        kind: "action", project: r.project, id: r.id, url: `/r/${encodeURIComponent(r.project)}/actions#a:${r.project}:${r.id}`,
      },
      headers: Buffer.byteLength(`${r.project}:${r.id}`) <= 64 ? { "apns-collapse-id": `${r.project}:${r.id}` } : {},
    });
  }

  function notify(r: Row, kind: "new" | "urgent") {
    if (!apns) return Promise.resolve({ sent: 0, transient: 0 });
    const list = devices().filter((d) => deps.projectsFor(d.scope as DeviceScope).includes(r.project));
    const badge = new Map<string, number>();
    const a = answerable(r);
    return sendTo(list, (d) => {
      if (d.bundle !== cfg!.bundleId) return null;
      const n = badge.get(d.scope) ?? badgeCount(d.scope as DeviceScope);
      badge.set(d.scope, n);
      return {
        payload: {
          aps: { alert: { title: `${r.project} · ${r.id} · ${kind}`, body: a.body }, sound: "default", badge: n, "thread-id": r.project, category: a.category, "mutable-content": 1 },
          project: r.project, id: r.id, url: `/r/${encodeURIComponent(r.project)}/decisions#d:${r.project}:${r.id}`,
          ...(a.options ? { options: a.options } : {}),
        },
        headers: Buffer.byteLength(`${r.project}:${r.id}`) <= 64 ? { "apns-collapse-id": `${r.project}:${r.id}` } : {},
      };
    });
  }

  // Answer buttons on the push (the iPhone, and the Watch when the phone is locked): a decision with one question and
  // up to MAX_OPTIONS options gets them. The app's notification extension makes buttons with the labels; without it,
  // a fixed category for the usual value sets (A/B, A/B/C, A/B/C/D, Y/N) still shows letter buttons, and the options are
  // in the text. Anything else gets "Reply…" (type, dictate or scribble an answer) and "Open".
  function answerable(r: Row): { body: string; category: string; options?: { value: string; label: string; recommended?: boolean }[] } {
    let qs: { key?: string; options: { value: string; label: string; recommended?: boolean }[] }[] = [];
    try { qs = JSON.parse(r.questions ?? "[]") ?? []; } catch {}
    const title = r.title.slice(0, 240);
    if (qs.length !== 1 || !qs[0].options?.length || qs[0].options.length > MAX_OPTIONS) return { body: title, category: "artipeek.reply" };
    const options = qs[0].options.map((o) => ({ value: o.value, label: o.label.slice(0, 60), ...(o.recommended ? { recommended: true } : {}) }));
    const values = options.map((o) => o.value).join("");
    const body = [title, ...options.map((o) => `${o.value}${o.recommended ? " ★" : ""} ${o.label}`)].join("\n").slice(0, 700);
    return { body, options, category: STATIC_CATEGORIES.has(values) ? `artipeek.opts.${values}` : "artipeek.reply" };
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  const soon = () => { if (!timer) timer = setTimeout(() => { timer = null; void check(); }, 200); };
  hub.onChange(() => soon());
  hub.onAction(() => soon());
  let ver = hub.dataVersion();
  setInterval(() => { const v = hub.dataVersion(); if (v !== ver) { ver = v; soon(); } }, 1000);
  setInterval(() => soon(), 60_000);
  soon(); // at start: mark what is already there (history), push only what is news

  // ----- the person's endpoints -----
  const json = (status: number, o: unknown) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  // `by`: who is asking (already checked by the server: a login or an answer device; "" otherwise).
  async function http(req: Request, path: string, by: string, scope: DeviceScope): Promise<Response> {
    if (!by) return json(403, { ok: false, error: "push needs the public link (login) or a device in answerDevices" });
    if (req.headers.get("sec-fetch-site") !== "same-origin" || req.headers.get("x-artipeek") !== "push")
      return json(403, { ok: false, error: "not from artipeek's page" });
    if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return json(415, { ok: false, error: "JSON only" });
    const raw = await req.text();
    if (raw.length > 4096) return json(413, { ok: false, error: "too big" });
    let b: any;
    try { b = JSON.parse(raw); } catch { return json(400, { ok: false, error: "bad JSON" }); }
    if (!cfg) return json(503, { ok: false, error: "push is not set up on this server (push.apns in the config)" });
    const token = typeof b?.token === "string" ? b.token.toLowerCase() : "";
    if (path === "/_/push/register") {
      const env = b?.environment === "sandbox" || b?.environment === "production" ? b.environment : null;
      const bundle = typeof b?.bundle === "string" && BUNDLE_RE.test(b.bundle) ? b.bundle : "";
      if (!TOKEN_RE.test(token) || !env || !bundle) return json(400, { ok: false, error: "needs token (hex), environment (sandbox or production), bundle" });
      if (bundle !== cfg.bundleId) return json(400, { ok: false, error: "this server pushes to another app" });
      const name = typeof b?.name === "string" ? b.name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80) : "";
      const at = now();
      const known = db.select().from(s.pushDevices).where(eq(s.pushDevices.token, token)).get();
      db.insert(s.pushDevices).values({ token, environment: env, bundle, name, by, scope, createdAt: at, lastSeenAt: at })
        .onConflictDoUpdate({ target: s.pushDevices.token, set: { environment: env, bundle, name, by, scope, lastSeenAt: at } }).run();
      if (!known) console.log(`artipeek (push): device ${short(token)} (${env}${name ? `, ${name}` : ""}) registered by ${by}`);
      return json(200, { ok: true, devices: devices().length, badge: badgeCount(scope) });
    }
    if (path === "/_/push/unregister") {
      if (!TOKEN_RE.test(token)) return json(400, { ok: false, error: "needs token" });
      const known = db.select().from(s.pushDevices).where(eq(s.pushDevices.token, token)).get();
      if (known) { db.delete(s.pushDevices).where(eq(s.pushDevices.token, token)).run(); console.log(`artipeek (push): device ${short(token)} unregistered by ${by}`); }
      return json(200, { ok: true, removed: !!known });
    }
    if (path === "/_/push/test") {
      const all = devices();
      const list = token ? all.filter((d) => d.token === token) : all;
      if (!list.length) return json(404, { ok: false, error: token ? "this device is not registered" : "no devices" });
      const res = await sendTo(list, (d) => ({
        payload: { aps: { alert: { title: "artipeek · test", body: "Push works." }, sound: "default", badge: badgeCount(d.scope as DeviceScope) }, url: "/decisions" },
      }));
      console.log(`artipeek (push): test push by ${by}: ${res.sent}/${list.length} sent`);
      return json(res.sent ? 200 : 502, { ok: res.sent > 0, sent: res.sent, devices: list.length, ...(res.sent ? {} : { error: "APNs did not take it (see the server log)" }) });
    }
    return json(404, { ok: false, error: "unknown path" });
  }

  return { http, check, enabled: !!cfg, close: () => apns?.close() };
}
