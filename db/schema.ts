// Decision hub: one SQLite database for the decisions of every project (an artipeek folder). Agents write it
// through the token API (see decisions.ts); the person answers on artipeek's decisions page. Times are ISO 8601 UTC.
import { sqliteTable, text, integer, primaryKey, index } from "drizzle-orm/sqlite-core";

export type Option = { value: string; label: string; recommended?: boolean; effect?: string };
// One question per decision is the common case (key may be empty). With two or more, each needs a key (Q1, Q2…),
// and the page sends all picks at once as "Q1 A, Q2 B".
export type Question = { key?: string; text?: string; options: Option[] };
export type Link = { label: string; href: string };

export const STATUSES = ["open", "later", "answered", "relayed", "closed", "withdrawn"] as const;
export type DecisionStatus = (typeof STATUSES)[number];

// One row per project: the sha256 of its agent token. A project is an artipeek folder (root) name.
export const projects = sqliteTable("projects", {
  name: text("name").primaryKey(),
  tokenHash: text("token_hash"),
  createdAt: text("created_at").notNull(),
});

export const decisions = sqliteTable("decisions", {
  project: text("project").notNull(),
  id: text("id").notNull(), // D15, F56, H9: unique within the project, never reused
  title: text("title").notNull(),
  lane: text("lane"),
  context: text("context").notNull().default(""), // Markdown (no raw HTML)
  questions: text("questions", { mode: "json" }).$type<Question[]>().notNull().default([]),
  deadline: text("deadline"), // ISO; null = none
  deadlineNote: text("deadline_note"), // "none; nothing here is urgent"
  ifNoAnswer: text("if_no_answer"),
  urgent: integer("urgent", { mode: "boolean" }).notNull().default(false), // the agent's flag; a near deadline also counts
  links: text("links", { mode: "json" }).$type<Link[]>().notNull().default([]),
  status: text("status").$type<DecisionStatus>().notNull().default("open"),
  resolution: text("resolution"), // the desk's line on what was decided (e.g. answers typed in a pane)
  explainerPath: text("explainer_path"), // a file in the project folder
  explainerRequestedAt: text("explainer_requested_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.project, t.id] }),
  index("decisions_created").on(t.createdAt),
  index("decisions_status").on(t.status),
]);

// Dated updates under a decision ("Update 20/11 10:40: two more PRs", "Done: merged").
export const notes = sqliteTable("decision_notes", {
  seq: integer("seq").primaryKey({ autoIncrement: true }),
  project: text("project").notNull(),
  decisionId: text("decision_id").notNull(),
  at: text("at").notNull(),
  kind: text("kind").$type<"update" | "done">().notNull().default("update"),
  body: text("body").notNull(), // Markdown
}, (t) => [index("notes_decision").on(t.project, t.decisionId)]);

// from = this decision came out of the other one; depends_on = it waits for the other one.
export const relations = sqliteTable("decision_relations", {
  project: text("project").notNull(),
  decisionId: text("decision_id").notNull(),
  kind: text("kind").$type<"from" | "depends_on">().notNull(),
  toProject: text("to_project").notNull(),
  toId: text("to_id").notNull(),
}, (t) => [
  primaryKey({ columns: [t.project, t.decisionId, t.kind, t.toProject, t.toId] }),
  index("relations_to").on(t.toProject, t.toId),
]);

// Only what the person sent from artipeek's page (its own sheet, a login or an answer device). Agents can't add rows.
export const answers = sqliteTable("decision_answers", {
  uid: text("uid").primaryKey(),
  project: text("project").notNull(),
  decisionId: text("decision_id").notNull(),
  at: text("at").notNull(),
  by: text("by").notNull(),
  kind: text("kind").$type<"answer" | "explain">().notNull().default("answer"),
  text: text("text").notNull(),
  page: text("page").notNull().default(""),
}, (t) => [index("answers_decision").on(t.project, t.decisionId, t.at)]);

// Edit requests: the person edits a file on artipeek's edit view, and artipeek hands the new text to the folder's
// agent instead of writing the file. The agent updates the file itself, then marks the request done or declined.
//   pending     sent, waiting for the agent
//   done        the agent updated the file (or the file came to have exactly the person's text)
//   declined    the agent didn't (its note says why)
//   superseded  the person sent a newer edit of the same file (that one's "replaces" names this one)
//   withdrawn   the person put the file's text back and sent that: leave the file as it is
export const EDIT_STATUSES = ["pending", "done", "declined", "superseded", "withdrawn"] as const;
export type EditStatus = (typeof EDIT_STATUSES)[number];
export const edits = sqliteTable("edit_requests", {
  project: text("project").notNull(),
  id: text("id").notNull(), // E1, E2…: unique within the project (decisions included), never reused
  path: text("path").notNull(), // the file, relative to the project folder
  base: text("base").notNull(), // the file's text when the edit was sent
  baseSha: text("base_sha").notNull(),
  text: text("text").notNull(), // the person's new text
  textSha: text("text_sha").notNull(),
  note: text("note"), // the person's note to the agent
  replaces: text("replaces"), // the pending edit of the same file this one superseded
  by: text("by").notNull(),
  status: text("status").$type<EditStatus>().notNull().default("pending"),
  resolution: text("resolution"), // the agent's note (or artipeek's, when the file came to have the text)
  resolvedBy: text("resolved_by").$type<"agent" | "artipeek" | "person">(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.project, t.id] }),
  index("edits_path").on(t.project, t.path, t.status),
]);

// Push (iOS app): the person's devices. Added only by the person (a login or an answer device), never by an agent.
// scope: "public" = registered through the public listener, so it only hears about the public folders.
export const pushDevices = sqliteTable("push_devices", {
  token: text("token").primaryKey(), // APNs device token (hex)
  environment: text("environment").$type<"sandbox" | "production">().notNull(),
  bundle: text("bundle").notNull(),
  name: text("name").notNull().default(""),
  by: text("by").notNull(),
  scope: text("scope").$type<"public" | "all">().notNull(),
  createdAt: text("created_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
});

// What the push notifier has handled, once per decision and kind ("new", "urgent"). sent = 0: seen but not pushed
// (history, an import, a decision that was already old when first seen).
export const pushSent = sqliteTable("push_sent", {
  project: text("project").notNull(),
  decisionId: text("decision_id").notNull(),
  kind: text("kind").$type<"new" | "urgent">().notNull(),
  at: text("at").notNull(),
  sent: integer("sent").notNull().default(0), // devices it reached
}, (t) => [primaryKey({ columns: [t.project, t.decisionId, t.kind] })]);
