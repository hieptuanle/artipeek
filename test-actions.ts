#!/usr/bin/env bun
// Actions: an agent raises a checklist of work only the person can do; the person ticks steps (or says all are done, or
// asks the agent to do it) on the Actions tab; the agent hears that like an answer (one line per batch of ticks, in the
// hub and the answers file), verifies each step, and closes the action. Temp folders, its own server and fake
// Cloudflare Access certs. Never touches real repos.
//   bun run test:actions     (needs Chromium; set CHROME_PATH if it isn't at /usr/bin/chromium)
import puppeteer from "puppeteer-core";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = Number(process.env.TEST_PORT ?? 4360), PUB = MAIN + 1, CERTS = MAIN + 2;
const B = `http://127.0.0.1:${PUB}`, L = `http://127.0.0.1:${MAIN}`;
for (const port of [MAIN, PUB, CERTS])
  if (await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)) { console.log(`FAIL port ${port} is already in use`); process.exit(1); }

const T = mkdtempSync(join(tmpdir(), "artipeek-actions-"));
const one = join(T, "one"), two = join(T, "two"), tok = join(T, "tok");
for (const d of [one, two, tok]) mkdirSync(d, { recursive: true });
writeFileSync(join(one, "README.md"), "# one\n");
writeFileSync(join(two, "README.md"), "# two\n");
const git = (d: string, ...a: string[]) => Bun.spawnSync(["git", "-C", d, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdout: "pipe" });
for (const d of [one, two]) { git(d, "init", "-q"); git(d, "add", "-A"); git(d, "commit", "-qm", "init"); }
const certs = Bun.spawn(["bun", "test-access.ts", String(CERTS), tok], { cwd: import.meta.dir, stdout: "ignore", stderr: "ignore" });
for (let i = 0; i < 100 && !existsSync(join(tok, "ready")); i++) await Bun.sleep(100);
const cfgFile = join(T, "cfg", "config.json");
mkdirSync(join(T, "cfg"));
writeFileSync(cfgFile, JSON.stringify({
  roots: [{ name: "one", path: one, answers: { file: "inbox/answers.jsonl", message: "answer {id}" } }, { name: "two", path: two }],
  public: { port: PUB, teamDomain: "test.cloudflareaccess.com", aud: "test-aud", emails: ["user@example.com"], roots: ["one", "two"], certsUrl: `http://127.0.0.1:${CERTS}/cdn-cgi/access/certs` },
}));
const env = { ...process.env, ARTIPEEK_CONFIG: cfgFile, ARTIPEEK_NO_RESTART: "1" };
const tokOf = (name: string) => /apk_[A-Za-z0-9_-]+/.exec(Bun.spawnSync(["bun", "cli.ts", "decisions", "token", name], { cwd: import.meta.dir, env }).stdout.toString())![0];
const TOK = { one: tokOf("one"), two: tokOf("two") };
const WAIT = 800; // the server's wait after the last tick (ARTIPEEK_ACTION_WAIT_MS), short for the test
let out = "";
let srv: ReturnType<typeof Bun.spawn>;
async function start() {
  srv = Bun.spawn(["bun", "server.ts", "--config", cfgFile, "--port", String(MAIN)], { cwd: import.meta.dir, stdout: "pipe", stderr: "inherit", env: { ...process.env, ARTIPEEK_ACTION_WAIT_MS: String(WAIT), ARTIPEEK_ACTION_MAX_WAIT_MS: "3000" } });
  (async () => { const rd = (srv.stdout as ReadableStream<Uint8Array>).getReader(); for (;;) { const { value, done } = await rd.read(); if (done) break; out += new TextDecoder().decode(value); } })();
  for (let i = 0; i < 50 && !(await fetch(B).then(() => true, () => false)); i++) await Bun.sleep(100);
}
await start();

