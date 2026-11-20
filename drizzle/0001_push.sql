CREATE TABLE `push_devices` (
	`token` text PRIMARY KEY NOT NULL,
	`environment` text NOT NULL,
	`bundle` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`by` text NOT NULL,
	`scope` text NOT NULL,
	`created_at` text NOT NULL,
	`last_seen_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `push_sent` (
	`project` text NOT NULL,
	`decision_id` text NOT NULL,
	`kind` text NOT NULL,
	`at` text NOT NULL,
	`sent` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`project`, `decision_id`, `kind`)
);
