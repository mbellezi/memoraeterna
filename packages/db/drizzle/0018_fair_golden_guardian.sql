CREATE TABLE "relation_type_aliases" (
	"alias" text PRIMARY KEY NOT NULL,
	"relation_type_id" uuid NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relation_type_embeddings_1024" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"relation_type_id" uuid NOT NULL,
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
CREATE TABLE "relation_type_embeddings_256" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"relation_type_id" uuid NOT NULL,
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
CREATE TABLE "relation_type_embeddings_768" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"relation_type_id" uuid NOT NULL,
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
CREATE TABLE "relation_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"predicate" text NOT NULL,
	"definition" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entity_relations" ADD COLUMN "relation_type_id" uuid;--> statement-breakpoint
ALTER TABLE "relation_type_aliases" ADD CONSTRAINT "relation_type_aliases_relation_type_id_relation_types_id_fk" FOREIGN KEY ("relation_type_id") REFERENCES "public"."relation_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_type_embeddings_1024" ADD CONSTRAINT "relation_type_embeddings_1024_relation_type_id_relation_types_id_fk" FOREIGN KEY ("relation_type_id") REFERENCES "public"."relation_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_type_embeddings_256" ADD CONSTRAINT "relation_type_embeddings_256_relation_type_id_relation_types_id_fk" FOREIGN KEY ("relation_type_id") REFERENCES "public"."relation_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_type_embeddings_768" ADD CONSTRAINT "relation_type_embeddings_768_relation_type_id_relation_types_id_fk" FOREIGN KEY ("relation_type_id") REFERENCES "public"."relation_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "relation_type_embeddings_1024_type_space_uidx" ON "relation_type_embeddings_1024" USING btree ("relation_type_id","space_key");--> statement-breakpoint
CREATE UNIQUE INDEX "relation_type_embeddings_256_type_space_uidx" ON "relation_type_embeddings_256" USING btree ("relation_type_id","space_key");--> statement-breakpoint
CREATE UNIQUE INDEX "relation_type_embeddings_768_type_space_uidx" ON "relation_type_embeddings_768" USING btree ("relation_type_id","space_key");--> statement-breakpoint
CREATE UNIQUE INDEX "relation_types_predicate_uidx" ON "relation_types" USING btree ("predicate");--> statement-breakpoint
ALTER TABLE "entity_relations" ADD CONSTRAINT "entity_relations_relation_type_id_relation_types_id_fk" FOREIGN KEY ("relation_type_id") REFERENCES "public"."relation_types"("id") ON DELETE restrict ON UPDATE no action;