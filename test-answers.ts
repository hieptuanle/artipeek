#!/usr/bin/env bun
// Answer buttons in a real browser: a page asks, artipeek's own sheet confirms, Send saves one line. Temp folders,
// its own server and fake Cloudflare Access certs (test-access.ts). Never touches real repos.
//   bun run test:answers     (needs Chromium; set CHROME_PATH if it isn't at /usr/bin/chromium)
import puppeteer from "puppeteer-core";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = Number(process.env.TEST_PORT ?? 4388), PUB = MAIN + 1, CERTS = MAIN + 2;
const B = `http://127.0.0.1:${PUB}`;
for (const port of [MAIN, PUB, CERTS])
  if (await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)) { console.log(`FAIL port ${port} is already in use`); process.exit(1); }

const T = mkdtempSync(join(tmpdir(), "artipeek-answers-"));
const one = join(T, "one"), tok = join(T, "tok");
mkdirSync(one); mkdirSync(tok);
// A decisions-style page: fixed choices, a free-text answer, and a script that tries to send an answer by itself.
writeFileSync(join(one, "decisions.html"), `<!doctype html><html><body>
<h1>Decisions</h1>
<button id="a" data-artipeek-answer="D15" data-value="A">D15 A</button>
<button id="b" data-artipeek-answer="D15" data-value="B" data-input="#note">D15 B with note</button>
<input id="note" value="only for E28">
<textarea id="own"></textarea><button id="send-own" data-artipeek-answer="D16" data-input="#own">Send my answer</button>
<div style="height:3000px"></div><p id="end">end</p>
<script>
document.addEventListener("artipeek:answer-saved", function (e) { document.body.setAttribute("data-saved", e.detail.id + "|" + e.detail.text); });
setTimeout(function () { parent.postMessage({ artipeek: "answer", id: "D99", text: "sent by the page itself" }, location.origin); }, 200);
</script></body></html>`);
Bun.spawnSync(["git", "-C", one, "init", "-q"]);
const certs = Bun.spawn(["bun", "test-access.ts", String(CERTS), tok], { cwd: import.meta.dir, stdout: "ignore", stderr: "ignore" });
for (let i = 0; i < 100 && !existsSync(join(tok, "ready")); i++) await Bun.sleep(100);
writeFileSync(join(T, "c.json"), JSON.stringify({
  roots: [{ name: "one", path: one, answers: { file: "inbox/answers.jsonl", message: "answer {id}" } }],
  public: { port: PUB, teamDomain: "test.cloudflareaccess.com", aud: "test-aud", emails: ["user@example.com"], roots: ["one"], certsUrl: `http://127.0.0.1:${CERTS}/cdn-cgi/access/certs` },
}));
const srv = Bun.spawn(["bun", "server.ts", "--config", join(T, "c.json"), "--port", String(MAIN)], { cwd: import.meta.dir, stdout: "ignore", stderr: "ignore" });
for (let i = 0; i < 50 && !(await fetch(B).then(() => true, () => false)); i++) await Bun.sleep(100);

