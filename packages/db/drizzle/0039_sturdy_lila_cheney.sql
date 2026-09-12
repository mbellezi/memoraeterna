CREATE TABLE "obsidian_layout_migrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"binding" text NOT NULL,
	"status" text DEFAULT 'preview' NOT NULL,
	"config" jsonb NOT NULL,
	"previous_config" jsonb,
	"targets" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "obsidian_layout_binding_idx" ON "obsidian_layout_migrations" USING btree ("binding","created_at");