// artipeek decision hub, in the browser. Served inline with the page's nonce (CSP allows nothing else).
// - Live: one EventSource; a change patches only that card (no reload, no white flash).
// - Your place is locked: before any patch we note which part of which card sits under the top bar and where, and
//   after the patch we scroll by the difference. Nothing you are reading moves; nothing disappears under you
//   (a card that leaves the filter stays, dimmed, until you change the filter).
// - Typed notes and per-question picks live in this script (and sessionStorage), so a patch or a reload keeps them.
(() => {
  const body = document.body;
  if (!body.classList.contains("dhub")) return;
  const list = document.getElementById("dlist");
  const olist = document.getElementById("olist");
  const top = document.getElementById("dtop");
  const empty = document.getElementById("dempty");
  const PROJECT = body.dataset.project || "";
  const CAN = body.dataset.can === "1";
  const SKEY = "artipeek-dec:" + (PROJECT || "*");
  const URGENT_MS = 24 * 3600 * 1000;
  history.scrollRestoration = "manual";
  document.documentElement.style.overflowAnchor = "none"; // we do our own anchoring

  // ----- state -----
  let st = {};
  try { st = JSON.parse(sessionStorage.getItem(SKEY) || "{}") || {}; } catch (e) { st = {}; }
  st.notes = st.notes || {}; st.picks = st.picks || {};
  const q = new URLSearchParams(location.search);
  const filter = {
    status: body.dataset.filter || "open",
    urgent: q.get("urgent") === "1",
    project: PROJECT ? "" : (q.get("project") || ""),
  };
  let counts = {};
  try { counts = JSON.parse(document.getElementById("dcounts").textContent || "{}"); } catch (e) {}
  let saveT = 0;
  const save = () => { clearTimeout(saveT); saveT = setTimeout(() => { try { sessionStorage.setItem(SKEY, JSON.stringify(st)); } catch (e) {} }, 150); };
  const setUrl = () => {
    const u = new URL(location.href);
    u.searchParams.set("status", filter.status);
    if (filter.urgent) u.searchParams.set("urgent", "1"); else u.searchParams.delete("urgent");
    if (filter.project) u.searchParams.set("project", filter.project); else u.searchParams.delete("project");
    history.replaceState(null, "", u.pathname + "?" + u.searchParams.toString() + location.hash);
  };

  const cards = () => Array.prototype.slice.call(list.children).filter((c) => c.classList.contains("dc"));
  const byKey = (k) => list.querySelector('.dc[data-k="' + CSS.escape(k) + '"]');
  const itemByKey = (k) => olist.querySelector('.oi[data-k="' + CSS.escape(k) + '"]');
  const topH = () => Math.max(0, top.getBoundingClientRect().bottom); // on a phone the bar scrolls away

  // ----- times -----
  const p2 = (n) => String(n).padStart(2, "0");
  const fmt = (d) => p2(d.getDate()) + "/" + p2(d.getMonth() + 1) + " " + p2(d.getHours()) + ":" + p2(d.getMinutes());
  function rel(ms) {
    const a = Math.abs(ms), m = Math.round(a / 60000);
    const s = m < 60 ? m + "m" : m < 48 * 60 ? Math.round(m / 60) + "h" : Math.round(m / 1440) + "d";
    return ms >= 0 ? "in " + s : s + " ago";
  }
  function times(scope) {
    const now = Date.now();
    (scope || document).querySelectorAll("time[data-ts]").forEach((t) => {
      const d = new Date(t.getAttribute("datetime"));
      if (isNaN(d)) return;
      t.textContent = fmt(d) + (t.hasAttribute("data-rel") ? " (" + rel(d - now) + ")" : "");
      t.title = d.toString();
      if (t.hasAttribute("data-rel")) t.classList.toggle("past", d < now);
    });
  }

  // ----- urgency (the flag, or a deadline under 24 h / past, while open) -----
  function urgentOf(c) {
    if (c.dataset.status !== "open") return false;
    if (c.dataset.flag === "1") return true;
    const d = c.dataset.deadline ? Date.parse(c.dataset.deadline) : NaN;
    return !isNaN(d) && d - Date.now() < URGENT_MS;
  }
  function urgency() {
    cards().forEach((c) => {
      const u = urgentOf(c);
      c.classList.toggle("urgent", u);
      const it = itemByKey(c.dataset.k);
      if (it) it.classList.toggle("urgent", u);
    });
  }

  // ----- filters -----
  function visible(c) {
    if (filter.project && c.dataset.project !== filter.project) return false;
    if (filter.urgent && !c.classList.contains("urgent")) return false;
    return true;
  }
  function applyFilter() {
    let n = 0;
    cards().forEach((c) => {
      const v = visible(c);
      c.hidden = !v;
      const it = itemByKey(c.dataset.k);
      if (it) it.hidden = !v;
      if (v) n++;
    });
    empty.hidden = n > 0;
    empty.textContent = filter.urgent ? "Nothing urgent here." : filter.status === "open" ? "No open decisions." : "Nothing here.";
    drawCounts();
  }
  function drawCounts() {
    const ps = filter.project ? [filter.project] : Object.keys(counts);
    const sum = (k) => ps.reduce((n, p) => n + ((counts[p] || {})[k] || 0), 0);
    document.querySelectorAll("[data-count]").forEach((i) => {
      const k = i.dataset.count;
      let v = sum(k);
      if (k === "urgent" && (filter.status === "open" || filter.status === "all")) v = cards().filter((c) => c.classList.contains("urgent") && (!filter.project || c.dataset.project === filter.project)).length;
      i.textContent = v ? String(v) : "";
    });
    document.querySelectorAll("[data-pcount]").forEach((i) => {
      const c = counts[i.dataset.pcount] || {};
      const v = c[filter.status] || 0;
      i.textContent = v ? String(v) : "";
      i.classList.toggle("hot", !!c.urgent);
    });
    document.querySelectorAll("[data-status]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.status === filter.status)));
    document.querySelectorAll("[data-urgent]").forEach((b) => b.setAttribute("aria-pressed", String(filter.urgent)));
    document.querySelectorAll("[data-project]").forEach((b) => { if (b.tagName === "BUTTON") b.setAttribute("aria-pressed", String(b.dataset.project === filter.project)); });
  }

  // ----- your place -----
  // The part of a card under the top bar (header, context, an update, the questions…) and its distance from it.
  function anchor() {
    const y = topH() + 6;
    const x = list.getBoundingClientRect().left + Math.min(40, list.clientWidth / 2);
    let card = null, part = null;
    const el = document.elementFromPoint(x, Math.min(y, innerHeight - 1));
    if (el && list.contains(el)) { card = el.closest(".dc"); part = el.closest("[data-a]"); }
    if (!card) card = cards().find((c) => !c.hidden && c.getBoundingClientRect().bottom > y) || null;
    if (!card) return null;
    if (part && !card.contains(part)) part = null;
    const ref = part || card;
    return { k: card.dataset.k, a: part ? part.dataset.a : "", top: ref.getBoundingClientRect().top };
  }
  function restoreAnchor(a) {
    if (!a) return;
    const card = byKey(a.k);
    if (!card || card.hidden) return;
    let ref = a.a ? card.querySelector('[data-a="' + CSS.escape(a.a) + '"]') : null;
    if (ref && !ref.getClientRects().length) ref = null; // inside a closed <details>
    ref = ref || card;
    const d = ref.getBoundingClientRect().top - a.top;
    if (Math.abs(d) >= 1) scrollBy(0, d);
  }
  // Every DOM change goes through here.
  function steady(fn) {
    const a = anchor();
    const f = document.activeElement, fk = f && f.closest && f.closest(".dc") && f.closest(".dc").dataset.k;
    const sel = f && "selectionStart" in f ? [f.selectionStart, f.selectionEnd] : null;
    const fsel = f && f.classList && f.classList.contains("dnote-in") ? ".dnote-in" : null;
    fn();
    restoreAnchor(a);
    if (fk && fsel && document.activeElement !== f) { // the note you were typing in was swapped: keep the caret there
      const c = byKey(fk), t = c && c.querySelector(fsel);
      if (t) { t.focus({ preventScroll: true }); if (sel) try { t.setSelectionRange(sel[0], sel[1]); } catch (e) {} }
    }
  }
  let posT = 0;
  addEventListener("scroll", () => { clearTimeout(posT); posT = setTimeout(() => { st.pos = anchor(); st.posFilter = filter.status; save(); }, 200); }, { passive: true });

  // ----- a card's own state: note text, picks, chosen answer -----
  function hydrate(c) {
    const k = c.dataset.k;
    const t = c.querySelector(".dnote-in");
    if (t && st.notes[k]) t.value = st.notes[k];
    const picks = st.picks[k] || {};
    c.querySelectorAll(".opt[data-q]").forEach((b) => {
      const on = picks[b.dataset.q] === b.dataset.v;
      b.setAttribute("aria-pressed", String(on));
      if (on) b.dataset.picked = "true"; else delete b.dataset.picked;
    });
    times(c);
  }
  function insertCard(html, item) {
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    const c = tmp.firstElementChild;
    if (!c) return null;
    const old = byKey(c.dataset.k);
    if (old) {
      if (old.dataset.v === c.dataset.v) return old;
      const out = old.classList.contains("out");
      const open = Array.prototype.map.call(old.querySelectorAll("details"), (d) => d.open);
      old.replaceWith(c);
      c.querySelectorAll("details").forEach((d, i) => { if (open[i] !== undefined) d.open = open[i]; });
      if (out) c.classList.add("out");
    } else {
      // keep the order they were raised in: before the first card that is newer (server order)
      c.classList.add("fresh");
      setTimeout(() => c.classList.remove("fresh"), 4000);
      list.appendChild(c);
    }
    hydrate(c);
    if (item) {
      const t2 = document.createElement("ol");
      t2.innerHTML = item;
      const it = t2.firstElementChild, oldIt = itemByKey(c.dataset.k);
      if (oldIt) oldIt.replaceWith(it); else olist.appendChild(it);
      if (!old) { it.classList.add("fresh"); setTimeout(() => it.classList.remove("fresh"), 4000); }
    }
    return c;
  }
  // Puts cards and outline items in the order of `keys` (the server's), leaving unknown ones where they are.
  function order(keys) {
    let prev = null;
    keys.forEach((k) => {
      const c = byKey(k);
      if (!c) return;
      if (prev ? prev.nextElementSibling !== c : list.firstElementChild !== c) prev ? prev.after(c) : list.prepend(c);
      prev = c;
    });
    let pi = null;
    keys.forEach((k) => {
      const it = itemByKey(k);
      if (!it) return;
      if (pi ? pi.nextElementSibling !== it : olist.firstElementChild !== it) pi ? pi.after(it) : olist.prepend(it);
      pi = it;
    });
  }
  const inFilter = (status) => ({ open: ["open"], later: ["later"], answered: ["answered", "relayed"], closed: ["closed", "withdrawn"], all: null })[filter.status];
  function matches(status) { const f = inFilter(); return !f || f.indexOf(status) >= 0; }

  // ----- fetching -----
  const listUrl = () => "/decisions/part/list?status=" + encodeURIComponent(filter.status) + (PROJECT ? "&project=" + encodeURIComponent(PROJECT) : "");
  let listSeq = 0;
  // replace = a new filter (start over at the top); otherwise patch what is there and keep your place.
  async function refreshList(replace) {
    const seq = ++listSeq;
    let j;
    try { const r = await fetch(listUrl()); if (!r.ok) return; j = await r.json(); } catch (e) { return; }
    if (seq !== listSeq) return;
    counts = j.counts || counts;
    const tmp = document.createElement("div");
    tmp.innerHTML = j.html;
    const fresh = Array.prototype.slice.call(tmp.children);
    const its = document.createElement("ol");
    its.innerHTML = j.outline;
    const itemOf = {};
    Array.prototype.forEach.call(its.children, (it) => { itemOf[it.dataset.k] = it.outerHTML; });
    if (replace) {
      list.replaceChildren(...fresh);
      olist.replaceChildren(...Array.prototype.slice.call(its.children));
      fresh.forEach(hydrate);
      urgency(); applyFilter();
      scrollTo(0, 0);
      return;
    }
    steady(() => {
      const keys = fresh.map((c) => c.dataset.k);
      const want = new Set(keys);
      fresh.forEach((c) => insertCard(c.outerHTML, itemOf[c.dataset.k]));
      cards().forEach((c) => c.classList.toggle("out", !want.has(c.dataset.k)));
      order(keys);
      urgency(); applyFilter();
    });
  }
  const pending = new Map();
  // One card changed. A card that left the filter stays (dimmed) so nothing vanishes while you read.
  async function refreshCard(project, id) {
    const k = project + "/" + id;
    if (pending.has(k)) { pending.set(k, true); return; }
    pending.set(k, false);
    try {
      const r = await fetch("/decisions/part/card/" + encodeURIComponent(project) + "/" + encodeURIComponent(id) + (PROJECT ? "" : "?all=1"));
      if (r.status === 404) { const c = byKey(k); if (c) steady(() => { c.classList.add("out", "gone"); }); return; }
      if (!r.ok) return;
      const j = await r.json();
      const exists = !!byKey(k);
      if (!exists && !matches(j.status)) return;
      if (PROJECT && j.counts) counts = j.counts;
      steady(() => {
        const c = insertCard(j.html, j.item);
        if (c) c.classList.toggle("out", !matches(j.status));
        if (!exists) order(serverOrder(c));
        urgency(); applyFilter();
      });
      if (!PROJECT) refreshCounts();
    } catch (e) {} finally {
      const again = pending.get(k);
      pending.delete(k);
      if (again) refreshCard(project, id);
    }
  }
  // A new card goes where its raise time puts it. The raise time is in its header.
  function serverOrder(c) {
    const at = (x) => { const t = x.querySelector(".dm time"); return t ? t.getAttribute("datetime") : ""; };
    const nat = new Intl.Collator("en", { numeric: true });
    const all = cards().filter((x) => x !== c);
    const mine = at(c);
    const i = all.findIndex((x) => at(x) > mine || (at(x) === mine && nat.compare(x.dataset.k, c.dataset.k) > 0));
    if (i < 0) all.push(c); else all.splice(i, 0, c);
    return all.map((x) => x.dataset.k);
  }
  let countT = 0;
  function refreshCounts() {
    clearTimeout(countT);
    countT = setTimeout(async () => {
      try { const r = await fetch(listUrl()); if (r.ok) { counts = (await r.json()).counts || counts; drawCounts(); } } catch (e) {}
    }, 400);
  }

  // ----- live stream -----
  let es = null, catchUp = false;
  function connect() {
    es = new EventSource("/decisions/events" + (PROJECT ? "?project=" + encodeURIComponent(PROJECT) : ""));
    es.addEventListener("d", (ev) => { const d = JSON.parse(ev.data); refreshCard(d.project, d.id); });
    es.addEventListener("ref", (ev) => {
      const d = JSON.parse(ev.data);
      list.querySelectorAll('[data-ref="' + CSS.escape(d.project + "/" + d.id) + '"]').forEach((a) => {
        const c = a.closest(".dc"); if (c) refreshCard(c.dataset.project, c.dataset.id);
      });
    });
    es.addEventListener("all", () => refreshList(false));
    es.addEventListener("tick", () => { steady(() => { urgency(); applyFilter(); }); times(); });
    es.onerror = () => { catchUp = true; body.classList.add("offline"); };
    es.onopen = () => { body.classList.remove("offline"); if (catchUp) { catchUp = false; refreshList(false); } };
  }

  // ----- answers: artipeek's own sheet; only a real click on Send posts -----
  let sheet = null;
  function ask(o) {
    if (sheet) sheet.remove();
    const s = document.createElement("div");
    s.className = "answersheet"; s.setAttribute("role", "dialog"); s.setAttribute("aria-modal", "true");
    s.innerHTML = '<div class="box"><p class="q"></p><p class="aid"></p><pre class="atext"></pre><p class="afrom"></p><p class="amsg" aria-live="polite"></p><div class="btns"><button type="button" class="acancel">Cancel</button><button type="button" class="asend">Send</button></div></div>';
    s.querySelector(".q").textContent = o.kind === "explain" ? "Ask for an explainer page?" : "Send this answer?";
    s.querySelector(".aid").textContent = o.project + " · " + o.id;
    s.querySelector(".atext").textContent = o.text;
    s.querySelector(".afrom").textContent = o.kind === "explain" ? "The desk writes a page that shows this decision and its options, and links it here. The decision stays open." : "From the decisions page";
    const msg = s.querySelector(".amsg"), send = s.querySelector(".asend");
    const close = () => { s.remove(); if (sheet === s) sheet = null; };
    s.querySelector(".acancel").addEventListener("click", close);
    s.addEventListener("click", (ev) => { if (ev.target === s) close(); });
    s.addEventListener("keydown", (ev) => { if (ev.key === "Escape") close(); });
    send.addEventListener("click", async (ev) => {
      if (!ev.isTrusted || send.disabled) return;
      send.disabled = true; msg.textContent = "Saving…";
      try {
        const r = await fetch("/r/" + encodeURIComponent(o.project) + "/answer", { method: "POST", headers: { "Content-Type": "application/json", "X-Artipeek": "answer" }, body: JSON.stringify({ id: o.id, text: o.text, page: "artipeek:decisions", kind: o.kind }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) throw new Error(j.error || "HTTP " + r.status);
        msg.textContent = "Saved at " + new Date(j.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + ".";
        if (o.done) o.done();
        refreshCard(o.project, o.id);
        setTimeout(close, 1200);
      } catch (err) { msg.textContent = "Not saved: " + err.message; send.disabled = false; }
    });
    document.body.appendChild(s); sheet = s; send.focus();
  }
  const noteOf = (c) => { const t = c.querySelector(".dnote-in"); return t ? t.value.trim() : ""; };
  const clearNote = (c) => () => {
    const k = c.dataset.k;
    delete st.notes[k]; delete st.picks[k]; save();
    const cur = byKey(k), t = cur && cur.querySelector(".dnote-in");
    if (t) t.value = "";
  };
  function answerText(c, mode, v) {
    const n = noteOf(c);
    if (mode === "one") return n ? v + ": " + n : v;
    if (mode === "own") return n;
    if (mode === "picks") {
      const keys = [];
      c.querySelectorAll("fieldset.q[data-q]").forEach((f) => keys.push(f.dataset.q));
      const p = st.picks[c.dataset.k] || {};
      let got = 0;
      const s = keys.map((k) => { if (p[k]) got++; return k + " " + (p[k] || "—"); }).join(", ");
      if (!got) return n;
      return n ? s + ": " + n : s;
    }
    return "";
  }
  list.addEventListener("click", (e) => {
    const c = e.target.closest(".dc");
    if (!c) return;
    const k = c.dataset.k;
    const opt = e.target.closest(".opt");
    if (opt) {
      if (opt.dataset.q) { // a pick: toggles, nothing sent yet
        const p = st.picks[k] = st.picks[k] || {};
        p[opt.dataset.q] = p[opt.dataset.q] === opt.dataset.v ? "" : opt.dataset.v;
        save(); hydrate(c);
        return;
      }
      ask({ project: c.dataset.project, id: c.dataset.id, kind: "answer", text: answerText(c, "one", opt.dataset.v), done: clearNote(c) });
      return;
    }
    const btn = e.target.closest("[data-send],[data-own],[data-explain]");
    if (btn) {
      const t = c.querySelector(".dnote-in");
      if (btn.hasAttribute("data-explain")) {
        const n = noteOf(c);
        ask({ project: c.dataset.project, id: c.dataset.id, kind: "explain", text: "EXPLAIN: " + (n || "please make an explainer page for this decision and its options"), done: clearNote(c) });
        return;
      }
      const text = answerText(c, btn.hasAttribute("data-send") ? "picks" : "own");
      if (!text) { if (t) { t.focus(); t.classList.add("need"); setTimeout(() => t.classList.remove("need"), 1200); } return; }
      ask({ project: c.dataset.project, id: c.dataset.id, kind: "answer", text, done: clearNote(c) });
      return;
    }
    const x = e.target.closest("[data-xopen]");
    if (x) { viewer(x.dataset.xopen, x.dataset.xview, c); return; }
  });
  list.addEventListener("input", (e) => {
    const t = e.target;
    if (!t.classList || !t.classList.contains("dnote-in")) return;
    const c = t.closest(".dc");
    if (t.value) st.notes[c.dataset.k] = t.value; else delete st.notes[c.dataset.k];
    save();
  });

  // ----- links: refs scroll (or peek), .html files open in the viewer, the rest in a new tab -----
  function scrollToCard(c, push) {
    c.scrollIntoView({ behavior: "smooth", block: "start" });
    c.classList.remove("flash"); void c.offsetWidth; c.classList.add("flash");
    if (push) history.replaceState(null, "", location.pathname + location.search + "#" + c.id);
    closeOutline();
  }
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const ref = e.target.closest("a.ref[data-ref], a.did");
    if (ref) {
      const k = ref.dataset.ref || ref.closest(".dc").dataset.k;
      const c = byKey(k);
      e.preventDefault();
      if (c && !c.hidden && !(peekEl && peekEl.contains(ref))) scrollToCard(c, true);
      else peek(k);
      return;
    }
    const oi = e.target.closest(".oi a");
    if (oi) {
      e.preventDefault();
      const c = byKey(oi.parentElement.dataset.k);
      if (c) scrollToCard(c, true);
      return;
    }
    const v = e.target.closest("a[data-viewer]");
    if (v) {
      e.preventDefault();
      const u = new URL(v.href);
      const raw = u.pathname.replace(/^(\/r\/[^/]+)\/view\//, "$1/raw/");
      viewer(raw + u.hash, raw.replace(/^(\/r\/[^/]+)\/raw\//, "$1/view/"), v.closest(".dc"));
    }
  });

  // A decision that isn't in the list (another filter or project): show it on top, without moving the list.
  let peekEl = null;
  async function peek(k) {
    const i = k.indexOf("/");
    const r = await fetch("/decisions/part/card/" + encodeURIComponent(k.slice(0, i)) + "/" + encodeURIComponent(k.slice(i + 1)) + "?all=1").catch(() => null);
    if (peekEl) peekEl.remove();
    const o = document.createElement("div");
    o.className = "peek"; o.setAttribute("role", "dialog"); o.setAttribute("aria-modal", "true");
    o.innerHTML = '<div class="pbox"><div class="pbar"><b></b><button type="button" class="pclose" aria-label="Close">×</button></div><div class="pbody"></div></div>';
    o.querySelector(".pbar b").textContent = k.replace("/", " · ");
    const pb = o.querySelector(".pbody");
    if (r && r.ok) { pb.innerHTML = (await r.json()).html; const c = pb.firstElementChild; if (c) { c.removeAttribute("id"); c.classList.add("inpeek"); hydratePeek(c); } }
    else pb.textContent = "This decision is not in the hub (or not visible here).";
    const close = () => { o.remove(); if (peekEl === o) peekEl = null; };
    o.querySelector(".pclose").addEventListener("click", close);
    o.addEventListener("click", (ev) => { if (ev.target === o) close(); });
    o.addEventListener("keydown", (ev) => { if (ev.key === "Escape") close(); });
    document.body.appendChild(o); peekEl = o;
    o.querySelector(".pclose").focus();
  }
  function hydratePeek(c) {
    times(c);
    c.addEventListener("click", (e) => { // same buttons as in the list
      const opt = e.target.closest(".opt"), btn = e.target.closest("[data-send],[data-own],[data-explain]");
      if (!opt && !btn) return;
      e.stopPropagation();
      const k = c.dataset.k;
      if (opt && opt.dataset.q) {
        const p = st.picks[k] = st.picks[k] || {};
        p[opt.dataset.q] = p[opt.dataset.q] === opt.dataset.v ? "" : opt.dataset.v;
        c.querySelectorAll('.opt[data-q="' + CSS.escape(opt.dataset.q) + '"]').forEach((b) => b.setAttribute("aria-pressed", String(p[opt.dataset.q] === b.dataset.v)));
        save(); return;
      }
      const base = { project: c.dataset.project, id: c.dataset.id, done: () => { const t = c.querySelector(".dnote-in"); if (t) t.value = ""; delete st.picks[k]; save(); } };
      if (opt) ask(Object.assign(base, { kind: "answer", text: answerText(c, "one", opt.dataset.v) }));
      else if (btn.hasAttribute("data-explain")) ask(Object.assign(base, { kind: "explain", text: "EXPLAIN: " + (noteOf(c) || "please make an explainer page for this decision and its options") }));
      else { const t = answerText(c, btn.hasAttribute("data-send") ? "picks" : "own"); if (t) ask(Object.assign(base, { kind: "answer", text: t })); }
    });
  }

  // ----- explainer viewer: the page in artipeek's sandboxed frame, over the list -----
  let vw = null;
  function viewer(raw, view, card) {
    if (vw) vw.remove();
    const o = document.createElement("div");
    o.className = "xview"; o.setAttribute("role", "dialog"); o.setAttribute("aria-modal", "true");
    o.innerHTML = '<div class="xbar"><b class="xt"></b><a class="xnew" target="_blank" rel="noopener">open in a tab</a><button type="button" class="xclose" aria-label="Close">×</button></div><iframe sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>';
    o.querySelector(".xt").textContent = (card ? card.dataset.id + " · " : "") + decodeURIComponent(raw.replace(/^\/r\/[^/]+\/raw\//, "").replace(/#.*$/, ""));
    o.querySelector(".xnew").href = view;
    const f = o.querySelector("iframe");
    f.src = raw;
    const close = () => { o.remove(); if (vw === o) vw = null; };
    o.querySelector(".xclose").addEventListener("click", close);
    o.addEventListener("keydown", (ev) => { if (ev.key === "Escape") close(); });
    o._project = (/^\/r\/([^/]+)\//.exec(raw) || [])[1];
    document.body.appendChild(o); vw = o;
    o.querySelector(".xclose").focus();
  }
  addEventListener("message", (e) => {
    const f = vw && vw.querySelector("iframe");
    if (!f || e.source !== f.contentWindow || !e.data) return;
    if (e.data.artipeek === "open" && typeof e.data.href === "string") { // a link inside the explainer
      let u; try { u = new URL(e.data.href); } catch (x) { return; }
      if (u.origin !== location.origin) return;
      if (/\/raw\/.+\.html?$/i.test(u.pathname) || /\/view\/.+\.html?$/i.test(u.pathname)) {
        const raw = u.pathname.replace(/^(\/r\/[^/]+)\/view\//, "$1/raw/");
        f.src = raw + u.hash;
        vw.querySelector(".xnew").href = raw.replace(/^(\/r\/[^/]+)\/raw\//, "$1/view/");
      } else window.open(u.href, "_blank", "noopener");
      return;
    }
    if (e.data.artipeek === "answer") { // an answer button inside the explainer: same sheet, same checks
      const id = String(e.data.id || ""), text = String(e.data.text || "").trim();
      if (!/^[A-Za-z][A-Za-z0-9._-]{0,31}$/.test(id) || !text || text.length > 2000 || !vw._project) return;
      let p = vw._project; try { p = decodeURIComponent(p); } catch (x) {}
      ask({ project: p, id, kind: "answer", text, done: () => { try { f.contentWindow.postMessage({ artipeek: "answer-saved", id, text, at: new Date().toISOString(), uid: "" }, "*"); } catch (x) {} } });
    }
  });

  // ----- outline: current card follows the scroll; a drawer on the phone -----
  function closeOutline() { body.classList.remove("outline-open"); }
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-outline]")) { body.classList.toggle("outline-open"); return; }
    const sb = e.target.closest("button[data-status]");
    if (sb) { if (sb.dataset.status !== filter.status) { filter.status = sb.dataset.status; setUrl(); refreshList(true); } return; }
    if (e.target.closest("button[data-urgent]")) { filter.urgent = !filter.urgent; setUrl(); applyFilter(); scrollTo(0, 0); return; }
    const pb = e.target.closest("button[data-project]");
    if (pb) { filter.project = pb.dataset.project; setUrl(); applyFilter(); scrollTo(0, 0); return; }
  });
  addEventListener("keydown", (e) => { if (e.key === "Escape") closeOutline(); });
  let spyT = 0;
  function spy() {
    const a = anchor();
    olist.querySelectorAll(".oi.cur").forEach((x) => x.classList.remove("cur"));
    const it = a && itemByKey(a.k);
    if (!it) return;
    it.classList.add("cur");
    const box = olist.parentElement;
    if (it.offsetTop < box.scrollTop + 30 || it.offsetTop > box.scrollTop + box.clientHeight - 40) box.scrollTop = it.offsetTop - box.clientHeight / 3;
  }
  addEventListener("scroll", () => { if (!spyT) spyT = requestAnimationFrame(() => { spyT = 0; spy(); }); }, { passive: true });

  // ----- start -----
  const topVar = () => body.style.setProperty("--dtoph", Math.round(top.getBoundingClientRect().height) + 12 + "px");
  topVar(); addEventListener("resize", topVar);
  cards().forEach(hydrate);
  urgency(); applyFilter(); times();
  setInterval(() => times(), 30_000);
  setUrl();
  const h = location.hash && decodeURIComponent(location.hash.slice(1));
  const target = h && document.getElementById(h);
  if (target && target.classList.contains("dc")) { if (target.hidden) { filter.project = ""; filter.urgent = false; applyFilter(); } target.scrollIntoView({ block: "start" }); target.classList.add("flash"); }
  else if (st.pos && st.posFilter === filter.status) {
    // back after a reload: same card, same spot
    const want = st.pos, c = byKey(want.k);
    if (c) { scrollTo(0, scrollY + c.getBoundingClientRect().top - topH()); restoreAnchor(want); }
  }
  spy();
  if (!CAN) body.classList.add("readonly");
  connect();
})();
