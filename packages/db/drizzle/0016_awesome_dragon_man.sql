CREATE TABLE "ai_task_run_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ai_task_run_id" uuid NOT NULL,
	"source_item_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_task_run_sources" ADD CONSTRAINT "ai_task_run_sources_ai_task_run_id_ai_task_runs_id_fk" FOREIGN KEY ("ai_task_run_id") REFERENCES "public"."ai_task_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_task_run_sources" ADD CONSTRAINT "ai_task_run_sources_source_item_id_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_task_run_sources_run_source_uidx" ON "ai_task_run_sources" USING btree ("ai_task_run_id","source_item_id");--> statement-breakpoint
CREATE INDEX "ai_task_run_sources_source_item_id_idx" ON "ai_task_run_sources" USING btree ("source_item_id");--> statement-breakpoint
INSERT INTO "ai_task_run_sources" ("ai_task_run_id", "source_item_id")
SELECT DISTINCT link.ai_task_run_id, link.source_item_id
FROM (
	SELECT ai_task_run_id, source_item_id
	FROM source_summaries
	WHERE ai_task_run_id IS NOT NULL
	UNION ALL
	SELECT ai_task_run_id, created_from_source_item_id
	FROM atomic_notes
	WHERE ai_task_run_id IS NOT NULL
	UNION ALL
	SELECT ai_task_run_id, source_item_id
	FROM knowledge_generations
	WHERE ai_task_run_id IS NOT NULL
) link
ON CONFLICT ("ai_task_run_id", "source_item_id") DO NOTHING;--> statement-breakpoint
INSERT INTO "ai_task_run_sources" ("ai_task_run_id", "source_item_id")
SELECT DISTINCT run.id, artifact.source_item_id
FROM (
	SELECT source_item_id, jsonb_array_elements_text(
		CASE WHEN jsonb_typeof(metadata -> 'aiTaskRunIds') = 'array'
			THEN metadata -> 'aiTaskRunIds' ELSE '[]'::jsonb END
	) AS run_id
	FROM source_summaries
	UNION ALL
	SELECT source_item_id, jsonb_array_elements_text(
		CASE WHEN jsonb_typeof(metadata -> 'aiTaskRunIds') = 'array'
			THEN metadata -> 'aiTaskRunIds' ELSE '[]'::jsonb END
	) AS run_id
	FROM knowledge_generations
) artifact
JOIN ai_task_runs run ON run.id::text = artifact.run_id
ON CONFLICT ("ai_task_run_id", "source_item_id") DO NOTHING;--> statement-breakpoint
INSERT INTO "ai_task_run_sources" ("ai_task_run_id", "source_item_id")
SELECT DISTINCT run.id, chunk.source_item_id
FROM ai_task_runs run
JOIN chunks chunk ON chunk.content_hash = run.input_hash
WHERE run.task_type = 'embedding'
ON CONFLICT ("ai_task_run_id", "source_item_id") DO NOTHING;
