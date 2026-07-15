DROP INDEX "document_divisions_child_source_uidx";--> statement-breakpoint
CREATE INDEX "document_divisions_child_source_idx" ON "document_divisions" USING btree ("child_source_item_id");
