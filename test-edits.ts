#!/usr/bin/env bun
// Edit requests: the person edits a file on artipeek's edit view, artipeek hands the new text to the folder's agent (the
// hub + the answers file), and never writes the file itself. The agent reads it with the token API / artipeek-decide and
// closes it; the file's page shows the request live. Temp folders, its own server and fake Cloudflare Access certs.
//   bun run test:edits     (needs Chromium; set CHROME_PATH if it isn't at /usr/bin/chromium)
import puppeteer from "puppeteer-core";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const MAIN = Number(process.env.TEST_PORT ?? 4395), PUB = MAIN + 1, CERTS = MAIN + 2;
const B = `http://127.0.0.1:${PUB}`, L = `http://127.0.0.1:${MAIN}`;
for (const port of [MAIN, PUB, CERTS])
  if (await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)) { console.log(`FAIL port ${port} is already in use`); process.exit(1); }

const T = mkdtempSync(join(tmpdir(), "artipeek-edits-"));
const one = join(T, "one"), two = join(T, "two"), plain = join(T, "plain"), tok = join(T, "tok");
for (const d of [one, two, plain, tok]) mkdirSync(d, { recursive: true });
const NOTES = "# Notes\n\nline one\nline two\n";
writeFileSync(join(one, "notes.md"), NOTES);
writeFileSync(join(one, "other.md"), "# Other\n");
writeFileSync(join(one, "crlf.txt"), "a\r\nb\r\n");
writeFileSync(join(one, "blob.dat"), new Uint8Array([1, 0, 2, 0, 3]));
writeFileSync(join(two, "doc.md"), "# Doc\n");
writeFileSync(join(plain, "x.md"), "# x\n");
const git = (d: string, ...a: string[]) => Bun.spawnSync(["git", "-C", d, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdout: "pipe" });
for (const d of [one, two, plain]) { git(d, "init", "-q"); git(d, "add", "-A"); git(d, "commit", "-qm", "init"); }
const certs = Bun.spawn(["bun", "test-access.ts", String(CERTS), tok], { cwd: import.meta.dir, stdout: "ignore", stderr: "ignore" });
for (let i = 0; i < 100 && !existsSync(join(tok, "ready")); i++) await Bun.sleep(100);
const cfgFile = join(T, "cfg", "config.json");
mkdirSync(join(T, "cfg"));
writeFileSync(cfgFile, JSON.stringify({
  roots: [{ name: "one", path: one, answers: { file: "inbox/answers.jsonl", message: "answer {id}" } }, { name: "two", path: two }, { name: "plain", path: plain }],
  public: { port: PUB, teamDomain: "test.cloudflareaccess.com", aud: "test-aud", emails: ["user@example.com"], roots: ["one", "two", "plain"], certsUrl: `http://127.0.0.1:${CERTS}/cdn-cgi/access/certs` },
}));
const env = { ...process.env, ARTIPEEK_CONFIG: cfgFile, ARTIPEEK_NO_RESTART: "1" };
const tokOf = (name: string) => /apk_[A-Za-z0-9_-]+/.exec(Bun.spawnSync(["bun", "cli.ts", "decisions", "token", name], { cwd: import.meta.dir, env }).stdout.toString())![0];
const TOK = { one: tokOf("one"), two: tokOf("two") }; // plain: no token, no answers = no agent
const srv = Bun.spawn(["bun", "server.ts", "--config", cfgFile, "--port", String(MAIN)], { cwd: import.meta.dir, stdout: "pipe", stderr: "inherit" });
let out = "";
(async () => { const rd = srv.stdout.getReader(); for (;;) { const { value, done } = await rd.read(); if (done) break; out += new TextDecoder().decode(value); } })();
for (let i = 0; i < 50 && !(await fetch(B).then(() => true, () => false)); i++) await Bun.sleep(100);

