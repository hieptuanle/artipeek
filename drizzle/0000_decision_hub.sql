CREATE TABLE `decision_answers` (
	`uid` text PRIMARY KEY NOT NULL,
	`project` text NOT NULL,
	`decision_id` text NOT NULL,
	`at` text NOT NULL,
	`by` text NOT NULL,
	`kind` text DEFAULT 'answer' NOT NULL,
	`text` text NOT NULL,
	`page` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `answers_decision` ON `decision_answers` (`project`,`decision_id`,`at`);--> statement-breakpoint
CREATE TABLE `decisions` (
	`project` text NOT NULL,
	`id` text NOT NULL,
	`title` text NOT NULL,
	`lane` text,
	`context` text DEFAULT '' NOT NULL,
	`questions` text DEFAULT '[]' NOT NULL,
	`deadline` text,
	`deadline_note` text,
	`if_no_answer` text,
	`urgent` integer DEFAULT false NOT NULL,
	`links` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`resolution` text,
	`explainer_path` text,
	`explainer_requested_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`project`, `id`)
);
--> statement-breakpoint
CREATE INDEX `decisions_created` ON `decisions` (`created_at`);--> statement-breakpoint
CREATE INDEX `decisions_status` ON `decisions` (`status`);--> statement-breakpoint
CREATE TABLE `decision_notes` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project` text NOT NULL,
	`decision_id` text NOT NULL,
	`at` text NOT NULL,
	`kind` text DEFAULT 'update' NOT NULL,
	`body` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notes_decision` ON `decision_notes` (`project`,`decision_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`name` text PRIMARY KEY NOT NULL,
	`token_hash` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `decision_relations` (
	`project` text NOT NULL,
	`decision_id` text NOT NULL,
	`kind` text NOT NULL,
	`to_project` text NOT NULL,
	`to_id` text NOT NULL,
	PRIMARY KEY(`project`, `decision_id`, `kind`, `to_project`, `to_id`)
);
--> statement-breakpoint
CREATE INDEX `relations_to` ON `decision_relations` (`to_project`,`to_id`);