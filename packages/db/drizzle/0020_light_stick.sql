CREATE TABLE "entity_identity_keys" (
	"fingerprint" text PRIMARY KEY NOT NULL,
	"entity_id" uuid NOT NULL,
	"source_item_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entity_identity_keys" ADD CONSTRAINT "entity_identity_keys_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_identity_keys" ADD CONSTRAINT "entity_identity_keys_source_item_id_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE cascade ON UPDATE no action;