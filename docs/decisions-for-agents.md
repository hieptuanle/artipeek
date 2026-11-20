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
| `GET /api/answers/<folder>?since=<ISO>` | what the person sent (answers and explainer requests) |
