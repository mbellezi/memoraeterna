-- Owner decision 19 (F2): a gated placement that meets no validated decider is the gate's "none",
-- recorded as `decided_by = 'fallback-none'`, so the gate decides it again once a ranker validates.
ALTER TABLE "topic_placements" DROP CONSTRAINT "topic_placements_decision";--> statement-breakpoint
ALTER TABLE "topic_placements" ADD CONSTRAINT "topic_placements_decision" CHECK ("topic_placements"."management" in ('ai','human')
        and "topic_placements"."decided_by" in ('build','auto','gate','fallback','fallback-none','human','rebuild')
        and ("topic_placements"."item_fingerprint" is null or char_length("topic_placements"."item_fingerprint") between 1 and 200));