const br = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
let fails = 0;
const ok = (c: any, m: string) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails++; };
const lines = () => { const f = join(one, "inbox/answers.jsonl"); return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []; };
const wait = (ms = 300) => Bun.sleep(ms);
try {
  const p = await br.newPage();
  await p.setExtraHTTPHeaders({ "Cf-Access-Jwt-Assertion": readFileSync(join(tok, "valid.jwt"), "utf8") });
  await p.setViewport({ width: 390, height: 800, isMobile: true, hasTouch: true });
  const errs: string[] = []; p.on("pageerror", (e) => errs.push(String(e)));
  await p.goto(B + "/r/one/view/decisions.html"); await wait(800);
  const sheet = () => p.evaluate(() => { const s = document.querySelector(".answersheet"); return s ? { id: s.querySelector(".aid")!.textContent, text: s.querySelector(".atext")!.textContent, msg: s.querySelector(".amsg")!.textContent } : null; });
  const frame = () => p.frames().filter((f) => f.url().includes("/raw/decisions.html") && !(f as any).detached).pop()!;
  // Change the file on disk and wait for artipeek's live reload to swap in a new frame.
  const reload = async () => {
    const before = frame().url();
    const f = join(one, "decisions.html"); writeFileSync(f, readFileSync(f, "utf8") + "\n<!-- edit " + Date.now() + " -->");
    for (let i = 0; i < 60 && frame()?.url() === before; i++) await Bun.sleep(100);
    await wait(800);
    // The page asks for D99 by itself on every load: the sheet opens again, still nothing is saved without Send.
    const st = await sheet();
    if (st?.id === "D99") await p.click(".answersheet .acancel");
    await wait();
    return frame().url() !== before && st?.id === "D99";
  };

  // The page's own script asked by itself: the sheet shows it, but nothing is saved without Send.
  let s = await sheet();
  ok(s?.id === "D99" && s?.text === "sent by the page itself", "a page's own message only opens the sheet: " + JSON.stringify(s));
  ok(lines().length === 0, "nothing saved before Send");
  await p.click(".answersheet .acancel"); await wait();
  ok(!(await sheet()) && lines().length === 0, "Cancel closes the sheet, nothing saved");

  // A fixed choice.
  await frame().click("#a"); await wait();
  s = await sheet(); ok(s?.id === "D15" && s?.text === "A", "click on a choice opens the sheet with the exact text");
  ok(lines().length === 0, "still nothing saved");
  await p.click(".answersheet .asend"); await wait(1000);
  let L = lines();
  ok(L.length === 1 && L[0].id === "D15" && L[0].text === "A" && L[0].by === "user@example.com" && L[0].page === "decisions.html", "Send saves one line: " + JSON.stringify(L[0]));
  ok(await frame().evaluate(() => document.body.getAttribute("data-saved") === "D15|A" && document.getElementById("a")!.getAttribute("data-artipeek-state") === "saved"), "the page hears it was saved");
  await wait(1200); ok(!(await sheet()), "sheet closes by itself after saving");
  const log = Bun.spawnSync(["git", "-C", one, "log", "--format=%an|%s"]).stdout.toString().trim();
  ok(log === "artipeek|answer D15", "committed as artipeek: " + log);

  // A live reload (the file changed) keeps what was sent, what was typed, and the scroll.
  await frame().type("#own", "half typed"); await frame().evaluate(() => scrollTo(0, 1200)); await wait(700);
  ok(await reload(), "file change reloads the frame");
  const kept = await frame().evaluate(() => ({ chosen: document.getElementById("a")!.getAttribute("data-artipeek-chosen"), state: document.getElementById("b")!.getAttribute("data-artipeek-state"), saved: document.body.getAttribute("data-saved"), own: (document.getElementById("own") as HTMLTextAreaElement).value, y: scrollY }));
  ok(kept.chosen === "true" && kept.state === "saved" && kept.saved === "D15|A", "after reload: the sent answer is marked again " + JSON.stringify(kept));
  ok(kept.own === "half typed", "after reload: typed text is back");
  ok(Math.abs(kept.y - 1200) < 5, "after reload: scroll is back (y=" + kept.y + ")");
  await frame().evaluate(() => { (document.getElementById("own") as HTMLTextAreaElement).value = ""; document.getElementById("own")!.dispatchEvent(new Event("input", { bubbles: true })); });
  await wait(500);

  // A choice plus a note, and free text.
  await frame().click("#b"); await wait();
  s = await sheet(); ok(s?.text === "B: only for E28", "choice + note joined: " + s?.text);
  await p.click(".answersheet .asend"); await wait(1800);
  ok((await frame().evaluate(() => (document.getElementById("note") as HTMLInputElement).value)) === "", "the note box empties after its answer is saved");
  await frame().type("#own", "Hold it until Monday"); await frame().click("#send-own"); await wait();
  s = await sheet(); ok(s?.id === "D16" && s?.text === "Hold it until Monday", "free text answer");
  await p.click(".answersheet .asend"); await wait(1000);
  L = lines(); ok(L.length === 3 && L[1].text === "B: only for E28" && L[2].id === "D16", "three lines in order");
  await wait(1500); ok(await reload(), "second reload");
  const k2 = await frame().evaluate(() => ({ a: document.getElementById("a")!.getAttribute("data-artipeek-chosen"), b: document.getElementById("b")!.getAttribute("data-artipeek-chosen"), own: (document.getElementById("own") as HTMLTextAreaElement).value, sent: document.getElementById("send-own")!.getAttribute("data-artipeek-state") }));
  ok(k2.b === "true" && k2.a === null && k2.sent === "saved" && k2.own === "", "after reload: the latest answer per item is marked, sent text not put back " + JSON.stringify(k2));

  // An empty free-text answer never opens the sheet.
  await wait(1500); await frame().evaluate(() => { (document.getElementById("own") as HTMLTextAreaElement).value = ""; });
  await frame().click("#send-own"); await wait();
  ok(!(await sheet()) && (await frame().evaluate(() => document.getElementById("send-own")!.getAttribute("data-artipeek-state"))) === "empty", "empty answer: no sheet, button marked empty");
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "phone: no sideways page scroll");
  ok(errs.length === 0, "no page errors " + errs.slice(0, 3).join(" | "));
} catch (e) {
  ok(false, "stopped early: " + e);
} finally {
  await br.close();
  srv.kill(); certs.kill();
  rmSync(T, { recursive: true, force: true });
}
console.log(fails ? `FAILS ${fails}` : "ALL OK");
process.exit(fails ? 1 : 0);
