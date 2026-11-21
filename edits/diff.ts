// The change an edit request makes, as a unified diff: for the person (the sheet before Send, the bar on the file's
// page) and for the agent (artipeek-decide edit show).
import { createTwoFilesPatch } from "diff";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export type EditDiff = { patch: string; added: number; removed: number; html: string };

export function editDiff(rel: string, base: string, text: string, maxLines = 400): EditDiff {
  const patch = createTwoFilesPatch(`a/${rel}`, `b/${rel}`, base, text, "", "", { context: 3 });
  const lines = patch.split("\n");
  const start = lines.findIndex((l) => l.startsWith("@@"));
  const body = start < 0 ? [] : lines.slice(start).filter((l, i, a) => l !== "" || i < a.length - 1);
  let added = 0, removed = 0;
  for (const l of body) { if (l.startsWith("+")) added++; else if (l.startsWith("-")) removed++; }
  const cls = (l: string) => (l.startsWith("@@") ? "dh" : l.startsWith("+") ? "da" : l.startsWith("-") ? "dd" : l.startsWith("\\") ? "dn" : "dc");
  const shown = body.slice(0, maxLines).map((l) => `<span class="${cls(l)}">${esc(l) || " "}</span>`).join("\n");
  const more = body.length > maxLines ? `\n<span class="dn">… ${body.length - maxLines} more lines</span>` : "";
  return { patch: start < 0 ? "" : lines.slice(start - 2).join("\n"), added, removed, html: `<pre class="diff">${shown}${more}</pre>` };
}
