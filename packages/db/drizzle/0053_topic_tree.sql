-- Topic Tree Engine tables (F2 T12; D1, D7, D9, D32). The I7 backstop indexes titles without case
-- or accents; unaccent() is only STABLE, so an IMMUTABLE wrapper pins its dictionary.
CREATE FUNCTION f_unaccent(text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;
--> statement-breakpoint
CREATE TABLE "topic_calibrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_key" text NOT NULL,
	"decider_key" text,
	"params" jsonb NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dataset" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topic_calibrations_json" CHECK (jsonb_typeof("topic_calibrations"."params") = 'object' and jsonb_typeof("topic_calibrations"."metrics") = 'object')
);
--> statement-breakpoint
CREATE TABLE "topic_change_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tree_id" uuid NOT NULL,
	"origin" text NOT NULL,
	"status" text NOT NULL,
	"title_key" text NOT NULL,
	"title_params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"risk" text DEFAULT 'low' NOT NULL,
	"undo_of" uuid,
	"job_id" uuid,
	"ai_task_run_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"generation" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"undone_at" timestamp with time zone,
	CONSTRAINT "topic_change_sets_origin" CHECK ("topic_change_sets"."origin" in ('build','place','gate','rebalance','audit','naming','areas','human','undo','rebuild')
        and ("topic_change_sets"."origin" = 'undo') = ("topic_change_sets"."undo_of" is not null)),
	CONSTRAINT "topic_change_sets_status" CHECK ("topic_change_sets"."status" in ('applied','undone','pending_review','dismissed')
        and ("topic_change_sets"."status" in ('applied','undone')) = ("topic_change_sets"."generation" is not null)
        and ("topic_change_sets"."status" in ('applied','undone')) = ("topic_change_sets"."applied_at" is not null)
        and ("topic_change_sets"."status" = 'undone') = ("topic_change_sets"."undone_at" is not null)),
	CONSTRAINT "topic_change_sets_risk" CHECK ("topic_change_sets"."risk" in ('low','medium','high')),
	CONSTRAINT "topic_change_sets_json" CHECK (char_length("topic_change_sets"."title_key") between 1 and 200 and jsonb_typeof("topic_change_sets"."title_params") = 'object'
        and jsonb_typeof("topic_change_sets"."ai_task_run_ids") = 'array' and jsonb_typeof("topic_change_sets"."summary") = 'object')
);
--> statement-breakpoint
CREATE TABLE "topic_daily_metrics" (
	"tree_id" uuid NOT NULL,
	"day" date NOT NULL,
	"ops_applied" integer DEFAULT 0 NOT NULL,
	"items_moved" integer DEFAULT 0 NOT NULL,
	"primary_path_changes" integer DEFAULT 0 NOT NULL,
	"unsorted_share" real,
	"mean_depth" real,
	"fanout_in_target" real,
	"hard_violations" integer,
	"soft_violations" integer,
	"gate_calls" integer DEFAULT 0 NOT NULL,
	"naming_calls" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topic_daily_metrics_tree_id_day_pk" PRIMARY KEY("tree_id","day"),
	CONSTRAINT "topic_daily_metrics_counts" CHECK ("topic_daily_metrics"."ops_applied" >= 0 and "topic_daily_metrics"."items_moved" >= 0 and "topic_daily_metrics"."primary_path_changes" >= 0
        and "topic_daily_metrics"."gate_calls" >= 0 and "topic_daily_metrics"."naming_calls" >= 0)
);
--> statement-breakpoint
CREATE TABLE "topic_gate_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tree_id" uuid NOT NULL,
	"item_kind" text NOT NULL,
	"item_id" uuid NOT NULL,
	"item_hash" text NOT NULL,
	"descriptor_set_hash" text NOT NULL,
	"decider_key" text NOT NULL,
	"candidates" jsonb NOT NULL,
	"chosen_topic_id" uuid,
	"none_of_these" boolean DEFAULT false NOT NULL,
	"ai_task_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topic_gate_decisions_decision" CHECK ("topic_gate_decisions"."item_kind" in ('note','source') and "topic_gate_decisions"."none_of_these" = ("topic_gate_decisions"."chosen_topic_id" is null)
        and jsonb_typeof("topic_gate_decisions"."candidates") = 'array')
);
--> statement-breakpoint
CREATE TABLE "topic_placements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tree_id" uuid NOT NULL,
	"item_kind" text NOT NULL,
	"note_id" uuid,
	"source_item_id" uuid,
	"root_source_item_id" uuid,
	"topic_id" uuid NOT NULL,
	"role" text NOT NULL,
	"rank" smallint NOT NULL,
	"management" text DEFAULT 'ai' NOT NULL,
	"decided_by" text NOT NULL,
	"item_fingerprint" text,
	"score" double precision,
	"margin" double precision,
	"centrality" real,
	"needs_gate" boolean DEFAULT false NOT NULL,
	"needs_split_check" boolean DEFAULT false NOT NULL,
	"needs_vector" boolean DEFAULT false NOT NULL,
	"moved_from_topic_id" uuid,
	"moved_at" timestamp with time zone,
	"change_set_id" uuid,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topic_placements_item" CHECK (("topic_placements"."item_kind" = 'note' and "topic_placements"."note_id" is not null and "topic_placements"."source_item_id" is null)
        or ("topic_placements"."item_kind" = 'source' and "topic_placements"."source_item_id" is not null and "topic_placements"."note_id" is null
            and "topic_placements"."root_source_item_id" is null)),
	CONSTRAINT "topic_placements_rank" CHECK ("topic_placements"."rank" between 0 and 2 and "topic_placements"."role" in ('primary','secondary')
        and ("topic_placements"."role" = 'primary') = ("topic_placements"."rank" = 0)),
	CONSTRAINT "topic_placements_decision" CHECK ("topic_placements"."management" in ('ai','human')
        and "topic_placements"."decided_by" in ('build','auto','gate','fallback','human','rebuild')
        and ("topic_placements"."item_fingerprint" is null or char_length("topic_placements"."item_fingerprint") between 1 and 200))
);
--> statement-breakpoint
CREATE TABLE "topic_stats" (
	"topic_id" uuid PRIMARY KEY NOT NULL,
	"space_key" text NOT NULL,
	"n" integer DEFAULT 0 NOT NULL,
	"ls" "bytea",
	"cos_sq_sum" double precision DEFAULT 0 NOT NULL,
	"low_cos_percentiles" real[] DEFAULT '{}'::real[] NOT NULL,
	"coherence" real,
	"direct_items" integer DEFAULT 0 NOT NULL,
	"children" integer DEFAULT 0 NOT NULL,
	"health" text DEFAULT 'good' NOT NULL,
	"violations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dirty" boolean DEFAULT true NOT NULL,
	"last_repair_at" timestamp with time zone,
	"repair_clock" bigint,
	"computed_at" timestamp with time zone,
	CONSTRAINT "topic_stats_counts" CHECK ("topic_stats"."n" >= 0 and "topic_stats"."direct_items" >= 0 and "topic_stats"."children" >= 0),
	CONSTRAINT "topic_stats_health" CHECK ("topic_stats"."health" in ('good','attention','violation') and jsonb_typeof("topic_stats"."violations") = 'array')
);
--> statement-breakpoint
CREATE TABLE "topic_structure_events" (
	"change_set_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"op" text NOT NULL,
	"topic_id" uuid,
	"item_kind" text,
	"item_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"ref_topic_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	CONSTRAINT "topic_structure_events_change_set_id_seq_pk" PRIMARY KEY("change_set_id","seq"),
	CONSTRAINT "topic_structure_events_op" CHECK ("topic_structure_events"."op" in ('topic.create','topic.retire','topic.restore','topic.move','topic.rename',
        'topic.describe','topic.manage','item.place','item.unplace','item.move') and "topic_structure_events"."seq" >= 0),
	CONSTRAINT "topic_structure_events_item" CHECK (("topic_structure_events"."item_kind" is null) = ("topic_structure_events"."item_id" is null)
        and ("topic_structure_events"."item_kind" is null or "topic_structure_events"."item_kind" in ('note','source')))
);
--> statement-breakpoint
CREATE TABLE "topic_trees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"space_key" text NOT NULL,
	"embedding_provider" text NOT NULL,
	"embedding_model" text NOT NULL,
	"embedding_runtime" text NOT NULL,
	"dimensions" smallint NOT NULL,
	"config" jsonb NOT NULL,
	"config_hash" text NOT NULL,
	"seed" bigint NOT NULL,
	"generation" bigint DEFAULT 0 NOT NULL,
	"clock" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	CONSTRAINT "topic_trees_status" CHECK ("topic_trees"."status" in ('active','retired')),
	CONSTRAINT "topic_trees_life" CHECK (("topic_trees"."status" = 'retired') = ("topic_trees"."retired_at" is not null)
        and ("topic_trees"."status" <> 'active' or "topic_trees"."activated_at" is not null)),
	CONSTRAINT "topic_trees_dimensions" CHECK ("topic_trees"."dimensions" in (256,768,1024)),
	CONSTRAINT "topic_trees_counters" CHECK ("topic_trees"."generation" >= 0 and "topic_trees"."clock" >= 0),
	CONSTRAINT "topic_trees_text" CHECK (char_length("topic_trees"."space_key") between 1 and 300 and char_length("topic_trees"."config_hash") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tree_id" uuid NOT NULL,
	"parent_id" uuid,
	"role" text DEFAULT 'topic' NOT NULL,
	"title" text,
	"name_state" text DEFAULT 'unnamed' NOT NULL,
	"name_source" text,
	"name_language" varchar(16),
	"named_change_set_id" uuid,
	"description" text,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"management" text DEFAULT 'ai' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"retired_at" timestamp with time zone,
	"redirect_to" uuid,
	"created_change_set_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topics_role" CHECK ("topics"."role" in ('root','topic')),
	CONSTRAINT "topics_parent" CHECK ("topics"."parent_id" is distinct from "topics"."id" and ("topics"."role" = 'root') = ("topics"."parent_id" is null)),
	CONSTRAINT "topics_name_state" CHECK ("topics"."name_state" in ('named','provisional','unnamed')
        and ("topics"."name_source" is null or "topics"."name_source" in ('llm','human','tfidf'))
        and ("topics"."role" = 'root' or ("topics"."name_state" = 'unnamed') = ("topics"."title" is null))),
	CONSTRAINT "topics_text" CHECK (("topics"."title" is null or char_length("topics"."title") between 1 and 120)
        and ("topics"."description" is null or char_length("topics"."description") between 1 and 400)
        and ("topics"."name_language" is null or char_length("topics"."name_language") >= 1)
        and jsonb_typeof("topics"."aliases") = 'array' and jsonb_array_length("topics"."aliases") <= 10),
	CONSTRAINT "topics_management" CHECK ("topics"."management" in ('ai','human','pinned')),
	CONSTRAINT "topics_position" CHECK ("topics"."position" >= 0),
	CONSTRAINT "topics_redirect" CHECK (("topics"."redirect_to" is null or "topics"."retired_at" is not null) and "topics"."redirect_to" is distinct from "topics"."id")
);
--> statement-breakpoint
ALTER TABLE "topic_change_sets" ADD CONSTRAINT "topic_change_sets_tree_id_topic_trees_id_fk" FOREIGN KEY ("tree_id") REFERENCES "public"."topic_trees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_change_sets" ADD CONSTRAINT "topic_change_sets_undo_of_topic_change_sets_id_fk" FOREIGN KEY ("undo_of") REFERENCES "public"."topic_change_sets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_change_sets" ADD CONSTRAINT "topic_change_sets_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_daily_metrics" ADD CONSTRAINT "topic_daily_metrics_tree_id_topic_trees_id_fk" FOREIGN KEY ("tree_id") REFERENCES "public"."topic_trees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_gate_decisions" ADD CONSTRAINT "topic_gate_decisions_tree_id_topic_trees_id_fk" FOREIGN KEY ("tree_id") REFERENCES "public"."topic_trees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_gate_decisions" ADD CONSTRAINT "topic_gate_decisions_ai_task_run_id_ai_task_runs_id_fk" FOREIGN KEY ("ai_task_run_id") REFERENCES "public"."ai_task_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_placements" ADD CONSTRAINT "topic_placements_tree_id_topic_trees_id_fk" FOREIGN KEY ("tree_id") REFERENCES "public"."topic_trees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_placements" ADD CONSTRAINT "topic_placements_note_id_atomic_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."atomic_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_placements" ADD CONSTRAINT "topic_placements_source_item_id_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_placements" ADD CONSTRAINT "topic_placements_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_placements" ADD CONSTRAINT "topic_placements_change_set_id_topic_change_sets_id_fk" FOREIGN KEY ("change_set_id") REFERENCES "public"."topic_change_sets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_stats" ADD CONSTRAINT "topic_stats_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_structure_events" ADD CONSTRAINT "topic_structure_events_change_set_id_topic_change_sets_id_fk" FOREIGN KEY ("change_set_id") REFERENCES "public"."topic_change_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_tree_id_topic_trees_id_fk" FOREIGN KEY ("tree_id") REFERENCES "public"."topic_trees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_parent_id_topics_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."topics"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_redirect_to_topics_id_fk" FOREIGN KEY ("redirect_to") REFERENCES "public"."topics"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "topic_calibrations_active_uidx" ON "topic_calibrations" USING btree ("space_key",coalesce("decider_key", '')) WHERE "topic_calibrations"."active";--> statement-breakpoint
CREATE INDEX "topic_change_sets_tree_created_idx" ON "topic_change_sets" USING btree ("tree_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "topic_change_sets_generation_uidx" ON "topic_change_sets" USING btree ("tree_id","generation") WHERE "topic_change_sets"."generation" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "topic_gate_decisions_cache_uidx" ON "topic_gate_decisions" USING btree ("item_hash","descriptor_set_hash","decider_key");--> statement-breakpoint
CREATE INDEX "topic_gate_decisions_item_idx" ON "topic_gate_decisions" USING btree ("item_kind","item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "topic_placements_item_rank_uidx" ON "topic_placements" USING btree ("tree_id","item_kind",coalesce("note_id", "source_item_id"),"rank");--> statement-breakpoint
CREATE UNIQUE INDEX "topic_placements_item_topic_uidx" ON "topic_placements" USING btree ("tree_id","item_kind",coalesce("note_id", "source_item_id"),"topic_id");--> statement-breakpoint
CREATE INDEX "topic_placements_topic_role_idx" ON "topic_placements" USING btree ("topic_id","role","centrality" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "topic_placements_note_idx" ON "topic_placements" USING btree ("note_id") WHERE "topic_placements"."note_id" is not null;--> statement-breakpoint
CREATE INDEX "topic_placements_source_idx" ON "topic_placements" USING btree ("source_item_id") WHERE "topic_placements"."source_item_id" is not null;--> statement-breakpoint
CREATE INDEX "topic_placements_flagged_idx" ON "topic_placements" USING btree ("tree_id") WHERE "topic_placements"."needs_gate" or "topic_placements"."needs_split_check" or "topic_placements"."needs_vector";--> statement-breakpoint
CREATE INDEX "topic_stats_dirty_idx" ON "topic_stats" USING btree ("topic_id") WHERE "topic_stats"."dirty";--> statement-breakpoint
CREATE INDEX "topic_structure_events_topic_idx" ON "topic_structure_events" USING btree ("topic_id") WHERE "topic_structure_events"."topic_id" is not null;--> statement-breakpoint
CREATE INDEX "topic_structure_events_item_idx" ON "topic_structure_events" USING btree ("item_kind","item_id") WHERE "topic_structure_events"."item_id" is not null;--> statement-breakpoint
CREATE INDEX "topic_structure_events_refs_idx" ON "topic_structure_events" USING gin ("ref_topic_ids");--> statement-breakpoint
CREATE UNIQUE INDEX "topic_trees_active_uidx" ON "topic_trees" USING btree ("status") WHERE "topic_trees"."status" = 'active';--> statement-breakpoint
CREATE INDEX "topics_children_idx" ON "topics" USING btree ("tree_id","parent_id","position") WHERE "topics"."retired_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "topics_tree_root_uidx" ON "topics" USING btree ("tree_id") WHERE "topics"."role" = 'root' and "topics"."retired_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "topics_sibling_title_uidx" ON "topics" USING btree ("parent_id",f_unaccent(lower("title"))) WHERE "topics"."retired_at" is null and "topics"."title" is not null;
--> statement-breakpoint
-- D9: the engine is the single writer of AI-managed topic structure. Inserting an AI-managed topic,
-- or changing the parent or management of a topic that is or becomes AI-managed, is refused unless
-- the transaction set memora.topic_writer = 'engine'. The same trigger keeps a parent in the
-- topic's own tree and refuses cycles.
CREATE FUNCTION topics_parent_writer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ancestor uuid;
  hops integer := 0;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.parent_id IS NOT DISTINCT FROM OLD.parent_id
     AND NEW.management = OLD.management THEN
    RETURN NEW;
  END IF;
  IF (NEW.management = 'ai' OR (TG_OP = 'UPDATE' AND OLD.management = 'ai'))
     AND current_setting('memora.topic_writer', true) IS DISTINCT FROM 'engine' THEN
    RAISE EXCEPTION 'topics.errors.writerGuard';
  END IF;
  IF NEW.parent_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.parent_id IS DISTINCT FROM OLD.parent_id) THEN
    IF NOT EXISTS (SELECT 1 FROM topics p WHERE p.id = NEW.parent_id AND p.tree_id = NEW.tree_id) THEN
      RAISE EXCEPTION 'topics.errors.parentTree';
    END IF;
    ancestor := NEW.parent_id;
    WHILE ancestor IS NOT NULL LOOP
      hops := hops + 1;
      IF ancestor = NEW.id OR hops > 64 THEN
        RAISE EXCEPTION 'topics.errors.cycle';
      END IF;
      SELECT p.parent_id INTO ancestor FROM topics p WHERE p.id = ancestor;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER topics_parent_writer_guard BEFORE INSERT OR UPDATE OF parent_id, management ON topics
  FOR EACH ROW EXECUTE FUNCTION topics_parent_writer_guard();
--> statement-breakpoint
-- D32: placements leave with their items by cascade. Every delete marks the statistics of the topics
-- that held them, of their ancestors and, for a note's primary placement, of its root source's primary
-- path (the source may count again, D8) dirty; topic-sweep recomputes them. Rows are locked root
-- first and updated even when already dirty, so a mark waits for a recompute holding them and lands
-- after it instead of being lost.
CREATE FUNCTION topic_placements_mark_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM removed) THEN
    RETURN NULL;
  END IF;
  WITH RECURSIVE touched AS (
    SELECT r.topic_id AS id FROM removed r
    UNION
    SELECT p.topic_id FROM removed r
      JOIN topic_placements p ON p.tree_id = r.tree_id AND p.item_kind = 'source'
       AND p.source_item_id = r.root_source_item_id AND p.rank = 0
     WHERE r.item_kind = 'note' AND r.rank = 0 AND r.root_source_item_id IS NOT NULL
  ), path AS (
    SELECT t.id, t.parent_id FROM topics t JOIN touched ON t.id = touched.id
    UNION
    SELECT t.id, t.parent_id FROM topics t JOIN path ON t.id = path.parent_id
  ), locked AS (
    SELECT s.topic_id FROM topic_stats s JOIN path ON path.id = s.topic_id
     ORDER BY (path.parent_id IS NULL) DESC, s.topic_id FOR UPDATE OF s
  )
  UPDATE topic_stats s SET dirty = true FROM locked WHERE s.topic_id = locked.topic_id;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER topic_placements_mark_dirty AFTER DELETE ON topic_placements
  REFERENCING OLD TABLE AS removed FOR EACH STATEMENT EXECUTE FUNCTION topic_placements_mark_dirty();
