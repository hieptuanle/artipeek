CREATE TABLE `action_relations` (
	`project` text NOT NULL,
	`action_id` text NOT NULL,
	`to_project` text NOT NULL,
	`to_id` text NOT NULL,
	PRIMARY KEY(`project`, `action_id`, `to_project`, `to_id`)
);
--> statement-breakpoint
CREATE INDEX `action_relations_to` ON `action_relations` (`to_project`,`to_id`);--> statement-breakpoint
CREATE TABLE `action_signals` (
	`uid` text PRIMARY KEY NOT NULL,
	`project` text NOT NULL,
	`action_id` text NOT NULL,
	`at` text NOT NULL,
	`by` text NOT NULL,
	`text` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `action_signals_project` ON `action_signals` (`project`,`at`);--> statement-breakpoint
CREATE TABLE `action_steps` (
	`project` text NOT NULL,
	`action_id` text NOT NULL,
	`n` integer NOT NULL,
	`text` text NOT NULL,
	`command` text,
	`where_to` text,
	`links` text DEFAULT '[]' NOT NULL,
	`state` text DEFAULT 'todo' NOT NULL,
	`told` text DEFAULT 'todo' NOT NULL,
	`done_at` text,
	`done_by` text,
	`checked_at` text,
	`note` text,
	PRIMARY KEY(`project`, `action_id`, `n`)
);
--> statement-breakpoint
CREATE TABLE `actions` (
	`project` text NOT NULL,
	`id` text NOT NULL,
	`title` text NOT NULL,
	`lane` text,
	`context` text DEFAULT '' NOT NULL,
	`links` text DEFAULT '[]' NOT NULL,
	`deadline` text,
	`urgent` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`resolution` text,
	`agent_asked_at` text,
	`agent_note` text,
	`agent_by` text,
	`agent_heard` integer DEFAULT true NOT NULL,
	`person_note` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`project`, `id`)
);
--> statement-breakpoint
CREATE INDEX `actions_created` ON `actions` (`created_at`);--> statement-breakpoint
CREATE INDEX `actions_status` ON `actions` (`status`);