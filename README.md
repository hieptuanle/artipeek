# <img src="assets/icon.svg" width="40" align="top" alt=""> artipeek

AI agents write plans, reports, email drafts, and code inside your local repositories—and often pause waiting for a quick decision from you. **artipeek** gives you a live, read-only web viewer for chosen folders so you can read agent output and answer their questions from your phone or laptop. When a file changes on disk, your open page updates by itself.

Built with [Bun](https://bun.sh). It runs directly from TypeScript with no build step and no client framework. Keep it on localhost, share it with your own devices over [Tailscale](https://tailscale.com) (a private mesh VPN), or publish selected folders behind a Cloudflare Access login—with an optional iPhone and Apple Watch app for push notifications.

<p>
  <img src="docs/screenshots/phone-home.png" width="200" alt="Home: open and urgent decisions and to-do actions per folder, then one card per folder with its newest files, file-type icons and status labels">
  <img src="docs/screenshots/phone-markdown.png" width="200" alt="Two tabs open; a Markdown file with its status bar, front matter and a table">
  <img src="docs/screenshots/phone-menu.png" width="200" alt="The file menu slides in: Decisions and Actions with their counts, Recent files of every folder, then the folders, with icons and status labels (sent, waiting, draft)">
  <img src="docs/screenshots/phone-dark-code.png" width="200" alt="Highlighted code in dark mode">
</p>

<img src="docs/screenshots/desktop-html.webp" alt="On a laptop the file list sits on the left, tabs on top. An agent's HTML explainer runs in the sandbox: animated SVG traffic routing, a chart that draws itself, a safety ring, an Option A/B toggle and answer buttons. Its status label comes from the README.md next to it">

<img src="docs/screenshots/desktop-decisions.png" alt="The Decisions tab: open decisions of every folder, oldest first, an urgent one with its deadline, links to related decisions and actions, answer options, and the outline on the right">

<sub>Screenshots use made-up demo folders.</sub>

## How it works

A **desk** is a git repository where a few AI agents work for you—for example, a planner, a secretary collecting questions, and worker agents running in terminal sessions on this machine or another one. artipeek watches the desk repo read-only and streams live updates to your browser, phone, or [iOS app](#ios-app-apple-watch-and-push-optional) over `127.0.0.1`, Tailscale, or a [Cloudflare Access public link](#public-hostname-cloudflare-tunnel--access).

```mermaid
flowchart TB
  subgraph desk["Desk (git repo + AI agents)"]
    agents["AI agents (planner, secretary, workers)"]
    repo["Desk git repo (Markdown, HTML, answers.jsonl)"]
    agents -->|"write files / read answers"| repo
  end

  subgraph host["artipeek host"]
    ap["artipeek server (127.0.0.1, Tailscale, or Cloudflare Access)"]
    db[("Decision hub (SQLite)")]
    ap <--> db
  end

  apns["Apple push (APNs, optional)"]
  you["You (browser, phone, iOS app, Watch)"]

  repo -->|"watched read-only"| ap
  agents <-->|"artipeek-decide / /api/ (folder token)"| ap
  ap -.->|"answers.jsonl + commit + after (optional)"| repo
  ap -->|"live SSE + read-only pages"| you
  you -->|"confirmed answer, Explain this, a file edit, or ticked action steps"| ap
  ap -.->|"new / urgent alert"| apns
  apns -.->|"push + quick buttons"| you
```

Agents raise and update questions in the [Decision hub](#decision-hub), and hand-work checklists as [Actions](#actions), using a per-folder token over `127.0.0.1` or Tailscale—tokens are refused on the public listener and can never submit answers or tick steps. Only you can answer or tick action steps, on artipeek's pages and confirm sheets (see [Answer buttons](#answer-buttons-optional)); both can also come from a notification action button or the Apple Watch (action steps from iOS app 1.2).

```mermaid
sequenceDiagram
  participant A as AI agent
  participant R as Desk repo
  participant S as artipeek + Hub
  participant U as You (web / iOS / Watch)

  A->>S: Raise decision (artipeek-decide + folder token)
  S-->>U: Live SSE update (+ APNs push if new or urgent)

  alt Answer directly
    U->>S: Confirm answer (sheet, push button, or Watch)
  else Ask "Explain this" first
    U->>S: Request explainer (EXPLAIN: ...)
    S-->>R: Append answers.jsonl, commit, run after (if set)
    A->>S: Read request (artipeek-decide answers or file)
    A->>R: Write explainer HTML page
    A->>S: Link page (artipeek-decide update --explainer)
    S-->>U: Card updates with Open explainer tab
    U->>S: Confirm answer
  end

  S-->>R: Append answers.jsonl, commit, run after (if set)
  A->>S: Read answer (artipeek-decide answers or file)
  A->>S: Act and mark relayed or closed
  S-->>U: Live SSE update on Decisions tab
```

## Quick start

Install dependencies, copy the example config, start the user service, and link the admin CLI:

```bash
git clone https://github.com/hieptuanle/artipeek ~/projects/artipeek
cd ~/projects/artipeek && bun install
mkdir -p ~/.config/artipeek && cp config.example.json ~/.config/artipeek/config.json   # then edit it
cp artipeek.service ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user enable --now artipeek
ln -s ~/projects/artipeek/cli.ts ~/.local/bin/artipeek   # admin CLI
```

Once running, open artipeek from whichever channel you configured:

| Access method | URL | Notes |
|---|---|---|
| Local machine | `http://127.0.0.1:4321` | Always available on localhost. |
| Your devices via [Tailscale](https://tailscale.com) | `http://<machine>.<tailnet>.ts.net:4321` | Only devices named in `allowDevices`, on a tailnet listed in `tailnets`. |
| Anywhere via public hostname (optional) | `https://artipeek.example.com` | Routed through a Cloudflare Tunnel (outbound-only, no open ports) behind Cloudflare Access (a login gate such as an email PIN). See [Public hostname](#public-hostname-cloudflare-tunnel--access). |
| iPhone and Apple Watch (optional) | Native shell app in [`ios/`](ios/README.md) | Push notifications for new and urgent decisions, with direct answers from notifications or the Watch. See [iOS app, Apple Watch and push](#ios-app-apple-watch-and-push-optional). |

Tip: on a phone, add the page to your home screen for a full-screen layout.

## Reading your files

artipeek renders files on the server and streams live updates to your browser over Server-Sent Events (SSE—a lightweight, one-way stream from the server).

### Navigation and layout

- **Home (`/`)**: shows open and urgent decision counts and to-do action counts per folder, followed by one card per folder with its 5 newest files.
- **File page (`/r/<folder>/view/<path>`)**: shows the rendered file. On a phone, tap `☰` for the slide-in file list; on a laptop, the list stays docked on the left. In a folder with an agent, **edit** (next to **raw**) opens the [edit view](#edit-requests): your change goes to the agent, not into the file.
- **In-app tabs**: clicking any link to a file inside artipeek (from the file list, Markdown, HTML pages, Decisions, or Actions) opens it in an in-app tab, or switches to it if already open. **Decisions** and **Actions** each open as a single tab.
  - Hidden tabs stay mounted with their scroll position intact, switch instantly, and keep updating live.
  - Each browser tab keeps its own tab list in `sessionStorage` (persisting across reloads) and spans all folders.
  - Browser Back and Forward step through your tab history. Close a tab with `×` or middle-click; Ctrl/Cmd-click opens a normal browser tab. The tab bar appears once two or more tabs are open.
- **File list**: **Decisions** and **Actions** (with live counts) sit at the top, followed by **Recent** (the 10 newest files across all folders, labeled by folder), then each folder. Folder contents load on demand; the active tab's folder and any folders you open stay expanded. Sort by **Name** or **Modified** (newest first; a folder's timestamp matches its newest file; choice saved in a cookie), or filter across every folder.
- **Single live stream**: each browser tab opens one SSE stream (`/_/events`) for all folders and decisions, keeping multiple browser tabs under browser connection limits.

### File rendering

- **Markdown (`.md`)**: GitHub-style formatting (tables, task lists, syntax-highlighted code, footnotes, heading anchors), YAML front matter rendered as a small table, relative links and images, and Obsidian `[[name]]` wikilinks.
- **HTML (`.html`)**: renders standalone pages such as email drafts and explainers inside a sandboxed frame. Inline scripts (animations, toggles) run in an opaque origin with no network access, so the page cannot read your login cookie, read other files, load remote assets, or navigate away. See [`docs/examples/explainer.html`](docs/examples/explainer.html) for a self-contained example (the page in the screenshot). When the file changes and reloads, artipeek restores scroll position (and typed text in folders with answers) via `sessionStorage`. Links to other files inside artipeek open as in-app tabs through a small helper script. Opening the file directly with **raw** disables all scripts.
- **Other files**: text and source files get syntax highlighting, images display inline, and other binaries show file size and a download link.
- **File-type icons**: each file shows an icon for its type (Markdown, HTML, code by language, shell, config, images, PDF, tables, archives, diffs, SQL, media, lock files, text). Folders show an open or closed folder icon (no arrows); tap to expand or collapse.

### Status labels

artipeek extracts status badges from files and displays them in the file list, Recent, Home, and a live-updating bar beneath the file name on file pages.

- **Markdown**: reads the first `Status:` line in the first 20 lines (ignoring code blocks). Formats like `Status: sent 2026-11-01`, `STATUS: **SENT …**`, `- Status: for your yes`, and `**Status:** drafted; not sent` all match.
- **HTML (email drafts)**: reads `<meta name="x-status" content="sent">` in `<head>`, plus optional `x-sent-at` (displayed in UTC), `x-to`, and `x-subject`.
- **Folders**: inherit the status of `README.md`, `index.md`, `email.html`, or `index.html` (in that order), or the shared status if every Markdown and HTML file directly inside the folder agrees. For example, an `email.html` next to a `README.md` with `Status: sent …` shows **sent** on both the folder row and the `.html` row (tooltips show the source); non-Markdown/HTML files (`.css`, `.pdf`, etc.) do not repeat the label.

| Status text contains | Label shown |
|---|---|
| `sent`, `posted`, `replied` | **sent** |
| `not sent`, `draft`, `drafted`, `started`, `wip` | **draft** |
| `for your yes`, `for review`, `waiting`, `pending` | **waiting** |
| `done`, `ok`, `approved`, `merged` | **done** |
| Anything else | First word (`never sent` and `not approved` keep two words) |

## Decision hub

The decision hub stores questions raised by agents across all your folders in one SQLite database (via Drizzle ORM). Open it from **Decisions** at the top of the file list, at `/decisions` (every folder, with project filter and clickable project tags), or at `/r/<folder>/decisions` (one folder). The home page also shows open and urgent counts.

- **Consistent format**: agents submit structured data (title, Markdown context, options, deadline, links) instead of hand-crafted HTML. Answers use artipeek's confirmation sheet, and only you can submit them.
- **Queue and history**: **Open** and **Later** list oldest first as a queue; **Answered**, **Closed**, and **All** list newest first as history. Filter by status, **Urgent**, and project. Loads 30 decisions per page (more load at the end or via "Show more").
- **Urgency**: marked urgent when the agent sets `urgent: true` or when an open decision's deadline is less than 24 hours away (or past). Urgent cards and outline entries are highlighted.
- **Outline**: sits on the right on desktop (or behind the Outline button / floating phone button on narrow screens). Tracks the card you are reading, jumps on tap, and notes when a filter is empty ("No open decisions.").
- **Links between decisions**: supports "From D12" / "Led to" and "Depends on D13" / "Needed by", including across folders. Clicking jumps to the linked decision or overlays it if filtered out.
- **Explain this**: ask an agent for a visual explainer page instead of answering right away. It reaches the agent like an answer (`kind: "explain"`, text starting with `EXPLAIN: …`) while leaving the decision open. Once the agent links the explainer, **Open explainer** opens it in an artipeek tab next to Decisions, which keeps your place.
- **Live updates without scroll jumps**: SSE updates patch only the changed card in place. A card leaving the current filter (such as one you just answered) stays dimmed until you change filters. Typed notes, picks, focus, and scroll position survive live updates, reloads, and tab switches.
- **Legacy `decisions.html` links**: once a folder has decisions in the hub, links to its `decisions.html` (at any depth) open the hub instead (`?file=1` still shows the file).

### Connecting agents

See [docs/decisions-for-agents.md](docs/decisions-for-agents.md) for the full agent CLI and HTTP API reference.

1. Generate a per-folder token on the artipeek host: `artipeek decisions token <folder>`.
2. On the agent's machine, raise or update decisions with `artipeek-decide add --file d.json` (or the JSON API with that token). Tokens work only on `127.0.0.1` and Tailscale—never on the public listener—and cannot submit answers.

Answers save to the hub and, in folders with `answers` configured, also append a line to the answers file, commit it, and trigger `after`, so existing agent watchers keep working unchanged.

To migrate an existing `decisions.md` (`## D15 — title` + `- Key: value` format) into the hub:

```bash
bun scripts/import-decisions.ts <folder> path/to/decisions.md --dry-run
bun scripts/import-decisions.ts <folder> path/to/decisions.md
```

Open decisions import in full; answered decisions import from the last 30 days (configurable with `--days`). Raise timestamps are read from git history.

The database lives at `decisions.db` next to `config.json` (override with `"decisions": { "db": "…" }`). The schema is in `db/schema.ts`; after changing it, run `bunx drizzle-kit generate` (the server applies migrations in `drizzle/` at startup).

## Edit requests

Spotted something to change in a file an agent wrote? Tap **edit** next to **raw** on the file's page. You change the text there, but artipeek doesn't write the file: it sends your change to the folder's agent as an **edit request** (E1, E2…), and the agent updates the file itself. So the agent always knows what changed and why, and nothing it is working on gets overwritten behind its back.

1. **Edit** the text (and add a note for the agent if you like). What you type survives a reload of the page.
2. **Send to the agent…** (or Ctrl/Cmd+S) opens artipeek's own sheet with your change as a diff. Only a real click on **Send** sends it.
3. Until the agent acts, the file's page says **✎ Edit E3 sent: waiting for the agent**, with your change under it, and the file list marks the file with ✎.
4. The agent updates the file and marks the request **done**, or **declines** it with a reason. The page shows either one (for 3 days), live. If the file comes to have exactly your text, the request is done by itself.

- **Changing it again** before the agent acts: the edit view starts from your pending text, and sending replaces the request (E4 replaces E3). **Take E3 back** withdraws it.
- **The file changed while you were editing**: the editor says so and keeps your text; Send checks first and offers the new version instead of sending a change made against an old one.
- **Where**: folders with an agent, i.e. with `answers` set or an agent token (`artipeek decisions token <folder>`). Text files up to 512 kB (no images or binaries); a file's CRLF line endings are kept.
- **Who**: only you, under the same rules as answers (a Cloudflare Access login or a device in `answerDevices`, never plain `127.0.0.1`).
- **How the agent hears it**: like an answer. In folders with `answers` set, one line in the answers file (`"kind": "edit"`, `"id": "E3"`, `"page"` = the file, text starting with `EDIT:`), a commit and the `after` command. Always in the hub, through `artipeek-decide answers`, `artipeek-decide edits` and `GET /api/edits/<folder>`. The agent reads it with `artipeek-decide edit show E3` (the diff; `--text` gives your whole new text) and closes it with `artipeek-decide edit done E3 "note"` or `edit decline E3 "why"`. See [docs/decisions-for-agents.md](docs/decisions-for-agents.md#edit-requests).

## Actions

Answering a decision often leaves **you** with hand steps only you can perform—running a migration script on `db-server` after 22:00, rotating a secret, or reconnecting an account. Without a home for them, those steps lived only in an agent's chat: the agent said work was still pending while the Decisions tab showed nothing open.

**Actions** give hand steps their own checklist cards on the **Actions** tab (`/actions`, `/r/<folder>/actions`, right under Decisions in the file list with live counts, plus a card on the home page). Each step explains what to do, where/when to run it, any reference links, and an optional copy-pasteable command with a **Copy** button. An action raised from a decision links both ways (`D12` ↔ `A1`).

<img src="docs/screenshots/desktop-actions-tick.webp" alt="The Actions tab on desktop: an urgent half-done action (A1 from D12) with a verified step, a checking step, a step with a command and Copy button, and the outline on the right. Ticking step 3 moves it live from ticked to checking to verified">

<p>
  <img src="docs/screenshots/phone-actions-dark.png" width="220" alt="The Actions tab on a phone in dark mode showing verified, checking, and to-do steps with a Copy button and floating Outline button">
</p>

<sub>Screenshots use made-up demo folders.</sub>

### How a round goes

```mermaid
sequenceDiagram
  participant A as AI agent
  participant R as Desk repo
  participant S as artipeek + Hub
  participant U as You

  A->>S: Raise action A3 (from D317)
  S-->>U: Live SSE update (+ iOS push)
  U->>S: Tick step 1, then step 2
  Note over S: Waits 1 min (batches ticks; slips can be unticked)
  S-->>R: Append 1 ACTION line + commit + after
  S-->>U: Steps flip to "the agent is checking it"
  A->>S: Read signal (artipeek-decide answers)
  A->>S: Verify each step (verified / verify skipped / back to todo)
  A->>S: Mark A3 done & move on
  S-->>U: Live SSE update on Actions tab
```

- **Working the checklist**: tick steps as you go, press **I've done all the steps** (with an optional note), or press **Ask the agent to do it**—every action has it, and the agent either completes the steps for you or hands the card back with a reason.
- **1-minute tick batching**: ticks do not fire immediately one by one. artipeek waits **1 minute** after your last tick (up to 5 minutes after the first) before notifying the agent, so an accidental click can be unticked before it ever leaves artipeek, and ticking five steps in a row produces one `ACTION:` line, one git commit, and one `after` run. Ticking the final step, **I've done all the steps**, and **Ask the agent to do it** go out immediately.
- **Filters & permissions**: filter by **To do**, **With the agent** (asked or checking), **Done**, **All**, **Urgent**, and project, with live SSE updates and an outline just like Decisions. Only you can tick steps or hand an action to the agent (same rules as answers: Cloudflare Access login or `answerDevices`, never plain `127.0.0.1`). Agents raise, verify, and close actions with their folder token (`artipeek-decide action …`) and receive signals via `artipeek-decide answers` (`kind: "action"`, `ACTION: …`) and the folder's answers file. A new action is pushed to the iOS app (buttons **Ask the agent to do it…** and **Open**; a tap opens it). The Apple Watch app lists actions too: tick a step, all done, ask the agent.

| Level | Shown on the page | Meaning |
|---|---|---|
| **Action** | **to do** | Open; at least one step is still left for you. |
| **Action** | **asked the agent** | You pressed *Ask the agent to do it*; the agent is trying it or will hand it back. |
| **Action** | **checking** | Every step is ticked; waiting for the agent to finish verifying and close it. |
| **Action** | **done** | All steps verified (or skipped) and closed by the agent. |
| **Action** | **withdrawn** | Dropped by the agent as no longer needed. |
| **Step** | *Ticked…* | You ticked it; waits ~1 minute so you can untick a slip before the agent hears it. |
| **Step** | **the agent is checking it** | Sent to the agent to verify (you can still untick if it wasn't done after all). |
| **Step** | **✓ Verified** | Agent confirmed it (with what it saw); checkbox locked. |
| **Step** | **Verify skipped** | Agent couldn't check it directly (e.g. an external dashboard); checkbox locked. |
| **Step** | **Not done yet** | Agent checked and sent the step back to you with a note on what's still missing. |

See [docs/decisions-for-agents.md](docs/decisions-for-agents.md#actions-work-only-the-person-can-do) for the agent CLI, states, and HTTP API.

## Answer buttons (optional)

artipeek is read-only by default, with one per-folder exception: an HTML page in an opted-in folder can ask you for a short answer (a preset choice or typed text), and artipeek writes it back into the folder for your agents.

Enable it on a folder in `config.json`:

```json
{
  "name": "desk",
  "path": "~/projects/desk",
  "answers": {
    "file": "inbox/answers.jsonl",
    "message": "answer {id}",
    "after": ["~/.local/bin/my-sync", "desk"]
  }
}
```

### Button markup

Any element with `data-artipeek-answer="<id>"` becomes an answer button:

```html
<button data-artipeek-answer="D15" data-value="A">A</button>
<input id="d15-note"><button data-artipeek-answer="D15" data-value="B" data-input="#d15-note">B, with my note</button>
<textarea id="d16"></textarea><button data-artipeek-answer="D16" data-input="#d16">Send my answer</button>
```

- `data-value` sets a fixed choice; `data-input` points to a text field via CSS selector. When both are set, the submitted text is `<value>: <note>`.
- IDs start with a letter followed by up to 31 letters, digits, `.`, `_`, or `-`. Answer text allows up to 2,000 characters.

**Multiple questions in one decision**: add `data-question` to each choice button so tapping toggles a selection rather than sending immediately (selecting one choice clears others in the same question; tapping again deselects it). Add one send button with `data-artipeek-picks` to submit all picks for that ID in page order:

```html
<p>Q1 Who may read invoices?</p>
<button data-artipeek-answer="D201" data-question="Q1" data-value="A">A. the bot only</button>
<button data-artipeek-answer="D201" data-question="Q1" data-value="C">C. nobody</button>
<p>Q2 Add the Flexi-time position?</p>
<button data-artipeek-answer="D201" data-question="Q2" data-value="A">A. yes</button>
<button data-artipeek-answer="D201" data-question="Q2" data-value="B">B. leave it</button>
<textarea id="d201-note"></textarea>
<button data-artipeek-answer="D201" data-artipeek-picks data-input="#d201-note">Send my answers</button>
```

This sends `Q1 A, Q2 B` (or `Q1 A, Q2 —` if Q2 is unpicked), plus `: <note>` if the box has text. Active picks receive `data-artipeek-picked="true"` and `aria-pressed="true"` for styling (for example, `[data-artipeek-picked="true"]{background:var(--accent);color:#fff}`), survive live reloads, and receive `data-artipeek-chosen="true"` after saving. The page also receives an `artipeek:pick` event (`detail`: `id`, `question`, `value`, empty when turned off).

### Submission flow and permissions

1. Clicking a button asks artipeek to open **its own confirmation sheet** (outside the sandboxed page) showing the ID and exact text.
2. Only a real click on **Send** in that sheet submits the answer. The page cannot press Send, alter the previewed text, or make network requests.
3. artipeek appends one JSON line to `file`: `{"at", "uid", "id", "text", "by", "page"}`, where `by` is the Cloudflare Access email or Tailscale device name. In a git repo, it commits only that file as author `artipeek` (using `message` with `{id}` substituted) and runs `after` (if set) without blocking.
4. Matching buttons receive `data-artipeek-state="saved"`, the button matching `data-value` gets `data-artipeek-chosen="true"`, the button's input clears, and the page receives an `artipeek:answer-saved` event (`detail`: `id`, `text`, `at`, `uid`, `restored`).
5. **Reload memory**: each time artipeek serves the page, it replays the latest answer per ID from the last 48 hours (`restored: true`), keeping your sent answers marked across agent rewrites until the page itself marks them done.

**Who may answer**: authenticated users on the public listener (`public.emails`) or Tailscale devices listed in `answerDevices` (list only personal phones and tablets, because any process on a listed device can post). **Plain `127.0.0.1` is never allowed**, since local agents and scripts can reach it. Folders without `answers` (and without hub decisions) return `404` and do not load the button script.

## Configuration

artipeek reads `~/.config/artipeek/config.json`. See `config.example.json` for every supported option.

```json
{
  "port": 4321,
  "tailnet": true,
  "tailnets": ["example-tailnet.ts.net"],
  "allowDevices": ["my-phone", "my-laptop"],
  "roots": [
    { "name": "notes", "path": "~/notes" }
  ]
}
```

| Keys | When applied | Notes |
|---|---|---|
| `roots`, per-folder `answers` | Within ~1 second (no restart) | Folder names allow letters, digits, `.`, `_`, `-`. `/` and your home folder are refused as too wide. |
| `port`, `tailnet`, `tailnets`, `allowDevices`, `answerDevices`, `public`, `decisions`, `push` | At startup | Run `artipeek restart` after manual edits. The admin CLI restarts automatically when needed. |

## Admin CLI (`artipeek`)

Run `artipeek help` for the full command list.

| Command | What it does |
|---|---|
| `artipeek` | Show service status, listeners, public link, and folders (`★` = public). |
| `artipeek check` | Verify Cloudflare setup: token expiry, Access app and policy, DNS, tunnel rule, and both auth checks. |
| `artipeek add <name> <path> [--public]` | Add a folder (optionally expose it on the public hostname). |
| `artipeek remove <name>` | Remove a folder from config (files on disk are untouched). |
| `artipeek public add\|remove <name>` | Show or hide a folder on the public hostname. |
| `artipeek emails add\|remove <email>` | Manage allowed public logins (updates Cloudflare Access first, then local config). |
| `artipeek devices add\|remove <name>` | Manage allowed Tailscale device names. |
| `artipeek refused --since 24h` | Summarize refused requests grouped by reason. |
| `artipeek decisions` | Show decision counts per folder and which folders have an agent token. |
| `artipeek decisions token <name>` | Generate a new agent token for a folder (printed once). |
| `artipeek logs -f \| restart \| test \| undo-config` | Follow logs, restart service, run tests, or restore previous config. |

- Edits to `config.json` are atomic and back up the prior version to `config.json.prev` (`artipeek undo-config` restores it, without reverting Cloudflare changes).
- The CLI automatically restarts the service when changing startup-only settings.
- `emails` updates Cloudflare first; if that fails, `config.json` stays untouched. Removing the last allowed email is refused.
- Cloudflare commands read an API token from `~/.config/artipeek/cf-token` (mode `600`, never printed) and IDs from `public.cloudflare`.

## Safety

artipeek assumes agent-written files may be untrusted and enforces strict boundaries on what is exposed, who can connect, and what can write.

- **Allowed files**: in git repos, only files git lists (tracked files plus untracked files not ignored by `.gitignore`). Outside git repos, all files except `.git` and `node_modules`. `.git/` is never served.
- **Hard deny list (never shown, even if tracked)**: `.env` and `.env.*` (except `.env.example`, `.env.sample`, `.env.template`), `.netrc`, `.pgpass`, `.npmrc`, `id_rsa`/`id_dsa`/`id_ecdsa`/`id_ed25519` keys (and `.pub`), `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.kdbx`, `*.ppk`, `*.keystore`, `*.jks`.
- **Path containment**: every requested path—including symlinks—must resolve inside its folder. `..`, absolute paths, backslashes, and symlinks pointing outside return `404`.
- **Read-only with narrow write exceptions**: only `GET` and `HEAD` are accepted; all other methods return `405`, except:
  - `POST /r/<folder>/answer` (folders with `answers` configured or decisions in the hub): requires a Cloudflare Access login or a device in `answerDevices` (never plain `127.0.0.1`), `Sec-Fetch-Site: same-origin` (set by the browser, not by page scripts), `X-Artipeek: answer`, and a JSON body under 8 KB (forcing any cross-site attempt into a CORS preflight, which gets `405`). Appends one line to one file inside the folder (no outbound symlinks), commits only that file, and never logs answer text. Native iOS and Watch answers send the same headers with the Access login cookie.
  - Decision hub agent API (`/api/…`): requires the folder's hashed bearer token on every call (even from `127.0.0.1`), is disabled on the public listener, and cannot submit answers. Agent text is Markdown with raw HTML disabled.
  - Push registration (`POST /_/push/…`): enforces the same caller, origin, and JSON checks as answers, with `X-Artipeek: push`.
  - Edit requests (`POST /r/<folder>/edit`, folders with an agent): the same caller, origin, and JSON checks as answers, with `X-Artipeek: edit` and a body under 1.5 MB. It never writes the file: it stores the request in the hub and, with `answers` set, appends one line to the answers file and commits only that file. File text is never logged.
  - Actions (`POST /r/<folder>/action`): the same caller, origin, and JSON checks as answers, with `X-Artipeek: action`. Only you can tick steps or ask the agent to do an action; agents manage actions through `/api/actions/…` with their folder token.
- **Network listeners**: listens only on `127.0.0.1` and, when `tailnet` is `true`, the machine's Tailscale IP (checked every 15 s to follow tailnet changes). Never listens on Wi-Fi/LAN. Public access goes only through a Cloudflare Tunnel to the separate `public` listener, which requires Cloudflare Access.
- **Tailscale device check**: every tailnet request is verified via `tailscale whois` and served only if the peer matches `<host>.<tailnet>` with `host` in `allowDevices` and `tailnet` in `tailnets`. All other tailnet requests return `403` and log one line (IP, device name, path—never file contents). `127.0.0.1` is always served.
- **Browser isolation**: strict Content-Security-Policy allows only the server's own small script and blocks remote images, fonts, and scripts. Raw files receive `CSP: sandbox` (opaque origin, no network). `.html` files get `allow-scripts` for inline scripts only when framed inside artipeek's file page (`Sec-Fetch-Dest: iframe`, `Sec-Fetch-Site: same-origin`), where `frame-src 'self'` prevents navigating away; `allow-same-origin` is never set.
- **No content logging or telemetry**: file contents and answer text are never logged. Outbound requests occur only to fetch Cloudflare Access public signing keys (when `public` is configured) and to send APNs push notifications containing only folder, decision ID, and title (when `push` is configured).

## Public hostname (Cloudflare Tunnel + Access)

Expose selected folders over HTTPS from anywhere without opening inbound firewall ports:

`Browser → https://artipeek.example.com → Cloudflare Access (login, e.g. email PIN) → Cloudflare Tunnel (cloudflared) → 127.0.0.1:4323`

> Never point the tunnel at the main port (`4321`): the main listener trusts all requests from `127.0.0.1`, and `cloudflared` connects from `127.0.0.1`. Always point it at the separate `public.port`.

```json
"public": {
  "port": 4323,
  "hostname": "artipeek.example.com",
  "teamDomain": "<team>.cloudflareaccess.com",
  "aud": "<Access application AUD tag>",
  "emails": ["you@example.com"],
  "roots": ["notes"]
}
```

- **Double-checked login**: every request on the public listener must carry a valid Cloudflare Access JWT (JSON Web Token, via header `Cf-Access-Jwt-Assertion` or cookie `CF_Authorization`). artipeek verifies the RS256 signature against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` (keys cached 1 hour, refetched on unknown key ID), plus `aud`, `iss`, `exp`/`nbf`, and `emails`. Invalid requests get `403` and log the reason (never the token)—so artipeek refuses unauthorized traffic even if the Access app is deleted or misconfigured.
- **Scoped folders**: only folders in `public.roots` exist on the public listener; all others return `404` and are hidden. Keep confidential folders out of `public.roots`.
- **Live updates**: uses the same SSE stream with a keepalive ping every 25 s so Cloudflare does not drop idle connections.
- `certsUrl` exists only for automated tests (fake certs endpoint); do not set it in a real config.

### Setup steps

1. Add a tunnel ingress rule `artipeek.example.com → http://127.0.0.1:4323` (above the catch-all `http_status:404`) and a proxied CNAME `artipeek → <tunnel id>.cfargotunnel.com`.
2. Create a self-hosted Cloudflare Access application for the hostname with an Allow policy for your email(s) (session duration up to 730 h / 1 month).
3. Put the app's AUD tag and your team domain in `public`, then run `artipeek restart` and `artipeek check`.

To undo: delete the Access app, DNS record, and tunnel rule; revoke the API token; remove `public` from `config.json`; and run `artipeek restart`.

## iOS app, Apple Watch and push (optional)

[`ios/`](ios/README.md) contains a SwiftUI shell around artipeek's web UI (`WKWebView`), so web updates appear in the app immediately without rebuilding. Native features add push notifications, app icon badges (open decisions + actions to do), Cloudflare Access login, notification answer buttons, an **Ask the agent to do it…** button on an action's push, settings (server URL, notifications toggle, test push, sign out), and an Apple Watch companion app (decisions and actions) with a watch-face complication. See [`ios/README.md`](ios/README.md) for Xcode and TestFlight build steps.

<p>
  <img src="docs/screenshots/ios-decisions.png" width="200" alt="The app on an iPhone: the Decisions tab, logged in through the public link, an urgent decision with its deadline and a link to the action it led to (A14)">
  <img src="docs/screenshots/ios-push.png" width="200" alt="A push banner: my-project · D12 · urgent, with the decision's title and its options">
  <img src="docs/screenshots/ios-settings.png" width="200" alt="The app's settings: server, notifications on, send a test push, sign out; the badge counts open decisions and actions to do">
</p>

<p>
  <img src="docs/screenshots/ios-actions.png" width="200" alt="The Actions tab in the app: A14, an urgent checklist from D12; step 1 verified by the agent, step 2 with a command and its Copy button">
  <img src="docs/screenshots/ios-action-push.png" width="200" alt="An action's push, held open: my-project · A14 · action for you, 3 steps, with the buttons Ask the agent to do it… and Open">
</p>

<img src="docs/screenshots/ipad-dark.png" width="420" alt="On an iPad in dark mode the file list sits on the left, with Decisions and Actions (2 to do, 1 urgent, 1 with the agent) and the app's settings gear in its header">

<p>
  <img src="docs/screenshots/watch-list.png" width="160" alt="The Apple Watch app: 3 open, 1 urgent; the urgent decision first, with the time left">
  <img src="docs/screenshots/watch-decision.png" width="160" alt="A decision on the Watch: the recommended option in green with a star; tap, confirm, saved">
  <img src="docs/screenshots/watch-questions.png" width="160" alt="A decision with two questions on the Watch: one pick per question, then Send my answers">
</p>

<p>
  <img src="docs/screenshots/watch-actions.png" width="160" alt="Below the decisions on the Watch: 2 actions to do, 1 urgent, with how many steps are ticked (1/3), then those with the agent">
  <img src="docs/screenshots/watch-action.png" width="160" alt="An action on the Watch: urgent, 1/3 steps ticked, the deadline, from D12">
  <img src="docs/screenshots/watch-steps.png" width="160" alt="Its steps on the Watch: step 1 verified by the agent; step 2 with where to run it and the whole command, to read; tap a step, confirm, ticked">
</p>

<sub>Screenshots use made-up demo folders.</sub>

### Push notifications (APNs)

The server pushes through APNs (Apple Push Notification service, using token auth with a `.p8` key from your Apple Developer team) when a decision is:

- **new**: raised while open (title `<folder> · <id> · new`, body = decision title).
- **urgent**: open with `urgent: true` or a deadline within 24 hours / past (title `<folder> · <id> · urgent`). A decision raised already urgent sends one urgent push.

```json
"push": {
  "apns": {
    "keyPath": "~/keys/AuthKey_XXXXXXXXXX.p8",
    "keyId": "XXXXXXXXXX",
    "teamId": "XXXXXXXXXX",
    "bundleId": "com.example.artipeek"
  }
}
```

- **Deduplication and history**: each decision sends at most one push per kind (tracked in the hub's `push_sent` table across restarts and re-imports). Decisions first seen more than 15 minutes after their last change (such as imports or pre-existing items) are marked seen without pushing. The server checks after every change, on external database writes, and once per minute for deadlines.
- **Payload**: badge = open decisions + actions to do (status `open`; not those with the agent) visible to that device; `thread-id` = folder; custom data `{project, id, url}` opens the decision on tap. An action's push has category `artipeek.action` and data `{kind: "action", project, id, url}`: **Ask the agent to do it…** (an optional note, then Send) posts `op: "agent"` to `POST /r/<folder>/action` like the Actions tab; **Open** or a tap opens it.
- **Key and config**: read at startup (`artipeek restart` after edits). Keep the `.p8` file private (`chmod 600`); it is never copied or logged. One APNs key works for every app on the team. `origin` (inside `apns`) exists only for tests (fake APNs); do not set it in production.
- **Device registration**: the app calls `POST /_/push/register` (`/unregister`, `/test`) from its web view, carrying the page login and obeying the answer rules (Access login or `answerDevices`, never plain `127.0.0.1` or agent tokens, `Sec-Fetch-Site: same-origin`, `X-Artipeek: push`, JSON body). Devices registered via the public listener receive notifications and badge counts only for `public.roots`.
- **Notification answer buttons**: a single-question decision with up to 4 options displays them in the notification and as action buttons—letters for standard sets (`A/B`, `A/B/C`, `A/B/C/D`, `Y/N`, also shown on Apple Watch) or option labels via the notification extension. Other decisions offer **Reply…** (type, dictate, or scribble) and **Open**. Tapping saves immediately via `POST /r/<folder>/answer` (source `artipeek:push`) and displays `"Saved: D4 → A"`. Action buttons require an unlocked phone or Watch.
- **Apple Watch app**: lists open decisions (urgent first), confirms each answer before saving (source `artipeek:watch`), then the actions to do (urgent first) and those with the agent; on an action it shows the steps (commands in full, to read) and, each confirmed first, ticks or unticks a step, sends "all done" or "ask the agent" (`POST /r/<folder>/action`, same rules as the page). The complication counts open decisions + actions to do (the badge rule) and how many are urgent. It reads the read-only endpoint `GET /decisions/part/app.json` using the login passed from the iPhone app: `open`, `urgent`, `decisions` (open decisions), and since app 1.2 `actions` (live ones, steps as plain text), `actionCounts` `{todo, urgent, agent}` and `badge`.
- **Environments and cleanup**: each device token stores its APNs environment (`sandbox` for development builds, `production` for TestFlight). Tokens APNs reports gone (`410`, `BadDeviceToken`) are removed automatically and re-registered on next launch.

## Service and development

The systemd user unit lives at `~/.config/systemd/user/artipeek.service` (source copy: `artipeek.service`). It starts at login and restarts on failure.

```bash
artipeek                                   # or: systemctl --user status artipeek
artipeek restart                           # after editing server.ts
artipeek logs -f                           # inspect refused requests and loaded folders
```

For local development with auto-reload on save:

```bash
bun run dev
```

This runs on port `4322` using your existing config (and also listens on the Tailscale IP at `4322` when `tailnet: true`).

## Tests

All tests use temporary folders and a temporary config—never your real repositories. Run `bun install` once first.

| Command | What it tests |
|---|---|
| `bash test.sh` (or `artipeek test`) | Home page, sidebar, folder switcher, phone menu, Markdown, sandboxed HTML, status labels, file-type icons, path escapes and deny list (`404`), `POST` (`405`), live config reload, bad root names / home folder rejection, sort cookie, live SSE events within 2 s, no file contents in logs, answer endpoint checks, public listener JWT checks (`test-access.ts`, including ~30 s wait for key refetch limit), admin CLI on temp config, and Tailscale device checks when Tailscale is running. |
| `bun run test:answers` | Browser tests (Chromium): confirm sheet isolation, Cancel vs Send, JSON line + git commit, `artipeek:answer-saved` callback, choice + note, free text, empty answer handling. |
| `bun run test:decisions` | Browser tests (Chromium): agent token API auth and restrictions, single-stream folder scoping, queue/history order, pagination (30/page), urgency, outline, cross-decision links, filters, jump-free live updates (desktop and phone), notes/picks survival, multi-question answers, explainer flow, all-folders view, external DB writes, `decisions.html` redirect. |
| `bun run test:tabs` | Browser tests (Chromium): tab opening/switching, sidebar highlight tracking, cached tab scroll position, preserved HTML iframes, links inside HTML, Back navigation, live updates on hidden tabs, closing, reload persistence, lazy folder loading, multi-folder tabs, single Decisions tab, per-browser-tab lists, phone viewport. |
| `bun run test:edits` | Edit requests (Chromium): who may send (not 127.0.0.1, not cross-site, not folders without an agent), preview vs send, the file left untouched, the answers line + commit, the agent API and `artipeek-decide edit`, replacing, done/declined/withdrawn, done by itself, stale edits refused, CRLF kept; in the browser: drafts across reloads, a file changing under you, the sheet (untrusted clicks ignored), live bar and file-list mark. |
| `bun run test:actions` | Actions (Chromium): the agent API and `artipeek-decide action`, ids unique with decisions, links both ways with a decision, who may tick (not 127.0.0.1, not cross-site), ticks batched into one answers line + commit (a slip never sent), the line's shape and `ACTION:` text, untick while checking, verified/skipped/back to todo, done only when every step is checked, "all done" with a note, "ask the agent" and hand back, steps rewritten without losing ticks, ticks waiting at a restart; in the browser: tick, live checking/verified, the sheet (untrusted clicks ignored), Decisions ⇄ Actions links and tabs, phone width; the Watch's JSON (actions, `actionCounts`, `badge`, the 1.1 fields unchanged). |
| `bun run test:push` | Fake local HTTP/2 APNs server checking ES256 auth: registration rules, single push per new/urgent decision and per new action, silent history/imports, restart persistence, `public.roots` scoping, dead token removal, payload fields (`title`, `body`, `badge`, `thread-id`, `data`), and test push. |

Browser tests require Chromium (set `CHROME_PATH` if it is not at `/usr/bin/chromium`).

## Uninstall

Undo the [public hostname](#public-hostname-cloudflare-tunnel--access) setup first if configured, then remove the service, CLI symlink, repo, and config:

```bash
systemctl --user disable --now artipeek
rm ~/.config/systemd/user/artipeek.service && systemctl --user daemon-reload
rm -f ~/.local/bin/artipeek
rm -rf ~/projects/artipeek ~/.config/artipeek
```

## Contributing: secrets scan before each commit

`bun install` installs a git pre-commit hook (`scripts/install-hooks.sh`, run via `postinstall`). On every commit it runs `scripts/pre-commit`, which scans staged changes with the [Infisical CLI](https://infisical.com/docs/cli/overview) (`infisical scan git-changes --staged --redact`).

- Any detected secret blocks the commit and is displayed redacted. If the scanner is missing or fails, the commit is blocked as well.
- Existing pre-commit hooks not installed by artipeek are left untouched (the installer prints the line to add instead).
- Skip once: `git commit --no-verify`. Disable: `git config hooks.infisical-scan false`.

## License

MIT, see [LICENSE](LICENSE).
