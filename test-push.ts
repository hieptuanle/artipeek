#!/usr/bin/env bun
// Push for the iOS app, against a fake APNs (a local cleartext http2 server; push.apns.origin points at it): who may
// register a device, which decisions push ("new" and "urgent", once each), that history and imports never push, and
// that a dead token is dropped. Temp folders, its own server and fake Cloudflare Access certs. Sends nothing real.
//   bun run test:push
import http2 from "node:http2";
import { generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHub } from "./db/store.ts";

const MAIN = Number(process.env.TEST_PORT ?? 4375), PUB = MAIN + 1, CERTS = MAIN + 2, APNS = MAIN + 3;
const B = `http://127.0.0.1:${PUB}`, L = `http://127.0.0.1:${MAIN}`;
for (const port of [MAIN, PUB, CERTS, APNS])
  if (await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)) { console.log(`FAIL port ${port} is already in use`); process.exit(1); }

const T = mkdtempSync(join(tmpdir(), "artipeek-push-"));
const one = join(T, "one"), secret = join(T, "secret"), tok = join(T, "tok");
for (const d of [one, secret, tok, join(T, "cfg")]) mkdirSync(d, { recursive: true });
writeFileSync(join(one, "README.md"), "# one\n");
writeFileSync(join(secret, "README.md"), "# secret\n");

