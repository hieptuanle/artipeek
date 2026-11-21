// artipeek decision hub: the Decisions tab, and the Actions tab (same pane shape; the pane's data-kind="act",
// data-base="/actions" and data-filters say which). The app (client/app.js) mounts it on the tab's pane:
//   const ctl = window.artipeekDecisions.mount(pane, { active: () => bool, setQuery: (q) => void })
//   ctl.event(name, data)   live events from artipeek's stream: d, ref, all, tick
//   ctl.onHide() / ctl.onShow(first) / ctl.apply(query) / ctl.jump(key) / ctl.destroy()
// - Live: a change patches only that card (no reload, no white flash).
// - Your place is locked: before a patch we note which part of which card sits under the top bar and where; after
//   it we scroll by the difference. A card that leaves the filter stays, dimmed, until you change the filter.
// - Filters (status, urgent, project) are the server's: a page of 30 at a time, more when you reach the end.
// - Typed notes and per-question picks live here (and in sessionStorage), so patches and reloads keep them.
(() => {
  const URGENT_MS = 24 * 3600 * 1000;
  const p2 = (n) => String(n).padStart(2, "0");
  const fmt = (d) => p2(d.getDate()) + "/" + p2(d.getMonth() + 1) + " " + p2(d.getHours()) + ":" + p2(d.getMinutes());
  function rel(ms) {
    const a = Math.abs(ms), m = Math.round(a / 60000);
    const s = m < 60 ? m + "m" : m < 48 * 60 ? Math.round(m / 60) + "h" : Math.round(m / 1440) + "d";
    return ms >= 0 ? "in " + s : s + " ago";
  }
  function times(scope) {
    const now = Date.now();
    scope.querySelectorAll("time[data-ts]").forEach((t) => {
      const d = new Date(t.getAttribute("datetime"));
      if (isNaN(d)) return;
      t.textContent = fmt(d) + (t.hasAttribute("data-rel") ? " (" + rel(d - now) + ")" : "");
      t.title = d.toString();
      if (t.hasAttribute("data-rel")) t.classList.toggle("past", d < now);
    });
  }

  function mount(pane, app) {
    const root = pane.querySelector(".dpane");
    if (!root) return null;
    const body = document.body;
    const KIND = root.dataset.kind || "dec", BASE = root.dataset.base || "/decisions";
    let STATUSES = { open: ["open"], later: ["later"], answered: ["answered", "relayed"], closed: ["closed", "withdrawn"], all: null };
    try { if (root.dataset.filters) STATUSES = JSON.parse(root.dataset.filters); } catch (e) {}
    const NEWEST_FIRST = {};
    (root.dataset.newest || "answered,closed,all").split(",").forEach((k) => { NEWEST_FIRST[k] = 1; });
    const SKEY = "artipeek-" + KIND;
    const $ = (s) => root.querySelector(s);
    const list = $(".dlist"), olist = $(".olist"), top = $(".dtop"), empty = $(".dempty"), oempty = $(".oempty"), moreBox = $(".dmorebox");
    const CAN = root.dataset.can === "1";
    const filter = { status: root.dataset.status || "open", urgent: root.dataset.urgent === "1", project: root.dataset.project || "" };
    let next = root.dataset.next === "" ? null : Number(root.dataset.next);
    let emptyText = empty.textContent;
    let counts = {};
    try { counts = JSON.parse($(".dcounts").textContent || "{}"); } catch (e) {}
    let st = {};
    try { st = JSON.parse(sessionStorage.getItem(SKEY) || "{}") || {}; } catch (e) { st = {}; }
    st.notes = st.notes || {}; st.picks = st.picks || {};
    let saveT = 0;
    const save = () => { clearTimeout(saveT); saveT = setTimeout(() => { try { sessionStorage.setItem(SKEY, JSON.stringify(st)); } catch (e) {} }, 150); };
    const query = () => {
      const q = new URLSearchParams();
      q.set("status", filter.status);
      if (filter.urgent) q.set("urgent", "1");
      if (filter.project) q.set("project", filter.project);
      return q.toString();
    };
    const visibleNow = () => app.active() && !pane.hidden;
    const cards = () => Array.prototype.slice.call(list.children).filter((c) => c.classList.contains("dc"));
    const byKey = (k) => list.querySelector('.dc[data-k="' + CSS.escape(k) + '"]');
    const itemByKey = (k) => olist.querySelector('.oi[data-k="' + CSS.escape(k) + '"]');
    const topH = () => Math.max(0, top.getBoundingClientRect().bottom);
    const newestFirst = () => !!NEWEST_FIRST[filter.status];
    const loaded = () => cards().filter((c) => !c.classList.contains("out")).length;

    // ----- urgency highlight (the flag, or a deadline under 24 h / past, while open) -----
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
    function drawEmpty() {
      const n = cards().length;
      empty.hidden = n > 0; oempty.hidden = n > 0;
      empty.textContent = oempty.textContent = emptyText;
      moreBox.hidden = next === null;
    }
    function drawCounts() {
      const ps = filter.project ? [filter.project] : Object.keys(counts);
      const sum = (k) => ps.reduce((n, p) => n + ((counts[p] || {})[k] || 0), 0);
      root.querySelectorAll("[data-count]").forEach((i) => { const v = sum(i.dataset.count); i.textContent = v ? String(v) : ""; });
      root.querySelectorAll("[data-pcount]").forEach((i) => {
        const c = counts[i.dataset.pcount] || {};
        const v = c[filter.status] || 0;
        i.textContent = v ? String(v) : "";
        i.classList.toggle("hot", !!c.urgent);
      });
      root.querySelectorAll("button[data-status]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.status === filter.status)));
      root.querySelectorAll("button[data-urgent]").forEach((b) => b.setAttribute("aria-pressed", String(filter.urgent)));
      root.querySelectorAll(".pjs button[data-project]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.project === filter.project)));
    }

    // ----- your place -----
    // The part of a card under the top bar (header, context, an update, the questions…) and its distance from the
    // bar's bottom edge (not the window's top: the tab bar may come or go while this tab is hidden).
    function anchor() {
      if (!visibleNow()) return null;
      const y = topH() + 6;
      const r = list.getBoundingClientRect();
      const x = r.left + Math.min(40, r.width / 2);
      let card = null, part = null;
      const el = document.elementFromPoint(x, Math.min(y, innerHeight - 1));
      if (el && list.contains(el)) { card = el.closest(".dc"); part = el.closest("[data-a]"); }
      if (!card) card = cards().find((c) => c.getBoundingClientRect().bottom > y) || null;
      if (!card) return null;
      if (part && !card.contains(part)) part = null;
      const ref = part || card;
      return { k: card.dataset.k, a: part ? part.dataset.a : "", top: ref.getBoundingClientRect().top - topH() };
    }
    function restoreAnchor(a) {
      if (!a || !visibleNow()) return;
      const card = byKey(a.k);
      if (!card) return;
      let ref = a.a ? card.querySelector('[data-a="' + CSS.escape(a.a) + '"]') : null;
      if (ref && !ref.getClientRects().length) ref = null; // inside a closed <details>
      ref = ref || card;
      const d = ref.getBoundingClientRect().top - topH() - a.top;
      if (Math.abs(d) >= 1) scrollBy(0, d);
    }
    // Every DOM change goes through here.
    function steady(fn) {
      const a = anchor();
      const f = document.activeElement;
      const fc = f && root.contains(f) && f.classList && f.classList.contains("dnote-in") ? f.closest(".dc") : null;
      const sel = fc && "selectionStart" in f ? [f.selectionStart, f.selectionEnd] : null;
      fn();
      restoreAnchor(a);
      if (fc && document.activeElement !== f) { // the note you were typing in was swapped: keep the caret there
        const c = byKey(fc.dataset.k), t = c && c.querySelector(".dnote-in");
        if (t) { t.focus({ preventScroll: true }); if (sel) try { t.setSelectionRange(sel[0], sel[1]); } catch (e) {} }
      }
    }

    // ----- a card's own state: note text, picks -----
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
    const frag = (html, tag) => { const t = document.createElement(tag || "div"); t.innerHTML = html; return t; };
    // Is a card with this raise time inside the range of cards we have? (Else it comes with "Show more".)
    function inRange(created) {
      if (next === null) return true;
      const cs = cards().filter((c) => !c.classList.contains("out"));
      if (!cs.length) return true;
      const last = cs[cs.length - 1].dataset.created;
      return newestFirst() ? created >= last : created <= last;
    }
    // Before which card a new one goes: the server's order (raise time, then D2 before D10).
    const nat = new Intl.Collator("en", { numeric: true });
    function placeOf(c) {
      const cmp = (x) => { const a = c.dataset.created, b = x.dataset.created; return a < b ? -1 : a > b ? 1 : nat.compare(c.dataset.k, x.dataset.k); };
      return cards().find((x) => x !== c && (newestFirst() ? cmp(x) > 0 : cmp(x) < 0)) || null;
    }
    function putCard(html, item) {
      const c = frag(html).firstElementChild;
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
        list.insertBefore(c, placeOf(c));
        c.classList.add("fresh");
        setTimeout(() => c.classList.remove("fresh"), 4000);
      }
      hydrate(c);
      if (item) {
        const it = frag(item, "ol").firstElementChild, oldIt = itemByKey(c.dataset.k);
        if (oldIt) oldIt.replaceWith(it);
        else {
          const nc = c.nextElementSibling, ni = nc && nc.classList.contains("dc") ? itemByKey(nc.dataset.k) : null;
          olist.insertBefore(it, ni);
          it.classList.add("fresh"); setTimeout(() => it.classList.remove("fresh"), 4000);
        }
      }
      return c;
    }
    const matches = (j) => {
      const f = STATUSES[filter.status];
      if (f && f.indexOf(j.status) < 0) return false;
      if (filter.project && j.project !== filter.project) return false;
      if (filter.urgent && !j.urgent) return false;
      return true;
    };

    // ----- fetching -----
    const listUrl = (offset, limit) => BASE + "/part/list?" + query() + "&offset=" + offset + (limit ? "&limit=" + limit : "");
    let listSeq = 0;
    // replace = a new filter (start over at the top); otherwise patch what is there and keep your place.
    async function refreshList(replace) {
      const seq = ++listSeq;
      let j;
      try { const r = await fetch(listUrl(0, replace ? 0 : Math.min(200, Math.max(30, loaded())))); if (!r.ok) return; j = await r.json(); } catch (e) { return; }
      if (seq !== listSeq) return;
      counts = j.counts || counts; next = j.next; emptyText = j.empty || emptyText;
      const fresh = Array.prototype.slice.call(frag(j.html).children);
      const items = {};
      Array.prototype.forEach.call(frag(j.outline, "ol").children, (it) => { items[it.dataset.k] = it.outerHTML; });
      if (replace) {
        list.replaceChildren(...fresh);
        olist.replaceChildren(...Array.prototype.slice.call(frag(j.outline, "ol").children));
        fresh.forEach(hydrate);
        urgency(); drawCounts(); drawEmpty();
        if (visibleNow()) scrollTo(0, 0);
        return;
      }
      steady(() => {
        const want = new Set(fresh.map((c) => c.dataset.k));
        fresh.forEach((c) => putCard(c.outerHTML, items[c.dataset.k]));
        cards().forEach((c) => c.classList.toggle("out", !want.has(c.dataset.k)));
        urgency(); drawCounts(); drawEmpty();
      });
    }
    let moreBusy = false;
    async function loadMore() {
      if (next === null || moreBusy) return;
      moreBusy = true;
      try {
        const r = await fetch(listUrl(loaded()));
        if (!r.ok) return;
        const j = await r.json();
        counts = j.counts || counts; next = j.next;
        const items = {};
        Array.prototype.forEach.call(frag(j.outline, "ol").children, (it) => { items[it.dataset.k] = it.outerHTML; });
        steady(() => {
          Array.prototype.slice.call(frag(j.html).children).forEach((c) => {
            if (byKey(c.dataset.k)) { putCard(c.outerHTML, items[c.dataset.k]); return; }
            list.appendChild(c); hydrate(c);
            const it = frag(items[c.dataset.k] || "", "ol").firstElementChild;
            if (it) olist.appendChild(it);
          });
          urgency(); drawCounts(); drawEmpty();
        });
      } catch (e) {} finally { moreBusy = false; }
    }
    const pending = new Map();
    // One card changed. A card that left the filter stays (dimmed) so nothing vanishes while you read.
    async function refreshCard(project, id) {
      const k = project + "/" + id;
      if (pending.has(k)) { pending.set(k, true); return; }
      pending.set(k, false);
      try {
        const r = await fetch(BASE + "/part/card/" + encodeURIComponent(project) + "/" + encodeURIComponent(id));
        if (r.status === 404) { const c = byKey(k); if (c) steady(() => c.classList.add("out", "gone")); return; }
        if (!r.ok) return;
        const j = await r.json();
        j.project = project;
        counts = j.counts || counts;
        const exists = !!byKey(k);
        if (!exists && (!matches(j) || !inRange(j.created))) { drawCounts(); return; }
        steady(() => {
          const c = putCard(j.html, j.item);
          if (c) c.classList.toggle("out", !matches(j));
          urgency(); drawCounts(); drawEmpty();
        });
      } catch (e) {} finally {
        const again = pending.get(k);
        pending.delete(k);
        if (again) refreshCard(project, id);
      }
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
    function answerText(c, mode, v) {
      const n = noteOf(c);
      if (mode === "one") return n ? v + ": " + n : v;
      if (mode === "own") return n;
      const keys = [];
      c.querySelectorAll("fieldset.q[data-q]").forEach((f) => keys.push(f.dataset.q));
      const p = st.picks[c.dataset.k] || {};
      let got = 0;
      const s = keys.map((k) => { if (p[k]) got++; return k + " " + (p[k] || "—"); }).join(", ");
      if (!got) return n;
      return n ? s + ": " + n : s;
    }
    // The buttons of a card (in the list, or shown on top in a peek). True when the click was one of them.
    function cardClick(e, c, inPeek) {
      if (KIND === "act") return actClick(e, c, inPeek);
      const k = c.dataset.k;
      const opt = e.target.closest(".opt");
      const btn = e.target.closest("[data-send],[data-own],[data-explain]");
      if (!opt && !btn) return false;
      const clear = () => {
        delete st.notes[k]; delete st.picks[k]; save();
        [byKey(k), inPeek ? c : null].forEach((x) => { const t = x && x.querySelector(".dnote-in"); if (t) t.value = ""; });
      };
      const base = { project: c.dataset.project, id: c.dataset.id, done: clear };
      if (opt && opt.dataset.q) { // a pick: toggles, nothing sent yet
        const p = st.picks[k] = st.picks[k] || {};
        p[opt.dataset.q] = p[opt.dataset.q] === opt.dataset.v ? "" : opt.dataset.v;
        save(); hydrate(c);
        const lc = byKey(k); if (lc && lc !== c) hydrate(lc);
        return true;
      }
      if (opt) { ask(Object.assign(base, { kind: "answer", text: answerText(c, "one", opt.dataset.v) })); return true; }
      if (btn.hasAttribute("data-explain")) {
        ask(Object.assign(base, { kind: "explain", text: "EXPLAIN: " + (noteOf(c) || "please make an explainer page for this decision and its options") }));
        return true;
      }
      const text = answerText(c, btn.hasAttribute("data-send") ? "picks" : "own");
      const t = c.querySelector(".dnote-in");
      if (!text) { if (t) { t.focus(); t.classList.add("need"); setTimeout(() => t.classList.remove("need"), 1200); } return true; }
      ask(Object.assign(base, { kind: "answer", text }));
      return true;
    }

    // ----- actions: tick a step (sent at once, no sheet: a slip is unticked as easily), "I've done all the steps" and
    // "Ask the agent to do it" (artipeek's own sheet). Only real clicks count.
    function post(o) {
      return fetch("/r/" + encodeURIComponent(o.project) + "/action", { method: "POST", headers: { "Content-Type": "application/json", "X-Artipeek": "action" }, body: JSON.stringify({ id: o.id, op: o.op, step: o.step, note: o.note }) })
        .then((r) => r.json().catch(() => ({})).then((j) => { if (!r.ok || !j.ok) throw new Error(j.error || "HTTP " + r.status); return j; }));
    }
    function flashMsg(c, text) {
      let m = c.querySelector(".amsg");
      if (!m) { m = document.createElement("p"); m.className = "amsg"; m.setAttribute("aria-live", "polite"); const b = c.querySelector(".aacts") || c; b.appendChild(m); }
      m.textContent = text;
    }
    function askAct(o) {
      if (sheet) sheet.remove();
      const s = document.createElement("div");
      s.className = "answersheet"; s.setAttribute("role", "dialog"); s.setAttribute("aria-modal", "true");
      s.innerHTML = '<div class="box"><p class="q"></p><p class="aid"></p><pre class="atext"></pre><p class="afrom"></p><p class="amsg" aria-live="polite"></p><div class="btns"><button type="button" class="acancel">Cancel</button><button type="button" class="asend">Send</button></div></div>';
      s.querySelector(".q").textContent = o.op === "all" ? "Mark every step done?" : "Ask the agent to do it?";
      s.querySelector(".aid").textContent = o.project + " · " + o.id + " · " + o.title;
      const t = s.querySelector(".atext");
      t.textContent = o.text; if (!o.text) t.hidden = true;
      s.querySelector(".afrom").textContent = o.op === "all" ? "The agent checks each step, then closes the action." : "The agent tries to do it for you, and tells you here if it can't.";
      const msg = s.querySelector(".amsg"), send = s.querySelector(".asend");
      const close = () => { s.remove(); if (sheet === s) sheet = null; };
      s.querySelector(".acancel").addEventListener("click", close);
      s.addEventListener("click", (ev) => { if (ev.target === s) close(); });
      s.addEventListener("keydown", (ev) => { if (ev.key === "Escape") close(); });
      send.addEventListener("click", async (ev) => {
        if (!ev.isTrusted || send.disabled) return;
        send.disabled = true; msg.textContent = "Sending…";
        try {
          await post(o);
          msg.textContent = "Sent to the agent.";
          if (o.done) o.done();
          refreshCard(o.project, o.id);
          setTimeout(close, 1000);
        } catch (err) { msg.textContent = "Not sent: " + err.message; send.disabled = false; }
      });
      document.body.appendChild(s); sheet = s; send.focus();
    }
    function actClick(e, c, inPeek) {
      const k = c.dataset.k;
      const tick = e.target.closest("[data-tick]");
      const btn = e.target.closest("[data-all],[data-agent]");
      if (!tick && !btn) return false;
      if (!e.isTrusted) return true;
      if (!CAN) { flashMsg(c, "This device can't send. Use the public link (login) or an answer device."); return true; }
      const base = { project: c.dataset.project, id: c.dataset.id, title: (c.querySelector(".dt") || {}).textContent || "" };
      if (tick) {
        if (tick.disabled || tick.dataset.busy) return true;
        const on = tick.getAttribute("aria-checked") !== "true";
        tick.dataset.busy = "1"; tick.setAttribute("aria-checked", String(on));
        post(Object.assign(base, { op: on ? "tick" : "untick", step: Number(tick.dataset.tick) }))
          .catch((err) => { tick.setAttribute("aria-checked", String(!on)); flashMsg(c, "Not saved: " + err.message); })
          .then(() => { delete tick.dataset.busy; refreshCard(base.project, base.id); });
        return true;
      }
      const note = noteOf(c);
      const clear = () => { delete st.notes[k]; save(); [byKey(k), inPeek ? c : null].forEach((x) => { const t = x && x.querySelector(".dnote-in"); if (t) t.value = ""; }); };
      if (btn.hasAttribute("data-all")) {
        const left = Array.prototype.filter.call(c.querySelectorAll(".as"), (li) => li.classList.contains("as-todo"))
          .map((li) => li.dataset.n + ". " + ((li.querySelector(".asb .markdown") || {}).textContent || "").trim().split("\n")[0].slice(0, 120));
        askAct(Object.assign(base, { op: "all", note: note, done: clear, text: left.join("\n") + (note ? "\n\nNote: " + note : "") }));
      } else askAct(Object.assign(base, { op: "agent", note: note, done: clear, text: note ? "Note: " + note : "" }));
      return true;
    }

    // ----- navigation inside the tab: refs scroll (or peek), outline rows scroll -----
    function scrollToCard(c) {
      c.scrollIntoView({ behavior: "smooth", block: "start" });
      c.classList.remove("flash"); void c.offsetWidth; c.classList.add("flash");
      body.classList.remove("outline-open");
    }
    let peekEl = null;
    // A decision that isn't in the list (another filter or project): show it on top, without moving the list.
    async function peek(k) {
      const i = k.indexOf("/");
      const r = await fetch(BASE + "/part/card/" + encodeURIComponent(k.slice(0, i)) + "/" + encodeURIComponent(k.slice(i + 1))).catch(() => null);
      if (peekEl) peekEl.remove();
      const o = document.createElement("div");
      o.className = "peek"; o.setAttribute("role", "dialog"); o.setAttribute("aria-modal", "true");
      o.innerHTML = '<div class="pbox"><div class="pbar"><b></b><button type="button" class="pclose" aria-label="Close">×</button></div><div class="pbody"></div></div>';
      o.querySelector(".pbar b").textContent = k.replace("/", " · ");
      const pb = o.querySelector(".pbody");
      if (r && r.ok) {
        pb.innerHTML = (await r.json()).html;
        const c = pb.firstElementChild;
        if (c) {
          c.removeAttribute("id"); c.classList.add("inpeek");
          const t = c.querySelector(".dnote-in"); if (t) t.removeAttribute("id");
          hydrate(c);
        }
      } else pb.textContent = (KIND === "act" ? "This action" : "This decision") + " is not in the hub (or not visible here).";
      const close = () => { o.remove(); if (peekEl === o) peekEl = null; };
      o.querySelector(".pclose").addEventListener("click", close);
      o.addEventListener("click", (ev) => {
        if (ev.target === o) return close();
        const c = pb.firstElementChild;
        if (c && c.contains(ev.target) && cardClick(ev, c, true)) return;
        const rf = ev.target.closest("a.ref[data-ref], a.did");
        if (rf) { ev.preventDefault(); const k2 = rf.dataset.ref || k; const lc = byKey(k2); if (lc) { close(); scrollToCard(lc); } else if (k2 !== k) peek(k2); return; }
        if (ev.target.closest("a[href]")) close(); // a file link: the app opens it as a tab
      });
      o.addEventListener("keydown", (ev) => { if (ev.key === "Escape") close(); });
      document.body.appendChild(o); peekEl = o;
      o.querySelector(".pclose").focus();
    }

    function onClick(e) {
      if (e.defaultPrevented || e.button || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      const t = e.target;
      if (t.closest("[data-outline]")) { body.classList.toggle("outline-open"); return; }
      const sb = t.closest("button[data-status]");
      if (sb) { if (sb.dataset.status !== filter.status) { filter.status = sb.dataset.status; changed(); } return; }
      if (t.closest("button[data-urgent]")) { filter.urgent = !filter.urgent; changed(); return; }
      const pb = t.closest(".pjs button[data-project]");
      if (pb) { if (pb.dataset.project !== filter.project) { filter.project = pb.dataset.project; changed(); } return; }
      if (t.closest("[data-more]")) { loadMore(); return; }
      const pj = t.closest("a.pj[data-project]");
      if (pj) { e.preventDefault(); if (filter.project !== pj.dataset.project) { filter.project = pj.dataset.project; changed(); } return; }
      const ref = t.closest("a.ref[data-ref], a.did");
      if (ref) {
        e.preventDefault();
        const k = ref.dataset.ref || ref.closest(".dc").dataset.k;
        const c = byKey(k);
        if (c) scrollToCard(c); else peek(k);
        return;
      }
      const oi = t.closest(".oi a");
      if (oi) { e.preventDefault(); const c = byKey(oi.parentElement.dataset.k); if (c) scrollToCard(c); return; }
      const c = t.closest(".dc");
      if (c && list.contains(c)) cardClick(e, c, false);
    }
    function onInput(e) {
      const t = e.target;
      if (!t.classList || !t.classList.contains("dnote-in")) return;
      const c = t.closest(".dc");
      if (!c) return;
      if (t.value) st.notes[c.dataset.k] = t.value; else delete st.notes[c.dataset.k];
      save();
    }
    function changed() {
      app.setQuery(query());
      body.classList.remove("outline-open");
      refreshList(true);
    }

    // ----- outline: the current card follows the scroll -----
    let spyT = 0, posT = 0;
    function spy() {
      if (!visibleNow()) return;
      const a = anchor();
      olist.querySelectorAll(".oi.cur").forEach((x) => x.classList.remove("cur"));
      const it = a && itemByKey(a.k);
      if (!it) return;
      it.classList.add("cur");
      const box = olist.parentElement;
      if (it.offsetTop < box.scrollTop + 30 || it.offsetTop > box.scrollTop + box.clientHeight - 40) box.scrollTop = it.offsetTop - box.clientHeight / 3;
    }
    function onScroll() {
      if (!visibleNow()) return;
      if (!spyT) spyT = requestAnimationFrame(() => { spyT = 0; spy(); });
      clearTimeout(posT);
      posT = setTimeout(() => { st.pos = anchor(); st.posQ = query(); save(); }, 200);
    }
    const topVar = () => { if (visibleNow()) root.style.setProperty("--dtoph", Math.round(top.getBoundingClientRect().height) + "px"); };
    // "Show more" by itself when it comes near the screen
    const io = "IntersectionObserver" in window ? new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting) && visibleNow()) loadMore(); }, { rootMargin: "400px" }) : null;
    if (io) io.observe(moreBox);

    root.addEventListener("click", onClick);
    root.addEventListener("input", onInput);
    addEventListener("scroll", onScroll, { passive: true });
    addEventListener("resize", topVar);
    const timer = setInterval(() => times(root), 30_000);
    list.querySelectorAll(".dc").forEach(hydrate);
    urgency(); drawCounts(); drawEmpty(); times(root);
    if (!CAN) root.classList.add("readonly");

    let hidden = null; // where you were when the tab was hidden
    return {
      event(name, data) {
        if (name === "d") refreshCard(data.project, data.id);
        else if (name === "ref") list.querySelectorAll('[data-ref="' + CSS.escape(data.project + "/" + data.id) + '"]').forEach((a) => { const c = a.closest(".dc"); if (c) refreshCard(c.dataset.project, c.dataset.id); });
        else if (name === "all") refreshList(false);
        else if (name === "tick") { steady(urgency); times(root); if (filter.urgent) refreshList(false); }
      },
      onHide() { hidden = anchor(); body.classList.remove("outline-open"); },
      onShow(first) {
        topVar();
        const want = hidden || (first && st.pos && st.posQ === query() ? st.pos : null);
        hidden = null;
        if (want) {
          const c = byKey(want.k);
          if (c && first) scrollTo(0, scrollY + c.getBoundingClientRect().top - topH());
          restoreAnchor(want);
        }
        spy();
      },
      // /decisions?… was opened with other filters while the tab was already open
      apply(q) {
        const p = new URLSearchParams(q);
        if (Object.prototype.hasOwnProperty.call(STATUSES, p.get("status"))) filter.status = p.get("status");
        filter.urgent = p.get("urgent") === "1";
        filter.project = p.get("project") || "";
        app.setQuery(query());
        refreshList(true);
      },
      jump(k) { const c = byKey(k); if (c) scrollToCard(c); else peek(k); },
      destroy() {
        root.removeEventListener("click", onClick); root.removeEventListener("input", onInput);
        removeEventListener("scroll", onScroll); removeEventListener("resize", topVar);
        clearInterval(timer); if (io) io.disconnect();
        if (peekEl) peekEl.remove(); if (sheet) sheet.remove();
      },
    };
  }

  window.artipeekDecisions = { mount };
})();
