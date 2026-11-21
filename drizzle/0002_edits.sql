CREATE TABLE `edit_requests` (
	`project` text NOT NULL,
	`id` text NOT NULL,
	`path` text NOT NULL,
	`base` text NOT NULL,
	`base_sha` text NOT NULL,
	`text` text NOT NULL,
	`text_sha` text NOT NULL,
	`note` text,
	`replaces` text,
	`by` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`resolution` text,
	`resolved_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`project`, `id`)
);
--> statement-breakpoint
CREATE INDEX `edits_path` ON `edit_requests` (`project`,`path`,`status`);