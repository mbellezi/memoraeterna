CREATE TABLE "view_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"object_id" uuid NOT NULL,
	"address" text NOT NULL,
	"title" text NOT NULL,
	"parent_address" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"open_count" integer DEFAULT 1 NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"pinned_at" timestamp with time zone,
	CONSTRAINT "view_history_kind" CHECK ("view_history"."kind" in ('source','note','topic','question','entity')),
	CONSTRAINT "view_history_address" CHECK ("view_history"."address" = 'memora://' || "view_history"."kind" || '/' || "view_history"."object_id"::text),
	CONSTRAINT "view_history_title" CHECK (char_length("view_history"."title") between 1 and 300),
	CONSTRAINT "view_history_open_count" CHECK ("view_history"."open_count" >= 1),
	CONSTRAINT "view_history_pin" CHECK (("view_history"."pinned") = ("view_history"."pinned_at" is not null)),
	CONSTRAINT "view_history_parent" CHECK ("view_history"."parent_address" is null or "view_history"."parent_address" like 'memora://%/%')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "view_history_address_uidx" ON "view_history" USING btree ("address");--> statement-breakpoint
CREATE INDEX "view_history_order_idx" ON "view_history" USING btree ("pinned","opened_at");