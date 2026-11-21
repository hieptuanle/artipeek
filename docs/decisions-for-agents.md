# Decision hub: for agents

artipeek keeps one decision hub (SQLite) for every folder. The person reads and answers it on one page:

- `/r/<folder>/decisions`: one folder's decisions
- `/decisions`: every folder's, with a project filter

You raise and keep decisions through the hub's API with your folder's token. **Don't write a `decisions.html` any
more.** The page has the same shape for every folder, updates live without reloading, and keeps the reader's place.
An old link to `/r/<folder>/view/decisions.html` goes to the hub page once the folder has a decision there.

## Setup (once per folder)

On the machine that runs artipeek: `artipeek decisions token <folder>`. It prints the token once.

On the agent's machine, put it in `~/.config/artipeek/decide.json` (mode 600, never in git):

```json
{ "url": "http://hub-machine:4321", "tokens": { "my-desk": "apk_…" } }
```

Then use the CLI from a clone of artipeek (bun, no install): `bun ~/projects/artipeek/decide.ts help`, or link it:
`ln -s ~/projects/artipeek/decide.ts ~/.local/bin/artipeek-decide`. Its project is `--project`, `ARTIPEEK_PROJECT`,
or the name of the git folder you're in.

## Raise a decision

Write the JSON to a file and send it (`--file -` reads stdin):

```json
{
  "title": "Merge PR #9323: an invoice's account must belong to its seller?",
  "lane": "ERP",
  "context": "Built as you approved in D252.\n\n- All **12,400** invoices of the last 30 days pass.\n- Review: [reviews/PR9323.md](reviews/PR9323.md)",
  "questions": [
    { "options": [
      { "value": "A", "label": "merge, deploy with the next ERP deploy", "recommended": true, "effect": "live tonight" },
      { "value": "B", "label": "not yet" }
    ] }
  ],
  "deadline": "2026-11-21T18:00:00+07:00",
  "deadlineNote": "before the evening deploy",
  "ifNoAnswer": "nothing merges",
  "urgent": false,
  "links": [{ "label": "PR #9323", "href": "https://git.example.com/org/repo/pulls/9323" }],
  "from": ["D252"],
  "dependsOn": []
}
```

```bash
artipeek-decide add --file d.json          # → "D318 raised: http://…/r/my-desk/decisions#d:my-desk:D318"
```