let fails = 0;
const ok = (c: unknown, m: string) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails++; };
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const jwt = readFileSync(join(tok, "valid.jwt"), "utf8");
const wait = (ms = 300) => Bun.sleep(ms);
// POST /r/<folder>/edit as the person (public listener, logged in), unless told otherwise
async function edit(body: unknown, o: { folder?: string; base?: string; login?: boolean; site?: string; hdr?: string } = {}) {
  const r = await fetch(`${o.base ?? B}/r/${o.folder ?? "one"}/edit`, {
    method: "POST", body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", "X-Artipeek": o.hdr ?? "edit", "Sec-Fetch-Site": o.site ?? "same-origin", ...(o.login === false ? {} : { "Cf-Access-Jwt-Assertion": jwt }) },
  });
  return { status: r.status, j: (await r.json().catch(() => ({}))) as any };
}
const api = async (method: string, p: string, body?: unknown, token = TOK.one) => {
  const r = await fetch(L + p, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, j: (await r.json().catch(() => ({}))) as any };
};
const page = async (p: string, base = B) => (await fetch(base + p, { headers: base === B ? { "Cf-Access-Jwt-Assertion": jwt } : {} })).text();
const lines = () => { const f = join(one, "inbox/answers.jsonl"); return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []; };
const notes = () => readFileSync(join(one, "notes.md"), "utf8");
const decide = (...a: string[]) => Bun.spawnSync(["bun", "decide.ts", ...a, "--project", "one"], { cwd: import.meta.dir, env: { ...process.env, ARTIPEEK_URL: L, ARTIPEEK_TOKEN: TOK.one, HOME: T }, stdout: "pipe", stderr: "pipe" });