let fails = 0;
const ok = (c: unknown, m: string) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails++; };
const jwt = readFileSync(join(tok, "valid.jwt"), "utf8");
const wait = (ms = 300) => Bun.sleep(ms);
const api = async (method: string, p: string, body?: unknown, token = TOK.one) => {
  const r = await fetch(L + p, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, j: (await r.json().catch(() => ({}))) as any };
};
// POST /r/<folder>/action as the person (public listener, logged in), unless told otherwise
async function act(body: unknown, o: { folder?: string; base?: string; login?: boolean; site?: string; hdr?: string } = {}) {
  const r = await fetch(`${o.base ?? B}/r/${o.folder ?? "one"}/action`, {
    method: "POST", body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", "X-Artipeek": o.hdr ?? "action", "Sec-Fetch-Site": o.site ?? "same-origin", ...(o.login === false ? {} : { "Cf-Access-Jwt-Assertion": jwt }) },
  });
  return { status: r.status, j: (await r.json().catch(() => ({}))) as any };
}
const page = async (p: string, base = B) => (await fetch(base + p, { headers: base === B ? { "Cf-Access-Jwt-Assertion": jwt } : {} })).text();
const lines = () => { const f = join(one, "inbox/answers.jsonl"); return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []; };
const commits = () => Number(git(one, "rev-list", "--count", "HEAD").stdout.toString().trim());
const get = async (id: string, folder = "one") => (await api("GET", `/api/actions/${folder}/${id}`, undefined, folder === "one" ? TOK.one : TOK.two)).j.action;
const states = async (id: string) => (await get(id)).steps.map((x: any) => x.state).join(",");
const decide = (...a: string[]) => Bun.spawnSync(["bun", "decide.ts", ...a, "--project", "one"], { cwd: import.meta.dir, env: { ...process.env, ARTIPEEK_URL: L, ARTIPEEK_TOKEN: TOK.one, HOME: T }, stdout: "pipe", stderr: "pipe" });
const STEPS = [
  { text: "SSH to **db-server**", where: "your laptop" },
  { text: "Run the backfill", command: "cd ~/work && bun cli/migrations/backfill.ts --go", where: "db-server, after 22:00", links: [{ label: "the script", href: "https://git.example.com/x/backfill.ts" }] },
  { text: "Post the notice in #ops" },
];

