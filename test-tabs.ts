#!/usr/bin/env bun
// App tabs in a real browser: real clicks, temp folders, its own server. Never touches real repos.
//   bun run test:tabs        (needs Chromium; set CHROME_PATH if it isn't at /usr/bin/chromium)
import puppeteer from "puppeteer-core";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.TEST_PORT ?? 4398);
const B = `http://127.0.0.1:${PORT}`;
// A server left on this port would answer instead of ours, with other files: stop here, not with odd failures.
if (await fetch(B).then(() => true, () => false)) { console.log(`FAIL port ${PORT} is already in use`); process.exit(1); }

const T = mkdtempSync(join(tmpdir(), "artipeek-tabs-"));
const one = join(T, "one"), two = join(T, "two");
mkdirSync(join(one, "a"), { recursive: true }); mkdirSync(join(one, "b"), { recursive: true }); mkdirSync(two);
const long = Array.from({ length: 200 }, (_, i) => `para ${i}\n`).join("\n");
writeFileSync(join(one, "a/first.md"), `# First\n\n[second](../b/second.md) [sec](../b/second.md#deep) [page](../b/page.html) [local](#end)\n\n${long}\n\n## end\n\nbottom\n`);
writeFileSync(join(one, "b/second.md"), `# Second\n\n${long}\n\n## deep\n\nx\n`);
writeFileSync(join(one, "b/README.md"), `# b readme\n`);
writeFileSync(join(one, "a/README.md"), `# a readme\n`);
writeFileSync(join(one, "b/page.html"), `<html><body style="height:5000px"><h1 id=h>Page</h1><a id=l href="second.md">rel</a><a id=l2 href="/r/one/view/a/README.md">abs</a><script>window.n=(window.n||0)+1;document.title='x';setTimeout(()=>{document.body.dataset.t=Date.now()},1)</script></body></html>`);
writeFileSync(join(two, "z.md"), `# In two\n`);
writeFileSync(join(T, "c.json"), JSON.stringify({ port: PORT, roots: [{ name: "one", path: one }, { name: "two", path: two }] }));
const srv = Bun.spawn(["bun", "server.ts", "--config", join(T, "c.json"), "--port", String(PORT)], { cwd: import.meta.dir, stdout: "ignore", stderr: "ignore" });
for (let i = 0; i < 50 && !(await fetch(B).then(() => true, () => false)); i++) await Bun.sleep(100);
const br = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
let fails = 0;
const ok = (c: any, m: string) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails++; };
try {
  const st = (p: any) => p.evaluate(() => ({
    tabs: [...document.querySelectorAll("#tabs .tab a")].map((a: any) => a.textContent),
    act: document.querySelector("#tabs .tab.active a")?.textContent,
    cur: [...document.querySelectorAll("#tree ul.tree a.current")].map((a: any) => a.dataset.path),
    panes: document.querySelectorAll(".pane").length,
    vis: document.querySelector(".pane:not([hidden]) .crumbs b")?.textContent,
    url: location.pathname + location.hash, y: scrollY, title: document.title, root: document.querySelector("details.roots summary")?.textContent,
  }));
  const wait = (ms = 250) => Bun.sleep(ms);
  const p = await br.newPage(); await p.setViewport({ width: 1200, height: 700 });
  const errs: string[] = []; p.on("pageerror", (e) => errs.push(String(e))); p.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  await p.goto(B + "/r/one/view/a/first.md"); await wait();
  let s = await st(p);
  ok(s.tabs.length === 1 && s.panes === 1 && (await p.$eval("#tabs", (e: any) => e.hidden)), "one tab: bar hidden");
  ok(s.cur[0] === "a/first.md", "sidebar highlight on load");
  await p.evaluate(() => scrollTo(0, 900)); 
  await p.evaluate(() => (document.querySelector('.markdown a[href$="b/second.md"]') as any).click()); await wait();
  s = await st(p);
  ok(s.tabs.length === 2 && s.act === "second.md" && s.vis === "second.md", "md link opens new tab and switches: " + JSON.stringify(s.tabs));
  ok(s.cur.length === 1 && s.cur[0] === "b/second.md", "sidebar highlight follows"); ok(s.url === "/r/one/view/b/second.md" && s.title.startsWith("b/second.md"), "url and title follow"); ok(s.y === 0, "new tab at top");
  // instant switch: no network
  let reqs = 0; const cnt = () => reqs++; p.on("request", cnt);
  await p.evaluate(() => (document.querySelectorAll("#tabs .tab a")[0] as any).click()); 
  s = await st(p); await wait();
  ok(s.vis === "first.md" && s.cur[0] === "a/first.md", "tab click switches synchronously, highlight follows");
  ok(reqs === 0, "no network on switch back, requests=" + reqs); ok(s.y === 900, "scroll restored y=" + s.y);
  p.off("request", cnt);
  // same link again = no duplicate; hash
  await p.evaluate(() => (document.querySelector('.pane:not([hidden]) .markdown a[href$="second.md#deep"]') as any).click()); await wait();
  s = await st(p); ok(s.tabs.length === 2 && s.vis === "second.md" && s.y > 1000 && s.url.endsWith("#deep"), "link with hash reuses tab, scrolls y=" + s.y);
  await p.evaluate(() => (document.querySelectorAll("#tabs .tab a")[0] as any).click()); await wait(50);
  await p.evaluate(() => (document.querySelector('.pane:not([hidden]) .markdown a[href="#end"]') as any).click()); await wait();
  s = await st(p); ok(s.tabs.length === 2 && s.url.endsWith("first.md#end") && s.y > 1000, "in-page anchor stays in tab y=" + s.y);
  // sidebar click
  await p.evaluate(() => (document.querySelector('#tree ul.tree a[data-path="a/README.md"]') as any).click()); await wait();
  await p.evaluate(() => (document.querySelector('#tree ul.tree a[data-path="b/README.md"]') as any).click()); await wait();
  s = await st(p); ok(s.tabs.length === 4 && s.tabs.includes("a/README.md") && s.tabs.includes("b/README.md"), "sidebar opens tabs; same names show folder " + JSON.stringify(s.tabs));
  // html page + frame link
  await p.evaluate(() => (document.querySelectorAll("#tabs .tab a")[0] as any).click()); await wait(50);
  await p.evaluate(() => (document.querySelector('.pane:not([hidden]) .markdown a[href$="page.html"]') as any).click()); await wait(600);
  s = await st(p); ok(s.vis === "page.html", "html tab");
  const fr = () => p.frames().find((f) => f.url().includes("/raw/b/page.html"))!;
  await fr().evaluate(() => { scrollTo(0, 700); (window as any).mark = 42; });
  await p.evaluate(() => (document.querySelectorAll("#tabs .tab a")[1] as any).click()); await wait(100);
  await p.evaluate(() => (document.querySelectorAll("#tabs .tab a")[4] as any).click()); await wait(100);
  const fs = await fr().evaluate(() => ({ y: scrollY, m: (window as any).mark }));
  ok(fs.m === 42, "iframe not reloaded on switch back"); ok(fs.y === 700, "iframe scroll kept y=" + fs.y);
  await fr().evaluate(() => (document.getElementById("l") as any).click()); await wait();
  s = await st(p); ok(s.vis === "second.md" && s.tabs.length === 5, "relative link in html page switches app tab");
  await p.evaluate(() => (document.querySelectorAll("#tabs .tab a")[4] as any).click()); await wait(100);
  await fr().evaluate(() => (document.getElementById("l2") as any).click()); await wait();
  s = await st(p); ok(s.url === "/r/one/view/a/README.md", "absolute view link in html page");
  // back
  await p.goBack(); await wait(); s = await st(p); ok(s.vis === "page.html" && s.tabs.length === 5, "Back returns to previous tab");
  await p.goForward(); await wait();
  // live updates in a hidden tab
  writeFileSync(join(one, "b/second.md"), `# Second changed\n`); await wait(1200);
  const hid = await p.evaluate(() => [...document.querySelectorAll(".pane")].some((x: any) => x.hidden && x.textContent.includes("Second changed")));
  ok(hid, "hidden tab live-updates");
  // close
  const before = (await st(p)).tabs.length;
  await p.evaluate(() => (document.querySelector("#tabs .tab.active button") as any).click()); await wait();
  s = await st(p); ok(s.tabs.length === before - 1 && s.panes === before - 1 && s.act && s.url.includes(s.vis!), "close active moves to neighbour: " + s.act);
  await p.evaluate(() => (document.querySelector("#tabs .tab:not(.active) button") as any).click()); await wait();
  s = await st(p); ok(s.tabs.length === before - 2, "close inactive");
  const left = s.tabs;
  // reload keeps list; contents prefetched
  await p.reload(); await wait(800); s = await st(p);
  ok(JSON.stringify(s.tabs) === JSON.stringify(left), "reload keeps list");
  ok(await p.evaluate(() => [...document.querySelectorAll(".pane")].every((x: any) => !x.textContent.includes("Loading"))), "reload refills every pane");
  // second folder
  await p.evaluate(() => (document.querySelector('details.roots a[href="/r/two/"]') as any).click()); await wait(500);
  s = await st(p); ok(s.vis === "z.md" && s.root === "two" && s.cur[0] === "z.md" && s.tabs.length === left.length + 1, "folder switch keeps tabs, swaps sidebar");
  await p.evaluate(() => (document.querySelectorAll("#tabs .tab a")[0] as any).click()); await wait(500);
  s = await st(p); ok(s.root === "one" && s.cur.length === 1, "tab of first folder swaps sidebar back " + s.cur);
  // independent browser tabs
  const q = await br.newPage(); await q.goto(B + "/r/one/view/a/first.md"); await wait();
  s = await st(q); ok(s.tabs.length === 1, "another browser tab has its own list");
  await q.evaluate(() => (document.querySelector('#tree ul.tree a[data-path="a/README.md"]') as any).click()); await wait();
  ok((await st(q)).tabs.length === 2 && (await st(p)).tabs.length === left.length + 1, "lists do not leak between browser tabs");
  await q.close();
  // phone
  await p.setViewport({ width: 390, height: 800, isMobile: true, hasTouch: true }); await wait(300);
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "phone: no sideways page scroll");
  await p.evaluate(() => { document.body.classList.add("nav-open"); (document.querySelector('#tree ul.tree a[data-path="a/first.md"]') as any).click(); }); await wait();
  ok(!(await p.evaluate(() => document.body.classList.contains("nav-open"))), "phone: drawer closes after link");
  await p.setViewport({ width: 1200, height: 700 }); await wait(200);
  ok(errs.length === 0, "no console errors " + errs.slice(0, 3).join(" | "));
} catch (e) {
  ok(false, "stopped early: " + e);
} finally {
  await br.close();
  srv.kill();
  rmSync(T, { recursive: true, force: true });
}
console.log(fails ? `FAILS ${fails}` : "ALL OK");
process.exit(fails ? 1 : 0);