const br = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
try {
  // ----- who may send -----
  const v1 = { path: "notes.md", start: sha(NOTES), text: NOTES.replace("line two", "line two, changed"), note: "fix line two" };
  ok((await edit(v1, { base: L, login: false })).status === 403, "an agent on 127.0.0.1 can't send an edit");
  ok((await edit(v1, { hdr: "answer" })).status === 403, "without X-Artipeek: edit → refused");
  ok((await edit(v1, { site: "cross-site" })).status === 403, "a cross-site request → refused");
  ok((await edit({ ...v1, path: "x.md", start: sha("# x\n") }, { folder: "plain" })).status === 404, "a folder with no agent (no answers, no token) takes no edits");
  ok((await edit({ ...v1, path: "../two/doc.md" })).status === 404, "a path outside the folder → 404");
  ok((await edit({ path: "blob.dat", start: "", text: "x" })).j.error?.includes("can't be edited"), "a binary file can't be edited");
  ok(!(await page("/r/one/view/notes.md", L)).includes('class="editlink"') && (await page("/r/one/view/notes.md")).includes('class="editlink"'), "the edit link shows for the person (login), not on plain 127.0.0.1");
  ok(!(await page("/r/plain/view/x.md")).includes('class="editlink"'), "…and not in a folder with no agent");
  ok((await page("/r/one/edit/notes.md", L)).includes("can't send edits"), "the edit view on 127.0.0.1 says it can't send");

  // ----- preview, send -----
  let r = await edit({ ...v1, preview: true });
  ok(r.status === 200 && r.j.preview && r.j.added === 1 && r.j.removed === 1 && r.j.diff.includes("line two, changed"), "preview: the diff, +1 −1");
  ok((await api("GET", "/api/edits/one")).j.edits.length === 0 && !lines().length, "a preview sends nothing");
  r = await edit(v1);
  ok(r.status === 200 && r.j.id === "E1" && r.j.committed === true, "send → E1, committed in the folder");
  ok(notes() === NOTES, "artipeek didn't touch the file");
  const l1 = lines().at(-1);
  ok(l1?.kind === "edit" && l1.id === "E1" && l1.page === "notes.md" && l1.by === "user@example.com" && /^EDIT: notes\.md \(note: fix line two\)\. .*artipeek-decide edit show E1$/.test(l1.text), "the answers file gets one EDIT line for the agent");
  ok(git(one, "log", "-1", "--format=%an").stdout.toString().trim() === "artipeek", "…committed by artipeek");
  ok((await edit({ ...v1, start: "nope" })).status === 409, "a stale start (the file changed since) → 409");
  ok((await edit({ path: "doc.md", start: sha("# Doc\n"), text: "# Doc\n" }, { folder: "two" })).status === 400, "the file's own text with nothing pending → nothing to send");

  // ----- the agent's side -----
  let a = await api("GET", "/api/edits/one");
  ok(a.j.edits.length === 1 && a.j.edits[0].id === "E1" && a.j.edits[0].status === "pending" && !("text" in a.j.edits[0]), "API: pending edits listed (without the texts)");
  a = await api("GET", "/api/edits/one/E1");
  ok(a.j.edit.file === "unchanged" && a.j.edit.text === v1.text && a.j.edit.base === NOTES && a.j.edit.diff.includes("+line two, changed"), "API: one edit with the diff, both texts and where the file is");
  ok((await api("GET", "/api/edits/one", undefined, TOK.two)).status === 401, "API: another folder's token is refused");
  ok((await api("GET", "/api/answers/one")).j.answers.some((x: any) => x.kind === "edit" && x.decisionId === "E1"), "API: /api/answers lists the edit (kind edit)");
  ok((await api("POST", "/api/decisions/one", { id: "E1", title: "x" })).status === 400, "a decision can't take an edit request's id");
  let c = decide("edits");
  ok(c.exitCode === 0 && /E1\s+pending\s+notes\.md\s+\+1 -1/.test(c.stdout.toString()), "artipeek-decide edits lists it");
  c = decide("edit", "show", "E1");
  ok(/the file now: unchanged/.test(c.stdout.toString()) && c.stdout.toString().includes("+line two, changed"), "artipeek-decide edit show: the diff");
  ok(decide("edit", "show", "E1", "--text").stdout.toString() === v1.text, "…--text: exactly the person's text");

  // ----- marks on the file -----
  let v = await page("/r/one/view/notes.md");
  ok(v.includes('class="editbar pending"') && v.includes("Edit E1 sent"), "the file's page shows the pending edit");
  ok((await page("/r/one/part/tree")).includes('class="editmark"'), "the file list marks the file");
  v = await page("/r/one/part/edit/notes.md");
  ok(v.includes('data-pending="E1"') && v.includes(`data-start="${sha(v1.text)}"`) && v.includes("line two, changed"), "editing again starts from the pending edit");

  // ----- a newer edit replaces the pending one; the agent resolves -----
  const v2 = { path: "notes.md", start: sha(v1.text), text: v1.text + "line three\n" };
  r = await edit(v2);
  ok(r.j.id === "E2" && r.j.replaces === "E1", "a newer edit of the same file replaces it (E2 replaces E1)");
  ok((await api("GET", "/api/edits/one/E1")).j.edit.status === "superseded" && lines().at(-1)?.text.includes("replaces E1"), "…E1 superseded, and the line says so");
  ok((await api("GET", "/api/edits/one/E2")).j.edit.diff.includes("+line three"), "…E2's diff is against the file (both changes)");
  ok((await api("PATCH", "/api/edits/one/E2", { status: "done", note: "applied, and fixed a typo" })).status === 200, "the agent marks E2 done");
  ok((await api("PATCH", "/api/edits/one/E2", { status: "done" })).status === 400, "…only once");
  v = await page("/r/one/view/notes.md");
  ok(v.includes('class="editbar done"') && v.includes("The agent updated the file: applied, and fixed a typo"), "the page shows it done, with the agent's note");
  ok(!(await page("/r/one/part/tree")).includes('class="editmark"'), "…and the mark is gone");
  r = await edit({ path: "other.md", start: sha("# Other\n"), text: "# Other\n\nmore\n" });
  ok((await api("PATCH", `/api/edits/one/${r.j.id}`, { status: "declined" })).status === 400, "declining needs a reason");
  ok((await api("PATCH", `/api/edits/one/${r.j.id}`, { status: "declined", note: "the other page says the opposite" })).status === 200, "…with one, it's declined");
  ok((await page("/r/one/view/other.md")).includes("The agent declined it: the other page says the opposite"), "the page shows why");

  // ----- the file comes to have the text: done by itself -----
  const cur = notes();
  r = await edit({ path: "notes.md", start: sha(cur), text: cur + "auto\n" });
  writeFileSync(join(one, "notes.md"), cur + "auto\n"); // the agent writes it and forgets to mark it
  await wait(800);
  let e = (await api("GET", `/api/edits/one/${r.j.id}`)).j.edit;
  ok(e.status === "done" && e.resolvedBy === "artipeek", "a pending edit is done by itself when the file has exactly its text");

  // ----- taking an edit back -----
  const now = notes();
  r = await edit({ path: "notes.md", start: sha(now), text: now + "oops\n" });
  const back = await edit({ path: "notes.md", start: sha(now + "oops\n"), text: now });
  ok(back.j.withdrawn && back.j.id === r.j.id && (await api("GET", `/api/edits/one/${r.j.id}`)).j.edit.status === "withdrawn", "sending the file's own text takes the pending edit back");
  ok(lines().at(-1)?.text === `EDIT: ${r.j.id} withdrawn: leave notes.md as it is.`, "…and the agent hears it");
  r = await edit({ path: "notes.md", start: sha(now), text: now + "again\n" });
  ok((await edit({ path: "notes.md", withdraw: r.j.id })).j.withdrawn, "…or the Take back button");

  // ----- other folders, line endings -----
  r = await edit({ path: "crlf.txt", start: sha("a\r\nb\r\n"), text: "a\nB\n" });
  ok((await api("GET", `/api/edits/one/${r.j.id}`)).j.edit.text === "a\r\nB\r\n", "the file's CRLF line endings are kept");
  r = await edit({ path: "doc.md", start: sha("# Doc\n"), text: "# Doc\n\nnew\n" }, { folder: "two" });
  ok(r.status === 200 && r.j.committed === false && !existsSync(join(two, "inbox")), "a folder with a token but no answers file: in the hub only");
  ok((await api("GET", "/api/answers/two", undefined, TOK.two)).j.answers.some((x: any) => x.kind === "edit"), "…the agent hears it through /api/answers");

  // ----- in the browser -----
  const p = await br.newPage();
  await p.setExtraHTTPHeaders({ "Cf-Access-Jwt-Assertion": jwt });
  await p.setViewport({ width: 1200, height: 900 });
  const errs: string[] = [];
  p.on("pageerror", (x) => errs.push(String(x)));
  let dialog: "accept" | "dismiss" = "accept", dialogs = 0;
  p.on("dialog", (d) => { dialogs++; dialog === "accept" ? d.accept() : d.dismiss(); });
  const base = notes();
  // type at the end of a box (a focused textarea's caret starts at the top)
  const typeEnd = async (sel: string, text: string) => { await p.$eval(sel, (x) => { const t = x as HTMLTextAreaElement; t.focus(); t.setSelectionRange(t.value.length, t.value.length); }); await p.keyboard.type(text); };
  await p.goto(`${B}/r/one/view/notes.md`);
  await p.click("a.editlink"); await wait(600);
  ok(new URL(p.url()).pathname === "/r/one/edit/notes.md", "the edit link opens the edit view in the same tab");
  ok(await p.$eval(".pane:not([hidden]) textarea.etext", (x) => (x as HTMLTextAreaElement).value) === base, "…with the file's text");
  ok((await p.$eval("#tabs", (x) => x.textContent ?? "")).includes("✎") || (await p.$$(".tab")).length < 2, "…the tab is marked as editing");
  await typeEnd(".pane:not([hidden]) textarea.etext", "typed line\n");
  await p.reload(); await wait(600);
  ok((await p.$eval(".pane:not([hidden]) textarea.etext", (x) => (x as HTMLTextAreaElement).value)).endsWith("typed line\n"), "what you typed survives a reload");
  appendFileSync(join(one, "notes.md"), "agent wrote this\n");
  await wait(900);
  ok(await p.$eval(".pane:not([hidden]) .echanged", (x) => !(x as HTMLElement).hidden) && (await p.$eval(".pane:not([hidden]) textarea.etext", (x) => (x as HTMLTextAreaElement).value)).endsWith("typed line\n"), "the file changes on disk: a notice, and your text stays");
  await p.focus(".pane:not([hidden]) textarea.etext");
  await p.keyboard.down("Control"); await p.keyboard.press("s"); await p.keyboard.up("Control");
  await wait(600);
  ok((await p.$eval(".editsheet .amsg", (x) => x.textContent ?? "")).includes("changed since you opened it") && !!(await p.$(".editsheet .amsg button")), "Ctrl+S → the sheet says the file changed, with Load the new version");
  await p.click(".editsheet .amsg button"); await wait(600);
  ok(await p.$eval(".pane:not([hidden]) textarea.etext", (x) => (x as HTMLTextAreaElement).value) === notes(), "…which loads it");
  await typeEnd(".pane:not([hidden]) textarea.etext", "from the browser\n");
  await p.type(".pane:not([hidden]) textarea.enote", "please add this");
  await p.click(".pane:not([hidden]) [data-esend]"); await wait(600);
  ok((await p.$eval(".editsheet pre.diff", (x) => x.textContent ?? "")).includes("+from the browser") && (await p.$eval(".editsheet .atext", (x) => x.textContent ?? "")).includes("please add this"), "Send to the agent… → artipeek's sheet with the diff and the note");
  await p.evaluate(() => (document.querySelector(".editsheet .asend") as HTMLButtonElement).dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await wait(400);
  ok(!(await p.$eval(".editsheet .amsg", (x) => x.textContent ?? "")).startsWith("Sent"), "a click made by a script (not trusted) sends nothing");
  await p.click(".editsheet .asend"); await wait(500);
  const sentMsg = await p.$eval(".editsheet .amsg", (x) => x.textContent ?? "");
  ok(/^Sent as E\d+\./.test(sentMsg), "a real click on Send: " + sentMsg);
  await wait(1600);
  ok(new URL(p.url()).pathname === "/r/one/view/notes.md" && !!(await p.$(".pane:not([hidden]) #edbar.editbar.pending")), "…back on the file, which shows the edit as pending");
  ok(!!(await p.$('#tree a[data-path="notes.md"] .editmark')), "…and the file list marks it");
  ok(!notes().includes("from the browser"), "the file itself is unchanged");
  const id = /E\d+/.exec(sentMsg)![0];
  await api("PATCH", `/api/edits/one/${id}`, { status: "done", note: "added" });
  await wait(800);
  ok(!!(await p.$(".pane:not([hidden]) #edbar.editbar.done")) && !(await p.$('#tree a[data-path="notes.md"] .editmark')), "the agent marks it done: the page updates live, the mark goes");
  // Cancel with changes asks first
  await p.click(".pane:not([hidden]) a.editlink"); await wait(600);
  await p.type(".pane:not([hidden]) textarea.etext", "x");
  dialog = "dismiss"; dialogs = 0;
  await p.click(".pane:not([hidden]) a.ecancel"); await wait(300);
  ok(dialogs === 1 && new URL(p.url()).pathname === "/r/one/edit/notes.md", "Cancel with changes asks; No keeps you editing");
  dialog = "accept";
  await p.click(".pane:not([hidden]) a.ecancel"); await wait(600);
  ok(new URL(p.url()).pathname === "/r/one/view/notes.md" && !(await p.$(".pane:not([hidden]) .editor")), "…Yes goes back to the file");
  ok(!errs.length, `no page errors${errs.length ? ": " + errs.join(" | ") : ""}`);
} catch (e) {
  console.log("FAIL", e); fails++;
} finally {
  await br.close(); srv.kill(); certs.kill();
  await wait(200);
  ok(/^artipeek: edit E1 saved in one by user@example\.com, committed$/m.test(out), "the journal line for an edit (desks' watchers that match 'answer' lines skip it)");
  ok(!/line two, changed/.test(out), "no file text in the log");
  rmSync(T, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
