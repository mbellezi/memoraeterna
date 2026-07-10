ALTER TABLE "integration_clients" ADD COLUMN "capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_clients" ADD COLUMN "contract_version" text DEFAULT '1.0.0' NOT NULL;--> statement-breakpoint
ALTER TABLE "obsidian_sync_files" ADD COLUMN "memora_id" uuid;--> statement-breakpoint
ALTER TABLE "obsidian_sync_files" ADD COLUMN "entity_type" text;--> statement-breakpoint
ALTER TABLE "obsidian_sync_files" ADD COLUMN "entity_id" uuid;--> statement-breakpoint
ALTER TABLE "obsidian_sync_files" ADD COLUMN "frontmatter_hash" text;--> statement-breakpoint
UPDATE "obsidian_sync_files"
SET "memora_id" = coalesce("source_item_id", "document_id", "id"),
    "entity_type" = CASE WHEN "memora_type" = 'atomic_note' THEN 'atomic_note' ELSE 'source_item' END,
    "entity_id" = coalesce("source_item_id", "document_id", "id"),
    "frontmatter_hash" = "content_hash";--> statement-breakpoint
ALTER TABLE "obsidian_sync_files" ALTER COLUMN "memora_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "obsidian_sync_files" ALTER COLUMN "entity_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "obsidian_sync_files" ALTER COLUMN "entity_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "obsidian_sync_files" ALTER COLUMN "frontmatter_hash" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "obsidian_sync_files_memora_id_uidx" ON "obsidian_sync_files" USING btree ("memora_id");
