DROP INDEX "atomic_notes_source_generation_key_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX "source_summaries_current_source_uidx" ON "source_summaries" USING btree ("source_item_id") WHERE "source_summaries"."is_current" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "atomic_notes_source_generation_key_uidx" ON "atomic_notes" USING btree ("created_from_source_item_id","generation_id","generation_key");