const br = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
try {
  // ----- the agent raises it -----
  ok((await api("POST", "/api/decisions/one", { id: "D317", title: "Backfill the invoices tonight?", questions: [{ options: [{ value: "A", label: "yes" }, { value: "B", label: "no" }] }] })).status === 201, "a decision to come from (D317)");
  let r = await api("POST", "/api/actions/one", { title: "Run the invoice backfill on db-server", context: "You answered **A** on D317.", from: ["D317"], steps: STEPS, deadline: new Date(Date.now() + 3600_000).toISOString() });
  ok(r.status === 201 && r.j.id === "A1" && r.j.url === "/r/one/actions#a:one:A1", "API: an action with steps → A1");
  ok((await api("POST", "/api/actions/one", { title: "no steps", steps: [] })).status === 400, "API: an action needs at least one step");
  ok((await api("POST", "/api/actions/one", { title: "x", steps: ["a"] }, TOK.two)).status === 401, "API: another folder's token is refused");
  ok((await fetch(`${B}/api/actions/one`, { headers: { "Cf-Access-Jwt-Assertion": jwt, Authorization: `Bearer ${TOK.one}` } })).status === 404, "API: not on the public listener");
  ok((await api("POST", "/api/actions/one", { title: "x", steps: [{ text: "a", links: [{ href: "javascript:alert(1)" }] }] })).status === 400, "API: a javascript: link in a step is refused");
  ok((await api("POST", "/api/decisions/one", { id: "A1", title: "x" })).status === 400 && (await api("POST", "/api/actions/one", { id: "D317", title: "x", steps: ["a"] })).status === 400, "ids are unique across decisions and actions");
  ok((await api("POST", "/api/decisions/one", { title: "next" })).j.id === "D318", "a decision's next id skips nothing it shouldn't (D318)");
  let a = await get("A1");
  ok(a.status === "open" && a.steps.length === 3 && a.steps[1].command.includes("backfill.ts --go") && a.steps[1].where === "db-server, after 22:00" && a.from[0].id === "D317" && a.from[0].title, "API: steps with command, where, links; from D317 with its title");
  const d = (await api("GET", "/api/decisions/one/D317")).j.decision;
  ok(d.actions?.[0]?.id === "A1" && d.actions[0].status === "open", "the decision lists the actions that came out of it");
  ok((await page("/r/one/decisions")).includes('href="/actions#a:one:A1"'), "…and its card links to A1");
  let h = await page("/r/one/actions");
  ok(h.includes('data-kind="act"') && h.includes("Run the invoice backfill") && h.includes('class="codeblock acmd"') && h.includes("db-server, after 22:00") && h.includes('href="/decisions#d:one:D317"'), "the Actions page: the card, the command block, where, the link to D317");
  ok(h.includes('class="navdec navact') && /class="nd-open" title="to do">1</.test(h), "the file list has Actions, with 1 to do");
  ok((await page("/")).includes('class="rootcard deccard actcard"'), "the home page has an Actions card");
  ok((await page("/r/one/actions", L)).includes("can't tick steps"), "on plain 127.0.0.1 the page says it can't tick");

  // ----- who may tick -----
  ok((await act({ id: "A1", op: "tick", step: 1 }, { base: L, login: false })).status === 403, "an agent on 127.0.0.1 can't tick");
  ok((await act({ id: "A1", op: "tick", step: 1 }, { hdr: "answer" })).status === 403, "without X-Artipeek: action → refused");
  ok((await act({ id: "A1", op: "tick", step: 1 }, { site: "cross-site" })).status === 403, "a cross-site request → refused");
  ok((await act({ id: "D317", op: "tick", step: 1 })).status === 404, "a decision id is not an action");
  ok((await act({ id: "A1", op: "tick", step: 9 })).status === 409, "a step that doesn't exist → refused");

  // ----- ticks wait, then go out together -----
  const c0 = commits();
  await act({ id: "A1", op: "tick", step: 1 });
  await act({ id: "A1", op: "tick", step: 2 });
  await act({ id: "A1", op: "untick", step: 2 }); // a slip
  ok(await states("A1") === "done,todo,todo" && !lines().length, "a tick waits a moment before the agent hears it");
  await wait(WAIT + 900);
  let ls = lines();
  ok(ls.length === 1 && commits() === c0 + 1, "three clicks → one line, one commit");
  const l1 = ls[0];
  ok(l1?.kind === "action" && l1.id === "A1" && l1.page === "artipeek:actions" && l1.by === "user@example.com"
    && /^ACTION: A1 "Run the invoice backfill on db-server": step 1 done by the person \(1 of 3 steps done\)\. Verify .*artipeek-decide action show A1$/.test(l1.text), "the line: kind action, ACTION: text (the slip never reached the agent)");
  ok(Object.keys(l1).sort().join(",") === "at,by,id,kind,page,text,uid" && /^[0-9a-f]{12}$/.test(l1.uid), "…the answers line keeps its shape (at, uid, id, text, by, page, kind)");
  ok(git(one, "log", "-1", "--format=%an").stdout.toString().trim() === "artipeek", "…committed by artipeek");
  ok(await states("A1") === "checking,todo,todo", "the ticked step is now checking");
  ok((await api("GET", "/api/answers/one")).j.answers.some((x: any) => x.kind === "action" && x.decisionId === "A1" && x.text.startsWith("ACTION:")), "API: /api/answers lists it (kind action)");
  await act({ id: "A1", op: "untick", step: 1 });
  await wait(WAIT + 900);
  ok(lines().at(-1)?.text.includes("step 1 unticked (not done after all)") && await states("A1") === "todo,todo,todo", "unticking a step the agent is checking: the agent hears it");
  await act({ id: "A1", op: "tick", step: 1 });

  // ----- the agent checks -----
  ok((await api("PATCH", "/api/actions/one/A1/steps/1", { state: "verified", note: "login seen in auth.log" })).status === 200, "the agent marks step 1 verified");
  ok((await act({ id: "A1", op: "untick", step: 1 })).status === 409, "a verified step can't be unticked");
  r = await act({ id: "A1", op: "all", note: "ran it at 22:10" });
  ok(r.status === 200 && r.j.status === "checking", "\"I've done all the steps\" → checking");
  await wait(400);
  ok(/steps 2, 3 done by the person; note: ran it at 22:10 \(all 3 steps done\)/.test(lines().at(-1)?.text ?? ""), "…goes out at once: steps 2, 3, the note, all done");
  ok((await api("PATCH", "/api/actions/one/A1", { status: "done" })).j.error?.includes("steps 2, 3 not verified"), "the agent can't close it before every step is verified or skipped");
  await api("PATCH", "/api/actions/one/A1/steps/2", { state: "verified", note: "12,400 rows updated" });
  let c = decide("action", "step", "A1", "3", "skipped", "no access to #ops");
  ok(c.exitCode === 0 && c.stdout.toString().includes("A1 step 3: skipped"), "artipeek-decide action step … skipped");
  c = decide("action", "done", "A1", "relayed to D317");
  ok(c.exitCode === 0 && (await get("A1")).status === "done" && (await get("A1")).resolution === "relayed to D317", "artipeek-decide action done → done, with the note");
  ok((await act({ id: "A1", op: "tick", step: 1 })).status === 409, "a done action takes no ticks");
  h = await page("/actions/part/card/one/A1");
  ok(h.includes("✓ Verified") && h.includes("12,400 rows updated") && h.includes("Verify skipped") && h.includes("relayed to D317"), "the card shows verified, verify skipped, the agent's note");

  // ----- ask the agent to do it -----
  r = await api("POST", "/api/actions/one", { title: "Reconnect TikTok ads", from: ["D317"], steps: ["Open the TikTok business centre", "Reconnect the ad account"] });
  const A2 = r.j.id;
  r = await act({ id: A2, op: "agent", note: "use the shared login" });
  ok(r.j.status === "agent", "ask the agent → status agent");
  await wait(400);
  ok(lines().at(-1)?.text === `ACTION: ${A2} "Reconnect TikTok ads": do it for me (note: use the shared login) (0 of 2 steps done). Try it yourself; mark each step verified (or skipped), then the action done or hand it back: artipeek-decide action show ${A2}`, "…the agent hears it at once: do it for me (note)");
  ok((await page(`/actions/part/card/one/${A2}`)).includes("You asked the agent to do it"), "…the card says so");
  ok((await api("PATCH", `/api/actions/one/${A2}`, { status: "open" })).status === 400, "handing back needs a reason");
  c = decide("action", "handback", A2, "needs your 2FA code");
  ok(c.exitCode === 0 && (await get(A2)).status === "open" && (await get(A2)).resolution === "needs your 2FA code", "artipeek-decide action handback → back to the person, with why");
  r = await api("POST", "/api/actions/one", { title: "Moot", steps: ["x"] });
  ok(decide("action", "withdraw", r.j.id, "not needed").exitCode === 0 && (await get(r.j.id)).status === "withdrawn", "withdraw");
  c = decide("actions");
  ok(c.exitCode === 0 && c.stdout.toString().includes(`${A2}    open      0/2`) && !c.stdout.toString().includes("A1 "), "artipeek-decide actions lists the live ones");
  ok(decide("action", "show", A2).stdout.toString().includes("[ ] 1. Open the TikTok business centre"), "artipeek-decide action show");

  // ----- steps can change, ticked ones can't -----
  await act({ id: A2, op: "tick", step: 1 });
  ok((await api("PATCH", `/api/actions/one/${A2}`, { steps: ["Something else", "Reconnect the ad account"] })).status === 400, "a ticked step's text can't change");
  ok((await api("PATCH", `/api/actions/one/${A2}`, { steps: ["Open the TikTok business centre", "Reconnect the ad account", { text: "Check spend shows up", command: "tiktok-cli spend --today" }] })).status === 200
    && await states(A2) === "done,todo,todo", "adding a step keeps the others' states");
  ok((await api("PATCH", `/api/actions/one/${A2}`, { steps: ["Open the TikTok business centre"] })).status === 200, "…a step not ticked can be dropped");

  // ----- ticks survive a restart -----
  srv!.kill(); await wait(300);
  const before = lines().length;
  await start();
  await wait(WAIT + 900);
  ok(lines().length === before + 1 && lines().at(-1)?.text.includes(`${A2} "Reconnect TikTok ads": step 1 done by the person`), "a tick still waiting at a restart goes out after it");

  // ----- a folder with a token, no answers file -----
  r = await api("POST", "/api/actions/two", { title: "Two's action", steps: ["only step"] }, TOK.two);
  await act({ id: r.j.id, op: "tick", step: 1 }, { folder: "two" });
  await wait(400); // the last step: at once
  ok(!existsSync(join(two, "inbox")) && (await api("GET", "/api/answers/two", undefined, TOK.two)).j.answers.some((x: any) => x.kind === "action"), "a folder without an answers file: in the hub only");

  // ----- in the browser -----
  const id3 = (await api("POST", "/api/actions/one", { title: "Rotate the API key", steps: [{ text: "Make a new key", command: "erp key new" }, "Put it in the vault", "Delete the old key"] })).j.id;
  const id4 = (await api("POST", "/api/actions/one", { title: "Call the bank", steps: ["Call", "Write down the case number"] })).j.id;
  const p = await br.newPage();
  await p.setExtraHTTPHeaders({ "Cf-Access-Jwt-Assertion": jwt });
  await p.setViewport({ width: 1200, height: 900 });
  const errs: string[] = [];
  p.on("pageerror", (x) => errs.push(String(x)));
  await p.goto(`${B}/actions`);
  const card = (id: string) => `.pane:not([hidden]) .dc[data-k="one/${id}"]`;
  ok(!!(await p.$(card(id3))) && !!(await p.$(card(id4))) && !(await p.$(card("A1"))), "the Actions tab: To do lists the open ones");
  ok(await p.$eval(`${card(id3)} .acmd pre`, (x) => (x as HTMLElement).innerText) === "erp key new" && !!(await p.$(`${card(id3)} .acmd [data-copy]`)), "a command has a Copy button");
  await p.click(`${card(id3)} [data-tick="1"]`); await wait(300);
  ok(await p.$eval(`${card(id3)} [data-tick="1"]`, (x) => x.getAttribute("aria-checked")) === "true" && (await p.$eval(`${card(id3)} .as[data-n="1"]`, (x) => x.textContent ?? "")).includes("in a moment"), "a click ticks the step: it waits a moment");
  await wait(WAIT + 900);
  ok((await p.$eval(`${card(id3)} .as[data-n="1"]`, (x) => x.className)).includes("as-checking"), "…then, live, the agent is checking it");
  await api("PATCH", `/api/actions/one/${id3}/steps/1`, { state: "verified", note: "new key in the log" });
  await wait(700);
  ok((await p.$eval(`${card(id3)} .as[data-n="1"]`, (x) => x.textContent ?? "")).includes("Verified") && await p.$eval(`${card(id3)} [data-tick="1"]`, (x) => (x as HTMLButtonElement).disabled), "the agent verifies it: the page updates live, the box is locked");
  await p.type(`${card(id3)} .dnote-in`, "done from my phone");
  await p.click(`${card(id3)} [data-all]`); await wait(300);
  ok((await p.$eval(".answersheet .q", (x) => x.textContent ?? "")) === "Mark every step done?" && (await p.$eval(".answersheet .atext", (x) => x.textContent ?? "")).includes("2. Put it in the vault"), "\"I've done all the steps\" → artipeek's sheet lists what's left");
  await p.evaluate(() => (document.querySelector(".answersheet .asend") as HTMLButtonElement).dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await wait(400);
  ok(await states(id3) === "verified,todo,todo", "a click made by a script (not trusted) sends nothing");
  await p.click(".answersheet .asend"); await wait(1500);
  ok(await states(id3) === "verified,checking,checking" && (await get(id3)).status === "checking", "a real click on Send: all done, the agent checks them");
  ok(lines().at(-1)?.text.includes("steps 2, 3 done by the person; note: done from my phone"), "…the agent hears it");
  await p.click(`${card(id4)} [data-agent]`); await wait(300);
  await p.click(".answersheet .asend"); await wait(1500);
  ok((await get(id4)).status === "agent" && (await p.$eval(card(id4), (x) => x.textContent ?? "")).includes("You asked the agent to do it"), "Ask the agent to do it: the card says so");
  // the Decisions tab and the Actions tab side by side; links between them
  await p.click("#tree a.navdec:not(.navact)"); await wait(800);
  ok(new URL(p.url()).pathname === "/decisions" && (await p.$$("#tabs .tab")).length === 2, "Decisions opens as its own tab next to Actions");
  await p.click('.pane:not([hidden]) .dc[data-k="one/D317"] a.xref[href="/actions#a:one:A1"]'); await wait(1000);
  ok(new URL(p.url()).pathname === "/actions" && !!(await p.$('.peek .dc[data-k="one/A1"]')), "D317's link to A1 opens the Actions tab and shows A1 on top (it's done, not in To do)");
  await p.click(".peek .pclose");
  await p.click(`${card(id4)} [data-tick="1"]`); await wait(300);
  ok(await p.$eval("#tree a.navact", (x) => x.classList.contains("current")) && (await p.$eval("#tree a.navact .nd-agent", (x) => x.textContent ?? "")) !== "", "the file list marks Actions, with a count of what's with the agent");
  await p.reload(); await wait(800);
  ok((await p.$$("#tabs .tab")).length === 2 && new URL(p.url()).pathname === "/actions", "both tabs survive a reload");
  // a phone
  await p.setViewport({ width: 390, height: 800 });
  await p.goto(`${B}/r/one/actions`); await wait(600);
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "on a phone the page doesn't scroll sideways");
  ok(!errs.length, `no page errors${errs.length ? ": " + errs.join(" | ") : ""}`);
} catch (e) {
  console.log("FAIL", e); fails++;
} finally {
  await br.close(); srv!.kill(); certs.kill();
  await wait(200);
  ok(/^artipeek: action A1 saved in one by user@example\.com, committed$/m.test(out), "the journal line for an action (desks' watchers that match 'answer' lines skip it)");
  ok(!/^artipeek: answer A\d+ /m.test(out), "…never an 'answer' line for an action");
  rmSync(T, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
