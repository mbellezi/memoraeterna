ALTER TABLE "document_divisions" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "document_divisions" ADD COLUMN "stable_id" uuid NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "document_divisions_structure_stable_uidx" ON "document_divisions" USING btree ("structure_id","stable_id");
