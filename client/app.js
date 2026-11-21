// artipeek in the browser: the app shell (file list on the left, tabs, live updates). Served inline with the page's
// nonce; decisions/client.js (the Decisions tab) is loaded just before it.
(() => {
  const body = document.body;
  const main = document.getElementById("main");
  const tree = document.getElementById("tree");
  const filter = document.getElementById("filter");
  const tabbar = document.getElementById("tabs");

  // phone menu (drawer)
  const closeNav = () => body.classList.remove("nav-open");
  document.addEventListener("click", (e) => {
    const t = e.target.closest ? e.target : null;
    if (t && t.closest("[data-menu]")) { body.classList.toggle("nav-open"); return; }
    if (t && t.closest("#scrim")) closeNav();
    const c = t && t.closest("[data-copy]");
    if (c) copyCode(c);
  });

  // Copy button on code blocks. navigator.clipboard needs a secure context, so plain http on the LAN falls back to execCommand.
  async function copyCode(btn) {
    const pre = btn.parentElement.querySelector("pre");
    if (!pre) return;
    const text = pre.innerText.replace(/\n$/, "");
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch {
      const ta = document.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", ""); ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
      document.body.appendChild(ta); ta.select();
      try { ok = document.execCommand("copy"); } catch {}
      ta.remove();
    }
    btn.textContent = ok ? "Copied" : "Failed";
    btn.classList.toggle("done", ok);
    clearTimeout(btn._t);
    btn._t = setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("done"); }, 1500);
  }
  addEventListener("keydown", (e) => { if (e.key === "Escape") closeNav(); });

  function ages(scope) {
    const now = Date.now();
    (scope || document).querySelectorAll(".age[data-mtime]").forEach((el) => {
      const s = Math.max(0, Math.round((now - Number(el.dataset.mtime)) / 1000));
      el.textContent = s < 60 ? "now" : s < 3600 ? Math.floor(s / 60) + "m" : s < 86400 ? Math.floor(s / 3600) + "h"
        : s < 31536000 ? Math.floor(s / 86400) + "d" : Math.floor(s / 31536000) + "y";
    });
  }
  setInterval(ages, 30000);
  if (!tree) return; // home page

  // ----- app tabs -----
  // Each tab has a pane in the page, hidden unless it is the active tab, so switching back fetches nothing. A tab is a
  // file (base /r/<folder>, path; mode "view" or "edit") or the Decisions tab (one at most; q = its filters). The list
  // is in sessionStorage: every browser tab has its own, and it survives a reload.
  const TABS = "artipeek-tabs";
  const DEC = "dec";
  const tabs = [];
  let active = null;
  history.scrollRestoration = "manual";

  const isDec = (t) => t.kind === DEC;
  const isEdit = (t) => t.kind === "file" && t.mode === "edit";
  // a file tab in edit mode: /r/<folder>/edit/<path> and its pane part/edit
  const fileKind = (t, kind) => (t.mode !== "edit" ? kind : kind === "view" ? "edit" : kind === "part/main" ? "part/edit" : kind);
  const encPath = (p) => p.split("/").map(encodeURIComponent).join("/");
  const tabUrl = (t, kind) => isDec(t)
    ? (kind === "view" ? "/decisions" : "/decisions/part/page") + (t.q ? "?" + t.q : "")
    : t.base + "/" + fileKind(t, kind) + "/" + encPath(t.path);
  const dirOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  const nameOf = (p) => p.slice(p.lastIndexOf("/") + 1);
  const rootOf = (base) => { try { return decodeURIComponent(base.slice(3)); } catch { return base.slice(3); } };
  // What an address opens: a file, or the Decisions tab (/decisions?…, /r/<folder>/decisions = that project).
  function parseUrl(u) {
    let m = /^(\/r\/[^/]+)\/(view|raw|edit)\/(.+)$/.exec(u.pathname);
    if (m) { try { return { kind: "file", base: m[1], path: m[3].split("/").map(decodeURIComponent).join("/"), mode: m[2] === "edit" ? "edit" : "view" }; } catch { return null; } }
    if (/^\/decisions\/?$/.test(u.pathname)) return { kind: DEC, q: u.search.slice(1) };
    m = /^\/r\/([^/]+)\/decisions\/?$/.exec(u.pathname);
    if (m) { const q = new URLSearchParams(u.search); try { q.set("project", decodeURIComponent(m[1])); } catch { return null; } return { kind: DEC, q: q.toString() }; }
    return null;
  }
  const findTab = (f) => tabs.find((t) => (f.kind === DEC ? isDec(t) : !isDec(t) && t.base === f.base && t.path === f.path));
  const note = (html) => '<div class="filebar"><button type="button" class="menu" aria-label="Files" data-menu>☰</button></div><p class="note">' + html + "</p>";

  function addTab(f, y, pane) {
    if (!pane) {
      pane = document.createElement("section");
      pane.className = "pane";
      pane.hidden = true;
      pane.innerHTML = note("Loading…");
      main.appendChild(pane);
    }
    const t = { kind: f.kind === DEC ? DEC : "file", mode: f.mode === "edit" ? "edit" : "view", base: f.base || "", path: f.path || "", q: f.q || "", y: y || 0, pane, loaded: false, seq: 0, hash: "", ctl: null, dirty: false };
    tabs.push(t);
    return t;
  }
  function saveTabs() {
    try { sessionStorage.setItem(TABS, JSON.stringify(tabs.map((t) => ({ kind: t.kind, mode: t.mode, base: t.base, path: t.path, q: t.q, y: t.y })))); } catch {}
  }
  function readTabs() {
    try {
      const a = JSON.parse(sessionStorage.getItem(TABS) || "[]");
      return Array.isArray(a) ? a.filter((s) => s && (s.kind === DEC ? typeof s.q === "string" : typeof s.path === "string" && /^\/r\/[^/]+$/.test(s.base))) : [];
    } catch { return []; }
  }
  const label = (t) => (isDec(t) ? "Decisions" : (isEdit(t) ? "✎ " : "") + nameOf(t.path));

  function drawTabs() {
    tabbar.hidden = tabs.length < 2;
    body.classList.toggle("has-tabs", tabs.length > 1);
    const same = {};
    tabs.forEach((t) => { const n = label(t); same[n] = (same[n] || 0) + 1; });
    tabbar.replaceChildren(...tabs.map((t, i) => {
      const box = document.createElement("div");
      box.className = "tab" + (t === active ? " active" : "") + (isDec(t) ? " dectab" : "");
      box.dataset.i = i;
      const a = document.createElement("a");
      a.href = tabUrl(t, "view");
      a.title = isDec(t) ? "Decisions" : rootOf(t.base) + "/" + t.path;
      // Many files share a name (email.html, README.md): then show the folder too.
      a.textContent = (!isDec(t) && same[label(t)] > 1 && dirOf(t.path) ? (isEdit(t) ? "✎ " : "") + nameOf(dirOf(t.path)) + "/" + nameOf(t.path) : label(t));
      const x = document.createElement("button");
      x.type = "button";
      x.textContent = "×";
      x.setAttribute("aria-label", "Close " + label(t));
      x.dataset.close = i;
      box.append(a, x);
      return box;
    }));
    const el = tabbar.querySelector(".active");
    if (el && el.offsetLeft < tabbar.scrollLeft) tabbar.scrollLeft = el.offsetLeft - 8;
    else if (el && el.offsetLeft + el.offsetWidth > tabbar.scrollLeft + tabbar.clientWidth) tabbar.scrollLeft = el.offsetLeft + el.offsetWidth - tabbar.clientWidth + 8;
  }

  // Ids repeat across panes (and hidden ones can't scroll), so look only inside the active one.
  function jump(hash) {
    const raw = hash.slice(1);
    let dec = raw;
    try { dec = decodeURIComponent(raw); } catch {}
    if (isDec(active) && active.ctl && /^d:/.test(dec)) { const p = dec.split(":"); active.ctl.jump(p[1] + "/" + p.slice(2).join(":")); return true; }
    const el = raw && (active.pane.querySelector('[id="' + CSS.escape(raw) + '"]') || active.pane.querySelector('[id="' + CSS.escape(dec) + '"]'));
    if (el) el.scrollIntoView();
    return !!el;
  }

  function title(t) {
    // Parent folder first, then the root (project): many folders hold a decisions.html or README.md.
    document.title = isDec(t) ? "Decisions · artipeek" : (isEdit(t) ? "Edit " : "") + (dirOf(t.path) ? nameOf(dirOf(t.path)) + "/" : "") + nameOf(t.path) + " · " + rootOf(t.base) + " · artipeek";
  }

  function activate(t, how, hash) {
    if (t === active) {
      if (how === "push" && hash) history.pushState(null, "", tabUrl(t, "view") + hash);
      if (hash) jump(hash);
      if (!t.loaded) load(t);
      return;
    }
    if (active) { if (active.ctl) active.ctl.onHide(); active.y = scrollY; active.pane.hidden = true; }
    active = t;
    t.pane.hidden = false;
    const url = tabUrl(t, "view") + (hash || "");
    if (how === "push") history.pushState(null, "", url);
    else if (how === "replace") history.replaceState(null, "", url);
    title(t);
    drawTabs();
    markTree();
    saveTabs();
    if (t.loaded) { if (!hash || !jump(hash)) scrollTo(0, t.y); if (t.ctl) t.ctl.onShow(false); }
    else { t.hash = hash || ""; scrollTo(0, 0); load(t); }
  }

  function openTab(f, hash, how) {
    let t = findTab(f);
    if (t && !isDec(t) && f.mode && f.mode !== t.mode) { // the same file, in the other view (edit ⇄ view)
      if (isEdit(t) && t.dirty && !confirm("Drop your changes to " + nameOf(t.path) + "?")) return;
      if (isEdit(t)) dropDraft(t);
      t.mode = f.mode; t.loaded = false; t.dirty = false; t.seq++; t.y = 0;
      if (t === active) {
        if (how !== "none") history[how === "replace" ? "replaceState" : "pushState"](null, "", tabUrl(t, "view") + (hash || ""));
        title(t); drawTabs(); saveTabs(); scrollTo(0, 0); load(t);
        return;
      }
    }
    if (t && isDec(t) && f.q && f.q !== t.q) { // the Decisions tab, asked with other filters
      t.q = f.q;
      if (t.ctl) t.ctl.apply(f.q); else t.loaded = false;
    }
    activate(t || addTab(f), how || "push", hash);
  }

  function closeTab(t) {
    const i = tabs.indexOf(t);
    if (i < 0 || tabs.length < 2) return;
    if (isEdit(t) && t.dirty && !confirm("Drop your changes to " + nameOf(t.path) + "?")) return;
    if (isEdit(t)) dropDraft(t);
    tabs.splice(i, 1);
    t.seq++; // drop any fetch still running for it
    if (t.ctl) { t.ctl.destroy(); t.ctl = null; }
    t.pane.remove();
    if (t === active) { active = null; activate(tabs[Math.min(i, tabs.length - 1)], "replace"); }
    else { drawTabs(); saveTabs(); }
  }

  // The Decisions tab's controller (decisions/client.js) on its pane.
  function mountDec(t) {
    if (t.ctl) t.ctl.destroy();
    t.ctl = window.artipeekDecisions ? window.artipeekDecisions.mount(t.pane, {
      active: () => t === active,
      setQuery: (q) => { t.q = q; saveTabs(); if (t === active) history.replaceState(null, "", tabUrl(t, "view")); },
    }) : null;
  }

  const mtimeOf = (html) => (/data-mtime="(\d+)"/.exec(html) || [])[1];
  // onlyIfNewer: after a gap in the live stream. Don't reset a page (an iframe restarts) if its file didn't change.
  async function load(t, onlyIfNewer) {
    if (isDec(t) && onlyIfNewer) { if (t.ctl) t.ctl.event("all", {}); return; } // it patches itself
    if (isEdit(t) && onlyIfNewer && t.loaded) { loadStatus(t); return; } // never under the person's typing
    const seq = ++t.seq;
    let r = null, html = "";
    try { r = await fetch(tabUrl(t, "part/main")); html = await r.text(); } catch { r = null; }
    if (seq !== t.seq) return; // a newer load took over, or the tab closed
    const first = !t.loaded;
    if (r && r.ok) {
      if (onlyIfNewer && !first && mtimeOf(html) === mtimeOf(t.pane.innerHTML)) return;
      const y = scrollY;
      if (t.ctl) { t.ctl.destroy(); t.ctl = null; }
      t.pane.innerHTML = html;
      ages(t.pane);
      t.loaded = true;
      if (isDec(t)) mountDec(t);
      if (isEdit(t)) mountEditor(t);
      if (t === active && !(t.hash && jump(t.hash))) scrollTo(0, first ? t.y : y);
      t.hash = "";
      if (t === active && t.ctl) t.ctl.onShow(true);
    } else if (r && r.status === 404) {
      t.pane.innerHTML = note("This file was removed.");
      t.loaded = true;
    } else if (first) {
      t.pane.innerHTML = note('Could not load this file. <button type="button" data-retry>Try again</button>');
    }
  }
  // The status bar and the edit bar (#stbar, #edbar) under the file bar.
  async function loadStatus(t) {
    let r = null;
    try { r = await fetch(tabUrl(t, "part/status")); } catch {}
    const el = t.pane.querySelector("#stbar");
    if (!r || !r.ok || !el) return;
    const html = await r.text();
    const ed = t.pane.querySelector("#edbar");
    if (ed) ed.remove();
    el.outerHTML = html;
    ages(t.pane);
  }

  // ----- one live stream for every folder and the decisions -----
  let catchUp = false;
  function connect() {
    const es = new EventSource("/_/events");
    es.addEventListener("change", (ev) => {
      const d = JSON.parse(ev.data), base = "/r/" + encodeURIComponent(d.root);
      const dirs = d.paths.filter((p) => /\.(md|markdown|html?)$/i.test(p)).map(dirOf);
      for (const t of tabs) {
        if (isDec(t) || t.base !== base || !t.loaded) continue;
        if (d.paths.includes(t.path)) {
          if (!isEdit(t)) load(t);
          else { const n = t.pane.querySelector(".echanged"); if (n) n.hidden = false; loadStatus(t); } // keep what the person typed
        } else if (dirs.includes(dirOf(t.path))) loadStatus(t);
      }
    });
    es.addEventListener("tree", (ev) => { refreshRoot(JSON.parse(ev.data).root); refreshRecent(); });
    // an edit request was sent, replaced or resolved: the file's edit bar and its mark in the list
    es.addEventListener("edit", (ev) => {
      const d = JSON.parse(ev.data), base = "/r/" + encodeURIComponent(d.root);
      for (const t of tabs) if (!isDec(t) && t.loaded && t.base === base && t.path === d.path) loadStatus(t);
      refreshRoot(d.root); refreshRecent();
    });
    for (const name of ["d", "ref", "all", "tick"]) es.addEventListener(name, (ev) => {
      const d = JSON.parse(ev.data);
      const t = tabs.find(isDec);
      if (t && t.ctl) t.ctl.event(name, d);
      if (name !== "tick" || !navCountsAt || Date.now() - navCountsAt > 50_000) refreshNavCounts();
    });
    es.onerror = () => { catchUp = true; body.classList.add("offline"); };
    es.onopen = () => {
      body.classList.remove("offline");
      if (!catchUp) return;
      catchUp = false;
      loadedRoots().forEach(refreshRoot); refreshRecent(); refreshNavCounts();
      tabs.forEach((t) => { if (t.loaded) load(t, true); });
    };
  }

  // ----- sidebar: Decisions, Recent (every folder), then every folder, each opening to its files -----
  const openKey = (root) => "artipeek-open:/r/" + root;
  const ROOTS_KEY = "artipeek-open-roots";
  const readSet = (k) => { try { return new Set(JSON.parse(localStorage.getItem(k) || "[]")); } catch { return new Set(); } };
  const writeSet = (k, s) => { try { localStorage.setItem(k, JSON.stringify([...s])); } catch {} };
  const rootBox = (root) => tree.querySelector('details[data-root="' + CSS.escape(root) + '"]');
  const rootList = (root) => tree.querySelector('ul.tree[data-root="' + CSS.escape(root) + '"]');
  const loadedRoots = () => Array.prototype.map.call(tree.querySelectorAll("ul.tree[data-root]:not([data-lazy])"), (u) => u.dataset.root);

  // Folders inside a folder's tree remember being open (per folder).
  function restoreDirs(root) {
    const ul = rootList(root);
    if (!ul) return;
    const open = readSet(openKey(root));
    ul.querySelectorAll("details[data-dir]").forEach((d) => {
      if (open.has(d.dataset.dir)) d.open = true;
      d.addEventListener("toggle", () => { const s = readSet(openKey(root)); d.open ? s.add(d.dataset.dir) : s.delete(d.dataset.dir); writeSet(openKey(root), s); });
    });
  }
  const getSort = () => { const b = document.querySelector('#sort button[aria-pressed="true"]'); return b ? b.dataset.sort : "name"; };
  const curPath = (root) => (active && !isDec(active) && rootOf(active.base) === root ? active.path : "");
  const treeSeq = {};
  async function fillRoot(root) {
    const ul = rootList(root);
    if (!ul) return;
    const seq = treeSeq[root] = (treeSeq[root] || 0) + 1;
    let html = null;
    try { const r = await fetch("/r/" + encodeURIComponent(root) + "/part/tree?current=" + encodeURIComponent(curPath(root)) + "&sort=" + getSort()); if (r.ok) html = await r.text(); } catch {}
    if (html === null || seq !== treeSeq[root]) return;
    const top = tree.scrollTop;
    ul.innerHTML = html;
    ul.removeAttribute("data-lazy");
    restoreDirs(root);
    ages(ul);
    tree.scrollTop = top;
    applyFilter();
    markTree(true);
  }
  function refreshRoot(root) { if (rootList(root) && !rootList(root).hasAttribute("data-lazy")) fillRoot(root); }
  async function refreshRecent() {
    const box = tree.querySelector("details.recent ul");
    if (!box) return;
    try { const r = await fetch("/_/part/recent?sort=" + getSort()); if (r.ok) { box.innerHTML = await r.text(); ages(box); markTree(true); } } catch {}
  }
  let navCountsAt = 0, navT = 0;
  function refreshNavCounts() {
    clearTimeout(navT);
    navT = setTimeout(async () => {
      navCountsAt = Date.now();
      try {
        const r = await fetch("/decisions/part/counts");
        if (!r.ok) return;
        const c = (await r.json()).counts || {};
        let open = 0, urgent = 0;
        for (const p in c) { open += c[p].open || 0; urgent += c[p].urgent || 0; }
        const a = tree.querySelector("a.navdec");
        if (!a) return;
        a.querySelector(".nd-open").textContent = open ? String(open) : "";
        a.querySelector(".nd-urg").textContent = urgent ? String(urgent) : "";
      } catch {}
    }, 300);
  }
  tree.addEventListener("toggle", (e) => {
    const d = e.target;
    if (!d.matches || !d.matches("details[data-root]")) return;
    const s = readSet(ROOTS_KEY);
    d.open ? s.add(d.dataset.root) : s.delete(d.dataset.root);
    writeSet(ROOTS_KEY, s);
    if (d.open && rootList(d.dataset.root) && rootList(d.dataset.root).hasAttribute("data-lazy")) fillRoot(d.dataset.root);
  }, true);

  // Highlight the active tab's file (or Decisions); open its folder and the folders above it.
  function markTree(quiet) {
    tree.querySelectorAll("a.current").forEach((a) => a.classList.remove("current"));
    if (!active) return;
    if (isDec(active)) { const a = tree.querySelector("a.navdec"); if (a) a.classList.add("current"); return; }
    const root = rootOf(active.base);
    const sel = 'a[data-base="' + CSS.escape(active.base) + '"][data-path="' + CSS.escape(active.path) + '"]';
    tree.querySelectorAll(sel).forEach((a) => a.classList.add("current"));
    const box = rootBox(root);
    if (box && !box.open) { box.open = true; return; } // its toggle loads the tree, which marks again
    const c = tree.querySelector("ul.tree " + sel);
    if (!c) return;
    for (let d = c.closest("details"); d; d = d.parentElement.closest("details")) d.open = true;
    if (!quiet && (c.offsetTop < tree.scrollTop || c.offsetTop > tree.scrollTop + tree.clientHeight - 30)) tree.scrollTop = c.offsetTop - tree.clientHeight / 2;
  }

  function applyFilter() {
    const q = filter.value.trim().toLowerCase();
    tree.querySelectorAll("ul.tree li.file").forEach((li) => {
      li.hidden = !!q && !li.firstElementChild.dataset.path.toLowerCase().includes(q);
    });
    tree.querySelectorAll("ul.tree li.dir").forEach((li) => {
      li.hidden = !!q && !li.querySelector("li.file:not([hidden])");
      if (q) li.firstElementChild.open = true;
    });
    tree.querySelectorAll("li.rootnode").forEach((li) => {
      const ul = li.querySelector("ul.tree");
      li.hidden = !!q && ul && !ul.hasAttribute("data-lazy") && !ul.querySelector("li.file:not([hidden])");
    });
    tree.querySelectorAll("details.recent, a.navdec").forEach((el) => { el.hidden = !!q; });
  }
  filter.addEventListener("input", () => {
    // searching: every folder's files, so load the trees not loaded yet
    if (filter.value.trim().length >= 2) tree.querySelectorAll("ul.tree[data-lazy]").forEach((u) => fillRoot(u.dataset.root));
    applyFilter();
  });
  filter.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { const a = tree.querySelector("ul.tree li.file:not([hidden]) a"); if (a) a.click(); }
    if (e.key === "Escape") { filter.value = ""; applyFilter(); }
  });
  const sortBtns = document.querySelectorAll("#sort button");
  sortBtns.forEach((b) => b.addEventListener("click", () => {
    if (b.getAttribute("aria-pressed") === "true") return;
    sortBtns.forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    document.cookie = "artipeek_sort=" + b.dataset.sort + "; Path=/; Max-Age=31536000; SameSite=Lax";
    loadedRoots().forEach(refreshRoot);
    refreshRecent();
  }));

  // ----- clicks -----
  document.addEventListener("click", (e) => {
    const x = e.target.closest("[data-close]");
    if (x) { closeTab(tabs[Number(x.dataset.close)]); return; }
    if (e.target.closest("[data-retry]")) { load(active); return; }
    if (e.target.closest("[data-esend]")) { askEdit(active); return; }
    const wd = e.target.closest("[data-ewithdraw]");
    if (wd) { askEdit(active, wd.dataset.ewithdraw); return; }
    if (e.target.closest("[data-ereload]")) { if (active.dirty && !confirm("Drop your changes and load the file as it is now?")) return; dropDraft(active); active.dirty = false; load(active); return; }
    const a = e.target.closest("a[href]");
    if (!a || e.defaultPrevented || e.button || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || a.target || a.hasAttribute("download")) return;
    const u = new URL(a.href);
    if (u.origin !== location.origin) return;
    if (a.getAttribute("href").startsWith("#")) { // a heading or footnote in this file
      e.preventDefault();
      history.pushState(null, "", u.href);
      jump(u.hash);
      return;
    }
    const f = parseUrl(u);
    if (f) { e.preventDefault(); closeNav(); openTab(f, u.hash); return; }
    if (/^\/r\/[^/]+\/$/.test(u.pathname)) { // a folder: the server picks its first file
      e.preventDefault();
      closeNav();
      fetch(u.href).then((r) => {
        const d = r.ok && parseUrl(new URL(r.url));
        if (d) openTab(d); else location.href = u.href;
      }).catch(() => { location.href = u.href; });
    }
  });
  tabbar.addEventListener("auxclick", (e) => { // middle click closes
    const box = e.button === 1 && e.target.closest(".tab");
    if (box) { e.preventDefault(); closeTab(tabs[Number(box.dataset.i)]); }
  });
  // A link clicked inside an HTML page: its frame can't open tabs, so it asks (see FRAME_LINKS). Only the visible page counts.
  addEventListener("message", (e) => {
    const f = active && active.pane.querySelector("iframe");
    if (!f || e.source !== f.contentWindow || !e.data || e.data.artipeek !== "open" || typeof e.data.href !== "string") return;
    let u;
    try { u = new URL(e.data.href); } catch { return; }
    const d = u.origin === location.origin && parseUrl(u);
    if (d) openTab(d, u.hash);
  });
  // An answer button in an HTML page (see frameAnswers): show artipeek's own sheet with the exact text. Only a
  // real click on Send here posts it; the page itself can't send anything or press this button.
  let sheet = null;
  addEventListener("message", (e) => {
    const f = active && active.pane.querySelector("iframe");
    if (!f || e.source !== f.contentWindow || !e.data || e.data.artipeek !== "answer") return;
    const id = String(e.data.id || ""), text = String(e.data.text || "").trim();
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,31}$/.test(id) || !text || text.length > 2000) return;
    askAnswer(active, f, id, text);
  });
  // HTML pages keep their place across live reloads (see frameState): scroll and typed text, per file, in this
  // browser tab's sessionStorage. Any open tab's frame counts: hidden tabs reload live too.
  const frameKey = (t) => "artipeek-frame:" + t.base + "/" + t.path;
  addEventListener("message", (e) => {
    if (!e.data || (e.data.artipeek !== "state" && e.data.artipeek !== "ready")) return;
    const t = tabs.find((x) => { const f = x.pane.querySelector("iframe"); return f && e.source === f.contentWindow; });
    if (!t) return;
    if (e.data.artipeek === "ready") {
      let st = null;
      try { st = JSON.parse(sessionStorage.getItem(frameKey(t)) || "null"); } catch (x) {}
      if (st) e.source.postMessage({ artipeek: "restore", y: st.y, fields: st.fields }, "*");
      return;
    }
    const fields = {};
    if (e.data.fields && typeof e.data.fields === "object")
      for (const [k, v] of Object.entries(e.data.fields).slice(0, 50)) if (typeof v === "string" && k.length <= 100) fields[k] = v.slice(0, 4000);
    try { sessionStorage.setItem(frameKey(t), JSON.stringify({ y: Math.max(0, Number(e.data.y) || 0), fields: fields })); } catch (x) {}
  });
  function askAnswer(t, frame, id, text) {
    if (sheet) sheet.remove();
    const s = document.createElement("div");
    s.className = "answersheet"; s.setAttribute("role", "dialog"); s.setAttribute("aria-modal", "true");
    s.innerHTML = '<div class="box"><p class="q">Send this answer?</p><p class="aid"></p><pre class="atext"></pre><p class="afrom"></p><p class="amsg" aria-live="polite"></p><div class="btns"><button type="button" class="acancel">Cancel</button><button type="button" class="asend">Send</button></div></div>';
    s.querySelector(".aid").textContent = id;
    s.querySelector(".atext").textContent = text;
    s.querySelector(".afrom").textContent = "From " + t.path;
    const msg = s.querySelector(".amsg"), send = s.querySelector(".asend");
    const close = () => { s.remove(); if (sheet === s) sheet = null; };
    s.querySelector(".acancel").addEventListener("click", close);
    s.addEventListener("click", (ev) => { if (ev.target === s) close(); });
    s.addEventListener("keydown", (ev) => { if (ev.key === "Escape") close(); });
    send.addEventListener("click", async (ev) => {
      if (!ev.isTrusted || send.disabled) return;
      send.disabled = true; msg.textContent = "Saving…";
      try {
        const r = await fetch(t.base + "/answer", { method: "POST", headers: { "Content-Type": "application/json", "X-Artipeek": "answer" }, body: JSON.stringify({ id: id, text: text, page: t.path }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) throw new Error(j.error || "HTTP " + r.status);
        msg.textContent = "Saved at " + new Date(j.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + (j.committed || j.hub ? "." : " (not committed yet).");
        const cur = t.pane.querySelector("iframe") || frame; // a live reload may have swapped the frame meanwhile
        try { cur.contentWindow.postMessage({ artipeek: "answer-saved", id: id, text: text, at: j.at, uid: j.uid }, "*"); } catch (x) {}
        setTimeout(close, 1500);
      } catch (err) { msg.textContent = "Not saved: " + err.message; send.disabled = false; }
    });
    document.body.appendChild(s); sheet = s; send.focus();
  }
  // ----- edit view: the person's edit goes to the folder's agent as a request; artipeek never writes the file -----
  // What was typed stays in this browser tab (sessionStorage) until sent or dropped, if the editor still starts from
  // the same text (data-start).
  const draftKey = (t) => "artipeek-edit:" + t.base + "/" + t.path;
  function dropDraft(t) { try { sessionStorage.removeItem(draftKey(t)); } catch (x) {} }
  function mountEditor(t) {
    t.dirty = false;
    const ed = t.pane.querySelector(".editor");
    if (!ed) return;
    const ta = ed.querySelector(".etext"), nt = ed.querySelector(".enote"), orig = ta.value;
    let d = null;
    try { d = JSON.parse(sessionStorage.getItem(draftKey(t)) || "null"); } catch (x) {}
    if (d && d.start === ed.dataset.start && typeof d.text === "string") { ta.value = d.text; nt.value = d.note || ""; }
    const keep = () => {
      t.dirty = ta.value !== orig || nt.value.trim() !== "";
      try { if (t.dirty) sessionStorage.setItem(draftKey(t), JSON.stringify({ start: ed.dataset.start, text: ta.value, note: nt.value })); else dropDraft(t); } catch (x) {}
    };
    keep();
    ta.addEventListener("input", keep);
    nt.addEventListener("input", keep);
    ed.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s") { e.preventDefault(); askEdit(t); } });
  }
  // artipeek's own sheet: the change as a diff (from the server), then Send. withdraw: take a pending edit back.
  async function askEdit(t, withdraw) {
    const ed = t && isEdit(t) && t.pane.querySelector(".editor");
    if (!ed) return;
    const body = withdraw ? { path: t.path, withdraw: withdraw }
      : { path: t.path, start: ed.dataset.start, text: ed.querySelector(".etext").value, note: ed.querySelector(".enote").value };
    const post = async (extra) => {
      const r = await fetch(t.base + "/edit", { method: "POST", headers: { "Content-Type": "application/json", "X-Artipeek": "edit" }, body: JSON.stringify(Object.assign({}, body, extra)) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { const err = new Error(j.error || "HTTP " + r.status); err.changed = !!j.changed; throw err; }
      return j;
    };
    if (sheet) sheet.remove();
    const s = document.createElement("div");
    s.className = "answersheet editsheet"; s.setAttribute("role", "dialog"); s.setAttribute("aria-modal", "true");
    s.innerHTML = '<div class="box"><p class="q"></p><p class="aid"></p><div class="echange"></div><pre class="atext" hidden></pre><p class="amsg" aria-live="polite">Checking…</p><div class="btns"><button type="button" class="acancel">Cancel</button><button type="button" class="asend" disabled>Send</button></div></div>';
    s.querySelector(".q").textContent = withdraw ? "Take your edit " + withdraw + " back?" : "Send this edit to the agent?";
    s.querySelector(".aid").textContent = rootOf(t.base) + "/" + t.path;
    const msg = s.querySelector(".amsg"), send = s.querySelector(".asend"), change = s.querySelector(".echange");
    const close = () => { s.remove(); if (sheet === s) sheet = null; };
    const failed = (err) => {
      msg.textContent = (err.changed ? "" : "Not sent: ") + err.message;
      if (err.changed) {
        const b = document.createElement("button");
        b.type = "button"; b.textContent = "Load the new version";
        b.addEventListener("click", () => { dropDraft(t); t.dirty = false; close(); load(t); });
        msg.append(" ", b);
      }
    };
    s.querySelector(".acancel").addEventListener("click", close);
    s.addEventListener("click", (ev) => { if (ev.target === s) close(); });
    s.addEventListener("keydown", (ev) => { if (ev.key === "Escape") close(); });
    document.body.appendChild(s); sheet = s;
    let p;
    try { p = await post({ preview: true }); } catch (err) { failed(err); return; }
    if (sheet !== s) return;
    if (p.withdraw) {
      s.querySelector(".q").textContent = "Take your edit " + p.withdraw + " back?";
      msg.textContent = "The agent is told to leave the file as it is.";
    } else {
      change.innerHTML = p.diff; // escaped by the server
      const sum = document.createElement("p");
      sum.className = "aid";
      sum.textContent = "+" + p.added + " −" + p.removed + " lines" + (p.replaces ? ". Replaces your pending edit " + p.replaces + "." : ".") + " The agent updates the file; nothing changes until then.";
      change.prepend(sum);
      if (body.note && body.note.trim()) { const n = s.querySelector(".atext"); n.textContent = "Note: " + body.note.trim(); n.hidden = false; }
      msg.textContent = "";
    }
    send.disabled = false; send.focus();
    send.addEventListener("click", async (ev) => {
      if (!ev.isTrusted || send.disabled) return;
      send.disabled = true; msg.textContent = "Sending…";
      try {
        const j = await post({});
        msg.textContent = j.withdrawn ? j.id + " taken back." : "Sent as " + j.id + ". The agent will update the file.";
        dropDraft(t); t.dirty = false;
        setTimeout(() => { // back to the file, now with its edit bar
          close();
          if (!tabs.includes(t) || !isEdit(t)) return;
          if (t === active) openTab({ kind: "file", base: t.base, path: t.path, mode: "view" }, "", "replace");
          else { t.mode = "view"; t.loaded = false; t.seq++; drawTabs(); saveTabs(); load(t); }
        }, 1200);
      } catch (err) { failed(err); send.disabled = !!err.changed; }
    });
  }

  addEventListener("popstate", () => {
    const f = parseUrl(location);
    if (f) openTab(f, location.hash, "none"); else location.reload();
  });
  addEventListener("pagehide", () => { if (active) active.y = scrollY; saveTabs(); });
  addEventListener("pageshow", (e) => { if (e.persisted) location.reload(); }); // back from another page: the list may have moved on

  // ----- start: the saved list, plus the tab the server just rendered -----
  const here = body.dataset.kind === DEC ? { kind: DEC, q: body.dataset.q || "" } : { kind: "file", base: body.dataset.base, path: body.dataset.path, mode: body.dataset.mode === "edit" ? "edit" : "view" };
  const firstPane = main.querySelector(".pane");
  for (const s of readTabs()) {
    if (findTab(s)) continue;
    const isHere = s.kind === DEC ? here.kind === DEC : here.kind !== DEC && s.base === here.base && s.path === here.path;
    addTab(isHere ? Object.assign({}, s, here.kind === DEC ? { q: here.q } : { mode: here.mode }) : s, s.y, isHere ? firstPane : null);
  }
  const start = findTab(here) || addTab(here, 0, firstPane);
  start.loaded = true;
  if (isDec(start)) { start.q = here.q; mountDec(start); }
  if (isEdit(start)) mountEditor(start);
  // folders opened before stay open (their trees load lazily)
  const openRoots = readSet(ROOTS_KEY);
  tree.querySelectorAll("details[data-root]").forEach((d) => { if (openRoots.has(d.dataset.root) && !d.open) d.open = true; });
  loadedRoots().forEach(restoreDirs);
  activate(start, "none", location.hash);
  if (isDec(start) && start.ctl) start.ctl.onShow(true);
  applyFilter();
  refreshNavCounts();
  connect();
  (async () => { // refill the other tabs so they switch at once after a reload
    for (const t of [...tabs]) if (!t.loaded && tabs.includes(t)) await load(t);
  })();
})();
