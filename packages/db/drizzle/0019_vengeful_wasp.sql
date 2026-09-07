CREATE TABLE "entity_identity_embeddings_1024" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"space_key" text NOT NULL,
	"content_hash" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"runtime" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_identity_embeddings_256" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"space_key" text NOT NULL,
	"content_hash" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"runtime" text NOT NULL,
	"embedding" vector(256) NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_identity_embeddings_768" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"space_key" text NOT NULL,
	"content_hash" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"runtime" text NOT NULL,
	"embedding" vector(768) NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "entities_type_normalized_name_uidx";--> statement-breakpoint
ALTER TABLE "entity_identity_embeddings_1024" ADD CONSTRAINT "entity_identity_embeddings_1024_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_identity_embeddings_256" ADD CONSTRAINT "entity_identity_embeddings_256_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_identity_embeddings_768" ADD CONSTRAINT "entity_identity_embeddings_768_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "entity_identity_embeddings_1024_entity_space_uidx" ON "entity_identity_embeddings_1024" USING btree ("entity_id","space_key");--> statement-breakpoint
CREATE UNIQUE INDEX "entity_identity_embeddings_256_entity_space_uidx" ON "entity_identity_embeddings_256" USING btree ("entity_id","space_key");--> statement-breakpoint
CREATE UNIQUE INDEX "entity_identity_embeddings_768_entity_space_uidx" ON "entity_identity_embeddings_768" USING btree ("entity_id","space_key");--> statement-breakpoint
CREATE INDEX "entities_type_normalized_name_idx" ON "entities" USING btree ("type","normalized_name");