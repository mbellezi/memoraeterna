CREATE TABLE "embeddings_1024" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"chunk_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"runtime" text NOT NULL,
	"usage" text DEFAULT 'retrieval' NOT NULL,
	"strategy" text DEFAULT 'native' NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"embedding" vector(1024) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "embeddings_1024" ADD CONSTRAINT "embeddings_1024_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "embeddings_1024_target_model_uidx" ON "embeddings_1024" USING btree ("target_type","target_id","model");--> statement-breakpoint
CREATE INDEX "embeddings_1024_chunk_id_idx" ON "embeddings_1024" USING btree ("chunk_id");--> statement-breakpoint
CREATE INDEX "embeddings_1024_embedding_hnsw_idx" ON "embeddings_1024" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
TRUNCATE TABLE "embeddings_256", "embeddings_768";--> statement-breakpoint
UPDATE "ai_profile_sets"
SET "local_model_id" = NULL, "model_id" = NULL, "runtime" = NULL, "capabilities" = '[]'::jsonb, "updated_at" = now()
WHERE "local_model_id" IN (
	SELECT "id" FROM "local_models"
	WHERE "catalog_id" IN ('gguf-embeddinggemma-300m-q8-0', 'gguf-multilingual-e5-base-q5-k-s')
);--> statement-breakpoint
DELETE FROM "local_models"
WHERE "catalog_id" IN ('gguf-embeddinggemma-300m-q8-0', 'gguf-multilingual-e5-base-q5-k-s');
