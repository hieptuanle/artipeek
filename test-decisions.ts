#!/usr/bin/env bun
// Decision hub in a real browser: the agents' API (token), the page (outline, filters, links between decisions),
// live updates that patch cards in place without moving what you read, answers and explainer requests through
// artipeek's own sheet. Temp folders, its own server and fake Cloudflare Access certs. Never touches real repos.
//   bun run test:decisions     (needs Chromium; set CHROME_PATH if it isn't at /usr/bin/chromium)
import puppeteer, { type Page } from "puppeteer-core";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = Number(process.env.TEST_PORT ?? 4385), PUB = MAIN + 1, CERTS = MAIN + 2;
const B = `http://127.0.0.1:${PUB}`, L = `http://127.0.0.1:${MAIN}`;
for (const port of [MAIN, PUB, CERTS])
  if (await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)) { console.log(`FAIL port ${port} is already in use`); process.exit(1); }

const T = mkdtempSync(join(tmpdir(), "artipeek-decisions-"));
const one = join(T, "one"), two = join(T, "two"), secret = join(T, "secret"), tok = join(T, "tok");
for (const d of [one, two, secret, tok, join(one, "docs")]) mkdirSync(d, { recursive: true });
writeFileSync(join(one, "docs/d2.html"), `<!doctype html><html><body><h1 id="x">Explainer for D2</h1>
<button id="eb" data-artipeek-answer="D2" data-value="Q1 B">pick B here</button></body></html>`);
writeFileSync(join(one, "README.md"), "# one\n");
writeFileSync(join(two, "README.md"), "# two\n");
for (const d of [one, two]) { Bun.spawnSync(["git", "-C", d, "init", "-q"]); Bun.spawnSync(["git", "-C", d, "-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]); Bun.spawnSync(["git", "-C", d, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]); }
const certs = Bun.spawn(["bun", "test-access.ts", String(CERTS), tok], { cwd: import.meta.dir, stdout: "ignore", stderr: "ignore" });
for (let i = 0; i < 100 && !existsSync(join(tok, "ready")); i++) await Bun.sleep(100);
const cfgFile = join(T, "cfg", "config.json");
mkdirSync(join(T, "cfg"));
writeFileSync(cfgFile, JSON.stringify({
  roots: [{ name: "one", path: one, answers: { file: "inbox/answers.jsonl", message: "answer {id}" } }, { name: "two", path: two }, { name: "secret", path: secret }],
  public: { port: PUB, teamDomain: "test.cloudflareaccess.com", aud: "test-aud", emails: ["user@example.com"], roots: ["one", "two"], certsUrl: `http://127.0.0.1:${CERTS}/cdn-cgi/access/certs` },
}));
const env = { ...process.env, ARTIPEEK_CONFIG: cfgFile, ARTIPEEK_NO_RESTART: "1" };
const tokOf = (name: string) => /apk_[A-Za-z0-9_-]+/.exec(Bun.spawnSync(["bun", "cli.ts", "decisions", "token", name], { cwd: import.meta.dir, env }).stdout.toString())![0];
const TOK = { one: tokOf("one"), two: tokOf("two"), secret: tokOf("secret") };
const srv = Bun.spawn(["bun", "server.ts", "--config", cfgFile, "--port", String(MAIN)], { cwd: import.meta.dir, stdout: "pipe", stderr: "inherit" });
for (let i = 0; i < 50 && !(await fetch(B).then(() => true, () => false)); i++) await Bun.sleep(100);

let fails = 0;
const ok = (c: unknown, m: string) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails++; };
const api = async (method: string, p: string, body?: unknown, token = TOK.one) => {
  const r = await fetch(L + p, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, j: await r.json().catch(() => ({})) as any };
};
const lines = () => { const f = join(one, "inbox/answers.jsonl"); return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []; };
const wait = (ms = 300) => Bun.sleep(ms);
const long = (n: number) => Array.from({ length: n }, (_, i) => `- line ${i + 1} of a long context that takes room on the page`).join("\n");
const hour = 3600_000;

const br = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
try {
  // ----- API -----
  let r = await api("POST", "/api/decisions/one", { id: "D1", title: "Merge PR #1?", context: long(30), questions: [{ options: [{ value: "A", label: "merge", recommended: true }, { value: "B", label: "not yet" }] }] });
  ok(r.status === 201 && r.j.id === "D1", "API: create with a token");
  r = await api("POST", "/api/decisions/one", { title: "Delete the old route?", from: ["D1"], deadline: new Date(Date.now() + 5 * hour).toISOString(), explainerPath: "docs/d2.html", context: long(30),
    questions: [{ key: "Q1", text: "Delete it?", options: [{ value: "A", label: "delete now", recommended: true }, { value: "B", label: "keep it" }] }, { key: "Q2", text: "Tell staff?", options: [{ value: "A", label: "yes" }, { value: "B", label: "no" }] }] });
  ok(r.j.id === "D2", "API: next free id when none is given");
  await api("POST", "/api/decisions/one", { title: "Alerts for the database?", urgent: true, dependsOn: ["D2"], context: long(30), questions: [{ options: [{ value: "Y", label: "yes" }, { value: "N", label: "no" }] }] });
  await api("POST", "/api/decisions/one", { title: "Later one", status: "later", questions: [] });
  await api("POST", "/api/decisions/two", { title: "Two's question", context: long(10), deadline: new Date(Date.now() + 72 * hour).toISOString(), from: ["one:D1"], questions: [{ options: [{ value: "A", label: "a" }] }] }, TOK.two);
  ok((await api("POST", "/api/decisions/two", { title: "x" })).status === 401, "API: another project's token is refused");
  await api("POST", "/api/decisions/secret", { title: "Private follow-up", from: ["one:D1"] }, TOK.secret);
  const jwt = readFileSync(join(tok, "valid.jwt"), "utf8");
  const pubHtml = await (await fetch(`${B}/r/one/decisions`, { headers: { "Cf-Access-Jwt-Assertion": jwt } })).text();
  const locHtml = await (await fetch(`${L}/r/one/decisions`)).text();
  ok(!pubHtml.includes("Private follow-up") && !pubHtml.includes("secret:D1") && locHtml.includes("secret:D1"), "a folder that isn't public: its links (and titles) don't show on the public listener");
  ok((await api("POST", "/api/decisions/one", { title: "x" }, "apk_wrong")).status === 401, "API: a wrong token is refused");
  ok((await fetch(`${B}/api/decisions/one`, { headers: { "Cf-Access-Jwt-Assertion": readFileSync(join(tok, "valid.jwt"), "utf8"), Authorization: `Bearer ${TOK.one}` } })).status === 404, "API: not on the public listener");
  ok((await api("POST", "/api/decisions/one", { title: "x", questions: [{ options: [{ value: "A", label: "<b>x</b>" }] }], links: [{ href: "javascript:alert(1)" }] })).status === 400, "API: a javascript: link is refused");
  ok((await api("PATCH", "/api/decisions/one/D9", { title: "x" })).status === 400, "API: updating a missing id says so");
  const agentAns = await fetch(`${L}/r/one/answer`, { method: "POST", headers: { "Content-Type": "application/json", "X-Artipeek": "answer", "Sec-Fetch-Site": "same-origin" }, body: JSON.stringify({ id: "D1", text: "A" }) });
  ok(agentAns.status === 403, "an agent on 127.0.0.1 can't answer");

  // ----- the page -----
  const p = await br.newPage();
  await p.setExtraHTTPHeaders({ "Cf-Access-Jwt-Assertion": readFileSync(join(tok, "valid.jwt"), "utf8") });
  await p.setViewport({ width: 1200, height: 800 });
  const errs: string[] = []; p.on("pageerror", (e) => errs.push(String(e))); p.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  await p.goto(B + "/r/one/decisions"); await wait(600);
  await p.evaluate(() => { (window as any).__same = 1; }); // gone if the page reloads
  const info = () => p.evaluate(() => ({
    cards: [...document.querySelectorAll("#dlist .dc:not([hidden])")].map((c) => (c as HTMLElement).dataset.id),
    urgent: [...document.querySelectorAll("#dlist .dc.urgent")].map((c) => (c as HTMLElement).dataset.id),
    outline: [...document.querySelectorAll("#olist .oi:not([hidden])")].map((c) => (c as HTMLElement).dataset.k),
    ourg: [...document.querySelectorAll("#olist .oi.urgent")].map((c) => (c as HTMLElement).dataset.k),
    same: (window as any).__same === 1,
  }));
  let s = await info();
  ok(JSON.stringify(s.cards) === '["D1","D2","D3"]', `open decisions, oldest first (${s.cards})`);
  ok(JSON.stringify(s.urgent) === '["D2","D3"]' && s.ourg.length === 2, "urgent: the flag, or a deadline under 24 h; highlighted in the outline too");
  ok(s.outline.length === 3, "outline lists each decision");
  ok(await p.$eval("#d\\:one\\:D2 .drel", (e) => e.textContent!.includes("From") && e.textContent!.includes("D1") && e.textContent!.includes("Needed by")), "links: 'From D1' and 'Needed by D3' on D2");
  ok(await p.$eval("#d\\:one\\:D1 .drel", (e) => e.textContent!.includes("Led to") && e.textContent!.includes("two:D1")), "links: 'Led to' shows a decision in another project");

  // outline click scrolls to the card, under the top bar
  await p.click('#olist .oi[data-k="one/D3"] a'); await wait(900);
  const topOf = (sel: string) => p.$eval(sel, (e) => e.getBoundingClientRect().top - document.getElementById("dtop")!.getBoundingClientRect().bottom);
  let d = await topOf("#d\\:one\\:D3");
  ok(d > -2 && d < 30, `outline click scrolls to that decision (${Math.round(d)} px under the bar)`);
  await p.click('#d\\:one\\:D3 a.ref[data-ref="one/D2"]'); await wait(900);
  d = await topOf("#d\\:one\\:D2");
  ok(d > -2 && d < 30, "a 'Depends on D2' link scrolls to D2");

  // urgent filter
  await p.click("button[data-urgent]"); await wait(200);
  s = await info();
  ok(JSON.stringify(s.cards) === '["D2","D3"]' && s.outline.length === 2, "urgent filter shows only urgent ones");
  ok(await p.$eval('[data-count="urgent"]', (e) => e.textContent) === "2", "urgent count");
  await p.click("button[data-urgent]"); await wait(200);

  // ----- live update keeps your place -----
  // Read the middle of D2's context; then an agent adds a long update to D1 (above) and changes D2's title.
  await p.evaluate(() => { const li = document.querySelectorAll("#d\\:one\\:D2 .dctx li")[12] as HTMLElement; scrollBy(0, li.getBoundingClientRect().top - document.getElementById("dtop")!.getBoundingClientRect().bottom - 3); });
  await wait(300);
  const probe = () => p.evaluate(() => { const li = document.querySelectorAll("#d\\:one\\:D2 .dctx li")[12] as HTMLElement; return { y: li.getBoundingClientRect().top, t: li.textContent }; });
  const before = await probe();
  await api("POST", "/api/decisions/one/D1/notes", { body: long(25) });
  await api("PATCH", "/api/decisions/one/D2", { title: "Delete the old route now?" });
  await wait(1200);
  let after = await probe();
  s = await info();
  ok(s.same, "no page reload");
  ok(await p.$eval("#d\\:one\\:D2 .dt", (e) => e.textContent) === "Delete the old route now?", "live: the changed title shows");
  ok(await p.$$eval("#d\\:one\\:D1 .dn", (e) => e.length) === 1, "live: the new update shows on D1");
  ok(Math.abs(after.y - before.y) <= 2 && after.t === before.t, `what you read stays put (moved ${Math.round(after.y - before.y)} px)`);
  // a new decision raised meanwhile: appended in order, still no move
  const b2 = await probe();
  await api("POST", "/api/decisions/one", { title: "A brand new one", context: long(20), questions: [{ options: [{ value: "A", label: "ok" }] }] });
  await wait(1200);
  after = await probe(); s = await info();
  ok(JSON.stringify(s.cards) === '["D1","D2","D3","D5"]' && s.outline.includes("one/D5"), "live: a new decision appears at its place (and in the outline)");
  ok(Math.abs(after.y - b2.y) <= 2, `…without moving what you read (${Math.round(after.y - b2.y)} px)`);

  // a note being typed survives a live change of its own card, with the focus
  await p.click("#d\\:one\\:D3 textarea"); await p.type("#d\\:one\\:D3 textarea", "half a thought");
  await api("PATCH", "/api/decisions/one/D3", { context: long(31) });
  await wait(1200);
  ok(await p.$eval("#d\\:one\\:D3 textarea", (e) => (e as HTMLTextAreaElement).value) === "half a thought", "live: your typed note stays");
  ok(await p.evaluate(() => document.activeElement?.id === "n:one/D3"), "live: and keeps the focus");
  await p.$eval("#d\\:one\\:D3 textarea", (e) => { (e as HTMLTextAreaElement).value = ""; e.dispatchEvent(new Event("input", { bubbles: true })); });

  // ----- answers -----
  const sheet = () => p.evaluate(() => { const s = document.querySelector(".answersheet"); return s ? { id: s.querySelector(".aid")!.textContent, text: s.querySelector(".atext")!.textContent, msg: s.querySelector(".amsg")!.textContent } : null; });
  const sendSheet = async () => { await p.click(".answersheet .asend"); await wait(900); };
  // several questions: picks first, then one send
  await p.click('#d\\:one\\:D2 .opt[data-q="Q1"][data-v="A"]');
  await p.click('#d\\:one\\:D2 .opt[data-q="Q2"][data-v="B"]');
  ok(await p.$eval('#d\\:one\\:D2 .opt[data-q="Q1"][data-v="A"]', (e) => e.getAttribute("aria-pressed")) === "true", "a pick turns on");
  await api("POST", "/api/decisions/one/D2/notes", { body: "picks survive this" }); await wait(1000);
  ok(await p.$eval('#d\\:one\\:D2 .opt[data-q="Q2"][data-v="B"]', (e) => (e as HTMLElement).dataset.picked) === "true", "picks survive a live change");
  await p.type("#d\\:one\\:D2 textarea", "staff via MM");
  await p.click("#d\\:one\\:D2 [data-send]"); await wait(200);
  let sh = await sheet();
  ok(sh?.text === "Q1 A, Q2 B: staff via MM" && sh.id === "one · D2", `artipeek's sheet shows the exact text (${sh?.text})`);
  ok(lines().length === 0, "nothing is saved before Send");
  await sendSheet();
  let L1 = lines().pop();
  ok(L1?.id === "D2" && L1?.text === "Q1 A, Q2 B: staff via MM" && L1?.by === "user@example.com" && L1?.page === "artipeek:decisions", "Send saves one line in the folder's answers file");
  const log = Bun.spawnSync(["git", "-C", one, "log", "-1", "--format=%an %s"]).stdout.toString().trim();
  ok(log === "artipeek answer D2", `…and commits it (${log})`);
  r = await api("GET", "/api/decisions/one/D2");
  ok(r.j.decision.status === "answered" && r.j.decision.answers[0].text === "Q1 A, Q2 B: staff via MM", "the hub has the answer; the decision is answered");
  ok((await api("GET", "/api/answers/one")).j.answers.length === 1, "agents can read answers with the token");
  await wait(600);
  ok(await p.$eval("#d\\:one\\:D2", (e) => e.classList.contains("out") && !!e.querySelector(".dans")), "the answered card stays where it is (dimmed) with your answer");
  ok(await p.$eval("#d\\:one\\:D2 textarea", (e) => (e as HTMLTextAreaElement).value) === "", "the note box is emptied after Send");
  // a single question: a tap opens the sheet; Cancel saves nothing
  await p.click('#d\\:one\\:D1 .opt[data-v="A"]'); await wait(200);
  ok((await sheet())?.text === "A", "one question: a tap asks to send that choice");
  await p.click(".answersheet .acancel"); await wait(200);
  ok(lines().length === 1 && !(await sheet()), "Cancel saves nothing");

  // ----- explainer -----
  await p.click("#d\\:one\\:D1 [data-explain]"); await wait(200);
  sh = await sheet();
  ok(sh?.text?.startsWith("EXPLAIN:"), `Explain this asks with its own text (${sh?.text})`);
  await sendSheet();
  L1 = lines().pop();
  ok(L1?.kind === "explain" && L1?.text.startsWith("EXPLAIN:"), "the request goes to the desk like an answer, marked kind=explain");
  r = await api("GET", "/api/decisions/one/D1");
  ok(r.j.decision.status === "open" && r.j.decision.explainerRequestedAt, "the decision stays open, marked 'explainer asked for'");
  await wait(600);
  ok(await p.$eval("#d\\:one\\:D1 .dexpl", (e) => e.textContent!.includes("Explainer asked for")), "the card says the explainer is asked for");
  await api("PATCH", "/api/decisions/one/D1", { explainerPath: "docs/d2.html" }); await wait(1000);
  ok(await p.$("#d\\:one\\:D1 [data-xopen]"), "when the desk links the page, 'Open explainer' shows");
  const y0 = await p.evaluate(() => scrollY);
  await p.click("#d\\:one\\:D1 [data-xopen]"); await wait(800);
  const xf = p.frames().find((f) => f.url().includes("/raw/docs/d2.html"));
  ok(xf && (await xf.$eval("h1", (e) => e.textContent)) === "Explainer for D2", "the explainer opens over the list (sandboxed frame)");
  await xf!.click("#eb"); await wait(300);
  ok((await sheet())?.text === "Q1 B" && (await sheet())?.id === "one · D2", "an answer button inside the explainer opens artipeek's sheet");
  await p.click(".answersheet .acancel"); await p.click(".xview .xclose"); await wait(200);
  ok(await p.evaluate(() => scrollY) === y0, "closing the explainer leaves the list where it was");

  // ----- filters and peek -----
  await p.click('button[data-status="answered"]'); await wait(600);
  s = await info();
  ok(JSON.stringify(s.cards) === '["D2"]', "status filter: answered");
  await p.click('#d\\:one\\:D2 a.ref[data-ref="one/D1"]'); await wait(600);
  ok(await p.$eval(".peek .dt", (e) => e.textContent) === "Merge PR #1?", "a link to a decision outside the filter opens it on top");
  await p.click(".peek .pclose");

  // ----- all projects -----
  await p.goto(B + "/decisions"); await wait(600);
  s = await info();
  ok(s.cards.includes("D1") && (await p.$$eval("#dlist .dc .pj", (e) => e.map((x) => x.textContent))).includes("two"), "all projects: every project's open decisions, with a project tag");
  await p.click('.pjs button[data-project="two"]'); await wait(200);
  s = await info();
  ok(JSON.stringify(s.cards) === '["D1"]' && (await p.$eval("#dlist .dc:not([hidden])", (e) => (e as HTMLElement).dataset.project)) === "two", "project filter");
  await api("POST", "/api/decisions/two", { title: "Raised while filtered", questions: [] }, TOK.two); await wait(1200);
  ok((await info()).cards.length === 2, "live on the all-projects page too");

  // ----- phone -----
  await p.setViewport({ width: 390, height: 800, isMobile: true, hasTouch: true });
  await p.goto(B + "/decisions"); await wait(600);
  ok(await p.$eval("#dout", (e) => e.getBoundingClientRect().left >= innerWidth - 1), "phone: the outline is a drawer, closed");
  await p.click(".obtn"); await wait(300);
  ok(await p.$eval("#dout", (e) => e.getBoundingClientRect().right <= innerWidth + 1), "phone: Outline opens it");
  await p.click('#olist .oi[data-k="one/D3"] a'); await wait(900);
  ok(!(await p.evaluate(() => document.body.classList.contains("outline-open"))), "phone: picking one closes the drawer");
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "phone: no sideways scroll");
  // phone: the top bar scrolls away; your place still holds when a card above grows
  await p.goto(B + "/r/one/decisions?status=all"); await wait(600);
  await p.evaluate(() => { const li = document.querySelectorAll("#d\\:one\\:D3 .dctx li")[20] as HTMLElement; scrollBy(0, li.getBoundingClientRect().top - 10); });
  await wait(300);
  const pp = () => p.evaluate(() => (document.querySelectorAll("#d\\:one\\:D3 .dctx li")[20] as HTMLElement).getBoundingClientRect().top);
  const pb = await pp();
  await api("POST", "/api/decisions/one/D1/notes", { body: long(15) }); await wait(1200);
  ok(Math.abs((await pp()) - pb) <= 2, `phone: what you read stays put (${Math.round((await pp()) - pb)} px)`);
  // another process writes the database (an import): the page catches up by itself
  const { openHub } = await import("./db/store.ts");
  const other = openHub(join(T, "cfg", "decisions.db"));
  other.create("one", { title: "Written by another process", questions: [] });
  await wait(2000);
  ok(await p.evaluate(() => [...document.querySelectorAll("#dlist .dt")].some((e) => e.textContent === "Written by another process")), "a write from another process shows up live");
  other.sqlite.close();

  // ----- old bookmark -----
  const red = await fetch(`${L}/r/one/view/decisions.html`, { redirect: "manual" });
  ok(red.status === 302 && red.headers.get("location")?.endsWith("/r/one/decisions"), "an old decisions.html link goes to the hub page");
  const red2 = await fetch(`${L}/r/one/view/docs/explainers/decisions.html`, { redirect: "manual" });
  ok(red2.status === 302 && red2.headers.get("location")?.endsWith("/r/one/decisions"), "…also one in a subfolder");
  ok((await fetch(`${L}/r/one/view/decisions.html?file=1`, { redirect: "manual" })).status !== 302, "?file=1 still opens the file");
  ok((Bun.spawnSync(["stat", "-c", "%a", join(T, "cfg", "decisions.db")]).stdout.toString().trim()) === "600", "the database file is private (600)");
  ok(!errs.length, `no page errors${errs.length ? ": " + errs.join(" | ") : ""}`);
} catch (e) {
  console.log("FAIL", e); fails++;
} finally {
  await br.close(); srv.kill(); certs.kill();
  // desks' watchers match this exact journal line; it must not change shape
  const out = await new Response(srv.stdout).text();
  ok(/^artipeek: answer D2 saved in one by user@example\.com, committed$/m.test(out), "the log line desks' watchers match keeps its shape");
  rmSync(T, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