// an APNs-like signing key (EC P-256), and the fake APNs that checks the JWT with its public half
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const keyPath = join(T, "cfg", "AuthKey_TEST.p8");
writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
const BUNDLE = "com.example.artipeek";
type Got = { token: string; headers: Record<string, string>; body: any; jwtOk: boolean };
let got: Got[] = [];
const DEAD = "bb".repeat(32), BAD = "cc".repeat(32), GOOD = "aa".repeat(32), FLAKY = "dd".repeat(32);
const apns = http2.createServer();
apns.on("stream", (st, h) => {
  let raw = "";
  st.setEncoding("utf8");
  st.on("data", (c) => { raw += c; });
  st.on("end", () => {
    const token = String(h[":path"]).replace("/3/device/", "");
    const [hd, cl, sig] = String(h.authorization ?? "").replace(/^bearer /, "").split(".");
    let jwtOk = false;
    try {
      const head = JSON.parse(Buffer.from(hd, "base64url").toString()), claims = JSON.parse(Buffer.from(cl, "base64url").toString());
      jwtOk = head.alg === "ES256" && head.kid === "KEYID" && claims.iss === "TEAMID"
        && cryptoVerify("SHA256", Buffer.from(`${hd}.${cl}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url"));
    } catch {}
    got.push({ token, headers: Object.fromEntries(Object.entries(h).map(([k, v]) => [k, String(v)])), body: JSON.parse(raw), jwtOk });
    const [status, reason] = token === DEAD ? [410, "Unregistered"] : token === BAD ? [400, "BadDeviceToken"] : token === FLAKY ? [503, "ServiceUnavailable"] : [200, ""];
    st.respond({ ":status": status, "apns-id": "x" });
    st.end(reason ? JSON.stringify({ reason }) : "");
  });
});
await new Promise<void>((r) => apns.listen(APNS, "127.0.0.1", () => r()));

const certs = Bun.spawn(["bun", "test-access.ts", String(CERTS), tok], { cwd: import.meta.dir, stdout: "ignore", stderr: "ignore" });
for (let i = 0; i < 100 && !existsSync(join(tok, "ready")); i++) await Bun.sleep(100);
const cfgFile = join(T, "cfg", "config.json");
const dbFile = join(T, "cfg", "decisions.db");
writeFileSync(cfgFile, JSON.stringify({
  roots: [{ name: "one", path: one }, { name: "secret", path: secret }],
  public: { port: PUB, teamDomain: "test.cloudflareaccess.com", aud: "test-aud", emails: ["user@example.com"], roots: ["one"], certsUrl: `http://127.0.0.1:${CERTS}/cdn-cgi/access/certs` },
  push: { apns: { keyPath, keyId: "KEYID", teamId: "TEAMID", bundleId: BUNDLE, origin: `http://127.0.0.1:${APNS}` } },
}));
const env = { ...process.env, ARTIPEEK_CONFIG: cfgFile, ARTIPEEK_NO_RESTART: "1" };
const tokOf = (name: string) => /apk_[A-Za-z0-9_-]+/.exec(Bun.spawnSync(["bun", "cli.ts", "decisions", "token", name], { cwd: import.meta.dir, env }).stdout.toString())![0];
const TOK = { one: tokOf("one"), secret: tokOf("secret") };

const hour = 3600_000, day = 24 * hour;
const iso = (ms: number) => new Date(ms).toISOString();
// History, there before the server starts: old decisions, one flagged urgent and one past its deadline.
{
  const h = openHub(dbFile);
  h.create("one", { id: "D1", title: "Old question" }, { createdAt: iso(Date.now() - 30 * day) });
  h.create("one", { id: "D2", title: "Old urgent", urgent: true }, { createdAt: iso(Date.now() - 3 * day) });
  h.create("one", { id: "D3", title: "Old, deadline passed", deadline: iso(Date.now() - day) }, { createdAt: iso(Date.now() - 5 * day) });
  h.sqlite.query("UPDATE decisions SET updated_at = created_at").run();
  h.sqlite.close();
}

let srv: ReturnType<typeof Bun.spawn>;
const start = async () => {
  srv = Bun.spawn(["bun", "server.ts", "--config", cfgFile, "--port", String(MAIN)], { cwd: import.meta.dir, stdout: "pipe", stderr: "inherit" });
  for (let i = 0; i < 50 && !(await fetch(L).then(() => true, () => false)); i++) await Bun.sleep(100);
};
await start();

let fails = 0;
const ok = (c: unknown, m: string) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails++; };
const wait = (ms = 600) => Bun.sleep(ms);
const jwt = readFileSync(join(tok, "valid.jwt"), "utf8");
const api = async (method: string, p: string, body?: unknown, token = TOK.one) => {
  const r = await fetch(L + p, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, j: await r.json().catch(() => ({})) as any };
};
const page = { "Content-Type": "application/json", "X-Artipeek": "push", "Sec-Fetch-Site": "same-origin" };
const push = async (base: string, what: string, body: unknown, headers: Record<string, string>) => {
  const r = await fetch(`${base}/_/push/${what}`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: r.status, j: await r.json().catch(() => ({})) as any };
};
const reg = (token: string, environment = "production", extra: Record<string, string> = {}) =>
  push(B, "register", { token, environment, bundle: BUNDLE, name: "Test phone" }, { ...page, "Cf-Access-Jwt-Assertion": jwt, ...extra });
const deviceCount = () => { const h = openHub(dbFile); const n = h.sqlite.query("SELECT count(*) AS n FROM push_devices").get() as any; h.sqlite.close(); return n.n as number; };
const forGood = () => got.filter((g) => g.token === GOOD);

try {
  // ----- who may register -----
  let r = await push(L, "register", { token: GOOD, environment: "production", bundle: BUNDLE }, page);
  ok(r.status === 403, "register from plain 127.0.0.1 is refused");
  r = await push(L, "register", { token: GOOD, environment: "production", bundle: BUNDLE }, { ...page, Authorization: `Bearer ${TOK.one}` });
  ok(r.status === 403, "register with an agent token is refused");
  r = await push(B, "register", { token: GOOD, environment: "production", bundle: BUNDLE }, { ...page });
  ok(r.status === 403, "the public listener without a login is refused");
  r = await reg(GOOD, "production", { "Sec-Fetch-Site": "cross-site" });
  ok(r.status === 403, "register that isn't a same-origin fetch from artipeek's page is refused");
  r = await push(B, "register", { token: GOOD, environment: "production", bundle: BUNDLE }, { ...page, "Content-Type": "text/plain", "Cf-Access-Jwt-Assertion": jwt });
  ok(r.status === 415, "register needs JSON");
  r = await push(B, "register", { token: GOOD, environment: "production", bundle: "com.other.app" }, { ...page, "Cf-Access-Jwt-Assertion": jwt });
  ok(r.status === 400, "a token for another app is refused");
  r = await push(B, "register", { token: "not-hex", environment: "production", bundle: BUNDLE }, { ...page, "Cf-Access-Jwt-Assertion": jwt });
  ok(r.status === 400, "a malformed token is refused");
  r = await reg(GOOD);
  ok(r.status === 200 && r.j.ok && r.j.devices === 1, "an Access login registers a device");
  for (const t of [DEAD, BAD]) await reg(t, "sandbox");
  ok(deviceCount() === 3, "three devices registered");
  await wait(800);
  ok(got.length === 0, `history (old, old urgent, old past deadline) pushed nothing (${got.length})`);

  // ----- new -----
  r = await api("POST", "/api/decisions/one", { title: "Merge the release branch?" });
  const newId = r.j.id;
  await wait();
  const n1 = forGood();
  ok(n1.length === 1, `a new open decision pushes once (${n1.length})`);
  const p1 = n1[0]?.body;
  ok(p1?.aps?.alert?.title === `one · ${newId} · new` && p1.aps.alert.body === "Merge the release branch?", `title "folder · id · new", body the decision's title (${JSON.stringify(p1?.aps?.alert)})`);
  ok(p1?.aps?.["thread-id"] === "one" && p1?.aps?.sound === "default" && p1?.project === "one" && p1?.id === newId && p1?.url === `/r/one/decisions#d:one:${newId}`, "thread-id = folder, sound, data {project, id, url}");
  ok(p1?.aps?.badge === 4, `badge = open decisions the device can see (${p1?.aps?.badge})`);
  ok(n1[0]?.jwtOk && n1[0]?.headers["apns-topic"] === BUNDLE && n1[0]?.headers["apns-push-type"] === "alert", "ES256 provider token, topic = bundle id, push type alert");
  ok(deviceCount() === 1, `410 Unregistered and BadDeviceToken drop those tokens (${deviceCount()} left)`);

  // ----- urgent -----
  got = [];
  await api("PATCH", `/api/decisions/one/${newId}`, { urgent: true });
  await wait();
  ok(forGood().length === 1 && forGood()[0].body.aps.alert.title === `one · ${newId} · urgent`, "flagged urgent: one urgent push");
  await api("PATCH", `/api/decisions/one/${newId}`, { title: "Merge the release branch today?" });
  await api("POST", `/api/decisions/one/${newId}/notes`, { body: "two more PRs" });
  await api("PATCH", `/api/decisions/one/${newId}`, { urgent: false });
  await api("PATCH", `/api/decisions/one/${newId}`, { urgent: true });
  await wait();
  ok(forGood().length === 1, `…and never again for that decision (${forGood().length})`);

  got = [];
  r = await api("POST", "/api/decisions/one", { title: "Rotate the key?", deadline: iso(Date.now() + 5 * hour) });
  await wait();
  ok(forGood().length === 1 && forGood()[0].body.aps.alert.title === `one · ${r.j.id} · urgent`, "raised with a deadline under 24 h: one push, marked urgent (not new + urgent)");

  // a deadline that crosses the 24 h line later (no write to that decision)
  got = [];
  r = await api("POST", "/api/decisions/one", { title: "Renew the domain?", deadline: iso(Date.now() + day + 2500) });
  const crossId = r.j.id;
  await wait();
  ok(forGood().length === 1 && forGood()[0].body.aps.alert.title.endsWith("· new"), "deadline just over 24 h: new only");
  await Bun.sleep(3000);
  await api("PATCH", `/api/decisions/one/${newId}`, { lane: "ops" }); // any change runs the check (the server also checks every minute)
  await wait();
  ok(forGood().some((g) => g.body.aps.alert.title === `one · ${crossId} · urgent`), "…urgent once its deadline comes within 24 h");

  // ----- not pushed -----
  got = [];
  await api("POST", "/api/decisions/one", { title: "Park this", status: "later" });
  await api("POST", "/api/decisions/secret", { title: "Private question", urgent: true }, TOK.secret);
  await wait();
  ok(forGood().length === 0, "a decision raised for later, or in a folder the device can't see (not public), doesn't push");
  // actions: one push when raised, with the action buttons ("Ask the agent…", "Open"); a tap opens it
  r = await api("POST", "/api/actions/one", { title: "Run the backfill", steps: ["ssh", "run"] });
  await wait();
  const pa = forGood();
  ok(pa.length === 1 && pa[0].body.aps.alert.title === `one · ${r.j.id} · action for you` && pa[0].body.aps.alert.body === "Run the backfill\n2 steps" && pa[0].body.url === `/r/one/actions#a:one:${r.j.id}`, `a new action pushes once; a tap opens it (${JSON.stringify(pa[0]?.body?.aps?.alert)})`);
  ok(pa[0]?.body.aps.category === "artipeek.action" && pa[0]?.body.kind === "action" && pa[0]?.body.project === "one" && pa[0]?.body.id === r.j.id && !pa[0]?.body.aps["mutable-content"], "…category artipeek.action, data {kind, project, id, url} (no notification extension)");
  const openDec = (await api("GET", "/api/decisions/one?status=open")).j.decisions.length;
  ok(pa[0]?.body.aps.badge === openDec + 1, `badge = open decisions + actions to do (${pa[0]?.body.aps.badge} = ${openDec} + 1)`);
  got = [];
  await api("PATCH", `/api/actions/one/${r.j.id}`, { title: "Run the backfill tonight" });
  await wait();
  ok(forGood().length === 0, "…and never again for that action");
  got = [];
  // an import by another process (old raise time, open, flagged urgent, a deadline tomorrow)
  {
    const h = openHub(dbFile);
    h.create("one", { id: "H7", title: "Imported", urgent: true, deadline: iso(Date.now() + 20 * hour) }, { createdAt: iso(Date.now() - 10 * day) });
    h.sqlite.query("UPDATE decisions SET updated_at = created_at WHERE id = 'H7'").run();
    h.sqlite.close();
  }
  await wait(1800);
  ok(forGood().length === 0, "an import (old decisions, written by another process) pushes nothing");

  // ----- a restart pushes nothing again -----
  srv!.kill(); await srv!.exited;
  await start(); await wait(1200);
  ok(forGood().length === 0, "after a restart nothing is pushed again");

  // ----- APNs down: retried, not lost -----
  await reg(FLAKY, "production");
  got = [];
  r = await api("POST", "/api/decisions/one", { title: "Flaky delivery?" });
  await wait();
  const h0 = openHub(dbFile);
  const marked = h0.sqlite.query("SELECT sent FROM push_sent WHERE project = 'one' AND decision_id = ? AND kind = 'new'").get(r.j.id) as any;
  h0.sqlite.close();
  ok(marked?.sent === 1 && got.some((g) => g.token === FLAKY), "a 503 for one device doesn't drop it, and the push still counts for the device that got it");

  // ----- answer buttons on the push -----
  got = [];
  r = await api("POST", "/api/decisions/one", { title: "Ship on Friday?", questions: [{ options: [{ value: "A", label: "Ship Friday", recommended: true }, { value: "B", label: "Wait a week" }] }] });
  const abId = r.j.id;
  await api("POST", "/api/decisions/one", { title: "Pick a colour", questions: [{ options: [{ value: "R", label: "red" }, { value: "G", label: "green" }] }] });
  await api("POST", "/api/decisions/one", { title: "Two questions", questions: [{ key: "Q1", options: [{ value: "A", label: "a" }] }, { key: "Q2", options: [{ value: "A", label: "a" }] }] });
  await wait();
  const byTitle = (t: string) => forGood().find((g) => g.body.aps.alert.body.startsWith(t))?.body;
  const ab = byTitle("Ship on Friday?"), rg = byTitle("Pick a colour"), two = byTitle("Two questions");
  ok(ab?.aps?.category === "artipeek.opts.AB" && ab?.aps?.["mutable-content"] === 1 && ab?.options?.length === 2 && ab.options[0].recommended === true,
    `one question, options A/B: the fixed A/B button category, mutable for the app's extension, options in the data (${ab?.aps?.category})`);
  ok(ab?.aps?.alert?.body === "Ship on Friday?\nA ★ Ship Friday\nB Wait a week", "…and the options in the text (the Watch shows them)");
  ok(rg?.aps?.category === "artipeek.reply" && rg?.options?.length === 2, "other option values: reply category, options still in the data (the extension makes the buttons)");
  ok(two?.aps?.category === "artipeek.reply" && !two?.options && two?.aps?.alert?.body === "Two questions", "several questions: reply only, no options");

  // the Watch app's list (same login as the page; read-only)
  const lr = await fetch(`${B}/decisions/part/app.json`, { headers: { "Cf-Access-Jwt-Assertion": jwt } });
  const lj = await lr.json() as any;
  ok(lr.status === 200 && lj.decisions.length === lj.open && lj.decisions[0].urgent && lj.urgent >= 2, `Watch list: open decisions, urgent first (${lj.open} open, ${lj.urgent} urgent)`);
  ok(lj.decisions.every((d: any) => d.project === "one"), "…only the folders of this listener");
  ok((await fetch(`${B}/decisions/part/app.json`)).status === 403, "…and only with a login");

  // an answer from a push button or the Watch: a native request with the login cookie and artipeek's headers
  const ans = await fetch(`${B}/r/one/answer`, { method: "POST", headers: { Cookie: `CF_Authorization=${jwt}`, "Content-Type": "application/json", "X-Artipeek": "answer", "Sec-Fetch-Site": "same-origin" }, body: JSON.stringify({ id: abId, text: "A", page: "artipeek:watch" }) });
  const hA = openHub(dbFile);
  const row = hA.sqlite.query("SELECT a.page, a.by, d.status FROM decision_answers a JOIN decisions d ON d.project = a.project AND d.id = a.decision_id WHERE a.project = 'one' AND a.decision_id = ?").get(abId) as any;
  hA.sqlite.close();
  ok(ans.status === 200 && row?.page === "artipeek:watch" && row?.by === "user@example.com" && row?.status === "answered", "an answer from the Watch is saved as the person's, marked as sent from the Watch");
  const agent = await fetch(`${L}/r/one/answer`, { method: "POST", headers: { Authorization: `Bearer ${TOK.one}`, "Content-Type": "application/json", "X-Artipeek": "answer", "Sec-Fetch-Site": "same-origin" }, body: JSON.stringify({ id: abId, text: "B", page: "artipeek:watch" }) });
  ok(agent.status === 403, "…and an agent still can't answer");

  // ----- test push and unregister -----
  got = [];
  r = await push(B, "test", { token: GOOD }, { ...page, "Cf-Access-Jwt-Assertion": jwt });
  ok(r.status === 200 && r.j.sent === 1 && forGood()[0]?.body?.aps?.alert?.title === "artipeek · test", "send a test push to this device");
  r = await push(L, "test", {}, page);
  ok(r.status === 403, "a test push from 127.0.0.1 is refused");
  r = await push(B, "unregister", { token: GOOD }, { ...page, "Cf-Access-Jwt-Assertion": jwt });
  ok(r.status === 200 && r.j.removed, "unregister");
  r = await push(B, "test", { token: GOOD }, { ...page, "Cf-Access-Jwt-Assertion": jwt });
  ok(r.status === 404, "…then a test push says the device is not registered");
} finally {
  srv!.kill(); certs.kill(); apns.close();
  rmSync(T, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : "\nall push tests passed");
process.exit(fails ? 1 : 0);