- **id**: leave it out, and the hub gives the next free one (same prefix as the folder's other ids: D, F, H…).
  Or set `"id": "D318"`. Ids are never reused.
- **context**: Markdown, no raw HTML (it shows as text). A relative path links to a file in your folder.
  `/r/<folder>/…` paths and `https://` links work too. Files open as artipeek tabs next to the Decisions tab;
  web links open in a new browser tab.
- **questions**: one question: its options are buttons, and a tap sends the choice (`A`, or `A: <note>`). Two or
  more: give each a `key` (Q1, Q2…) and a `text`. The person picks one option per question, then sends them all at
  once: `Q1 A, Q2 B` (`Q2 —` = no pick: not answered yet), plus `: <note>`. No questions: the person types an answer.
  Every card also has a note box ("Send my own answer"). Option values: letters/digits, up to 16.
- **urgent**: your flag. A decision also counts as urgent when its deadline is less than 24 h away or past. Urgent
  ones are highlighted and have their own filter. Set it only when the person should act before anything else.
- **from** / **dependsOn**: `"D12"`, or `"other-folder:D3"` across folders. `from` = this one came out of that
  one. `dependsOn` = it waits for that one. The page shows both ways (From / Led to, Depends on / Needed by), and a
  tap scrolls there.
- Quick flags for small ones: `artipeek-decide add --title "…" --option "A*: merge — If A: live tonight" --option
  "B: not yet" --deadline "2026-11-21 18:00" --from D252` (`*` = recommended; local time).

## Keep it current

```bash
artipeek-decide note D318 "Review re-ran after the rebase: PASS"   # a dated update under the context
artipeek-decide note D318 "Merged and live (web v1650)" --done     # marked as done
artipeek-decide update D318 --file patch.json                      # any fields; only the ones given change
artipeek-decide update D318 --status relayed --resolution "A: merged tonight"
artipeek-decide update D318 --urgent        # or --not-urgent
artipeek-decide list --status open          # show D318, answers, list --json
```

Statuses: `open` (waiting for the person), `later` (not ready; its own filter), `answered` (set by the hub when
the person answers), `relayed` (you passed the answer on), `closed` (done or moot), `withdrawn`. Set `resolution`
to say what was decided. Do it also when the person answered somewhere else (e.g. typed in your pane): the page
shows it as "Desk: …", apart from answers sent on the page.

## Answers come to you as before

Only the person can answer: on the page, through artipeek's own confirm sheet, from a login or an answer device.
No token can. An answer is saved in the hub and, if the folder has `answers` in artipeek's config, also appended to
`inbox/answers.jsonl`, committed by `artipeek`, and the folder's `after` command runs. So existing watchers keep
working. You can also read them with `artipeek-decide answers --since <ISO>`.

A line is `{"at", "uid", "id", "text", "by", "page": "artipeek:decisions"}`. Check it as you do today: the line is
on the branch, its commit's author is `artipeek`, `by` is the person.

## "Explain this"

Every card has an **Explain this** button. The person asks for a page that shows the decision and its options
instead of answering. It reaches you like an answer, with `"kind": "explain"` and a text starting with `EXPLAIN:`
(e.g. `EXPLAIN: what does B cost us?`). It is **not** a choice. The decision stays open and its card says
"Explainer asked for…".

Then:

1. Write a self-contained HTML page in your folder (e.g. `explainers/D318.html`). Show the situation and each
   option side by side: what happens, cost, risk, what changes for whom. No external scripts or fonts (they're
   blocked). Inline CSS/JS is fine. Answer buttons (`data-artipeek-answer="D318"`) work inside it too.
2. Commit it (and sync, so it's in artipeek's copy of the folder).
3. `artipeek-decide update D318 --explainer explainers/D318.html`

The card then shows **Open explainer**. It opens as an artipeek tab, and going back to the Decisions tab brings
the person back to the same spot.

## Edit requests

The person can edit a file of your folder on artipeek's edit view (the **edit** link next to **raw**). artipeek does
**not** write the file. It hands you the new text as an **edit request** (E1, E2…), and **you** update the file, so
you always know what changed. Until you close it, the file's page says "Edit E3 sent: waiting for the agent".

It reaches you like an answer:

- in folders with `answers` set, one line in `inbox/answers.jsonl` (committed by `artipeek`, then the `after` command):
  `{"at", "uid", "id": "E3", "text": "EDIT: docs/plan.md (note: …). Update the file yourself: artipeek-decide edit show E3", "by", "page": "docs/plan.md", "kind": "edit"}`;
- always in `artipeek-decide answers` (kind `edit`) and `artipeek-decide edits` (the pending ones).

Its id is not a decision: the text always starts with `EDIT:`. Then:

```bash
artipeek-decide edit show E3            # the diff against the file as it was when sent, the person's note, where the file is now
artipeek-decide edit show E3 --text     # the person's whole new text (--base: the file as it was)
artipeek-decide edit done E3 "applied; also renamed the heading"   # you updated the file (as asked, or adapted: say how)
artipeek-decide edit decline E3 "the date comes from the contract, it stays"   # you won't; the person sees why
```

1. Read the diff and the note. `the file now:` says whether the file is still as it was (`unchanged`), already has
   the text (`has the edit`), or `changed since` (you or another agent wrote it after the person opened the editor:
   merge by hand).
2. Apply it: write the new text (`edit show E3 --text > docs/plan.md` when the file is unchanged), or make the same
   change your way. Commit it as you commit your own work (and sync, so artipeek's copy has it).
3. Close it: `edit done E3 "note"` or `edit decline E3 "why"` (a reason is required). If the file ends up with exactly
   the person's text, artipeek marks it done by itself, but say what you did anyway when you adapted it.

- **Replaced**: when the person edits the same file again before you act, the new request says `replaces E3`, and E3
  becomes `superseded`. Apply only the newest one: its diff holds both changes.
- **Withdrawn**: `EDIT: E3 withdrawn: leave docs/plan.md as it is.` The person took it back; don't apply it.
- Only the person can send edits (a login or an answer device). Your token can read and close them, not send them.

## Actions: work only the person can do

When an answer leaves the person with **hand steps** (run a script on a server after 22:00, post a notice, reconnect
an account), don't keep them in your chat: raise an **action**. It is a card on artipeek's **Actions** tab
(`/actions`, `/r/<folder>/actions`, next to Decisions in the file list), with a checklist the person ticks off.
Every action also has **Ask the agent to do it**: the person can hand it to you instead.

```json
{
  "title": "Run the invoice backfill on db-server",
  "lane": "ERP",
  "context": "You answered **A** on D317. The script only touches invoices of the last 30 days.",
  "from": ["D317"],
  "deadline": "2026-11-21T23:30:00+07:00",
  "steps": [
    { "text": "SSH to db-server **after 22:00**", "command": "ssh db-server", "where": "your laptop" },
    { "text": "Dry run first; check the counts", "command": "bun cli/migrations/backfill.ts --dry-run", "where": "db-server" },
    { "text": "Run it for real", "command": "bun cli/migrations/backfill.ts --go", "where": "db-server",
      "links": [{ "label": "PR #9323", "href": "https://git.example.com/org/repo/pulls/9323" }] },
    "Post the notice in the accounting channel"
  ]
}
```

```bash
artipeek-decide action add --file a.json     # → "A3 raised: http://…/r/my-desk/actions#a:my-desk:A3"
artipeek-decide action add --title "Reconnect TikTok ads" --step "Open Business Center" --step "Check spend :: tiktok-cli spend --today" --from D317
```

- **steps** (1 to 30): `text` is Markdown (what to do, plainly). `command` is shown in monospace with a **Copy**
  button: put exactly what to paste, nothing to edit by hand. `where`: where to run it (machine, time). `links`: like
  a decision's. A plain string is a step with only text. ` :: ` in `--step` splits text and command.
- **id**: leave it out: `A1`, `A2`… (unique with your decisions and edit requests, never reused).
- **from**: the decisions it came out of. Both cards show the link (D317 → "Actions A3", A3 → "From D317").
- **deadline**, **urgent**, **lane**, **links**, **context**: as for decisions.

### States

A step: `todo` → `done` (the person ticked it) → `checking` (you've been told; verify it) → `verified`, or `skipped`
(you couldn't verify it). You can send a step back to `todo` with a required note ("not done: the table still has old
rows"), which also moves a `checking` action back to `open`. You can also update a step's `checking` note while working.
The person can untick `done` and `checking` steps, not `verified`/`skipped` ones.

The action: `open` (some step still to do) → `checking` (every step ticked) → `done` (you close it). `agent`: the person
asked you to do it. `withdrawn`: moot. The hub moves it between `open`, `agent` and `checking` itself; only you close it.

### What you hear

Like an answer: in folders with `answers` set, one line in `inbox/answers.jsonl` (committed by `artipeek`, then the
`after` command), and always in `artipeek-decide answers` (kind `action`):

```json
{"at": "…", "uid": "3f9c…", "id": "A3", "kind": "action", "page": "artipeek:actions", "by": "…",
 "text": "ACTION: A3 \"Run the invoice backfill on db-server\": steps 1, 2 done by the person (2 of 4 steps done). Verify each ticked step (verified, or skipped if you can't check it), then mark the action done: artipeek-decide action show A3"}
```

Its text always starts with `ACTION:`, so a desk that reads only the text can't take it for an answer to a decision.
Ticks don't go out one by one: artipeek waits a minute after the last tick (five at most after the first), so five
ticks make one line, one commit, one `after` run, and a slip unticked within that minute never reaches you. Ticking the
last step, **I've done all the steps** (with the person's note: `note: …` in the text) and **Ask the agent to do it**
(`do it for me (note: …)`) go out at once. An untick of a step you are checking: `step 2 unticked (not done after all)`.

### Then

```bash
artipeek-decide action show A3                       # steps, states, commands, what the person sent
artipeek-decide action step A3 2 verified "12,400 rows updated, see the log"
artipeek-decide action step A3 4 skipped "can't read that channel"     # verify skipped
artipeek-decide action step A3 3 todo "the script stopped at batch 7; run it again"   # back to the person
artipeek-decide action done A3 "verified; relayed to the ERP hub"  # every step verified or skipped (--force: the rest skipped)
artipeek-decide action handback A3 "needs your 2FA code"            # asked to do it, you can't: back to the person
artipeek-decide action withdraw A3 "not needed after D320"
artipeek-decide actions [--status all]                # open, agent and checking ones by default
```

1. On a tick: check each `checking` step for real (logs, the database, the channel), then mark it `verified` (say what
   you saw) or `skipped` (say why you couldn't).
2. When every step is `verified` or `skipped`: `action done`, then decide what comes next: relay to your hub, update or
   close the decision it came from, raise a new decision or action.
3. On "do it for me": try it. Mark the steps you did `verified`, then `action done`; or `action handback` with why.
4. `action update A3 --file a.json` (or quick flags like `--urgent`, `--deadline`, `--step`) changes the title, context,
   steps… A step keeps its state while its text stays the same at the same place; a ticked step can't be changed or
   dropped (add a new step instead). `action handback A3 "why"` also reopens a `done` or `withdrawn` action.

Only the person ticks and asks (a login or an answer device, from artipeek's own page). Your token reads and writes
the action, sets step states and closes it; it can't tick for the person.

## API (if you don't use the CLI)

Every call: `Authorization: Bearer <token>`, JSON body with `Content-Type: application/json`. Not on the public
hostname. Errors come back as `{"ok": false, "error": "…"}` with 400/401/404.

| | |
|---|---|
| `GET /api/decisions/<folder>?status=open,later` | list (oldest first), each with notes, links, answers |
| `POST /api/decisions/<folder>` | raise (body as above) → `{"id", "url"}` |
| `GET /api/decisions/<folder>/<id>` | one |
| `PATCH /api/decisions/<folder>/<id>` | change fields (`from`/`dependsOn` replace the list) |
| `POST /api/decisions/<folder>/<id>/notes` | `{"body": "markdown", "kind": "update" \| "done"}` |
| `GET /api/answers/<folder>?since=<ISO>` | what the person sent (answers, explainer requests, edit requests as kind `edit`, action ticks as kind `action`; edit/action IDs appear in `decisionId`) |
| `GET /api/edits/<folder>?status=pending` | edit requests (`pending` by default; `done`, `declined`, `superseded`, `withdrawn`, `all`) |
| `GET /api/edits/<folder>/<id>` | one, with `diff`, `base` (the file as it was), `text` (the person's), `file` (where it is now) |
| `PATCH /api/edits/<folder>/<id>` | `{"status": "done" \| "declined", "note": "…"}` (declined needs a note) |
| `GET /api/actions/<folder>?status=open,agent,checking` | actions (default: those three; `all`), each with `steps`, `from`, `signals` (what was sent) |
| `POST /api/actions/<folder>` | raise (body as above) → `{"id", "url"}` |
| `GET /api/actions/<folder>/<id>` | one |
| `PATCH /api/actions/<folder>/<id>` | change fields, and/or `{"status": "done" \| "withdrawn" \| "open", "note", "force"}` (open = hand back or reopen; withdrawn and open need a note) |
| `PATCH /api/actions/<folder>/<id>/steps/<n>` | `{"state": "verified" \| "skipped" \| "checking" \| "todo", "note"}` (todo needs a note) |
