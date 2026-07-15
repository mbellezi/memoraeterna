CREATE UNIQUE INDEX "knowledge_generations_run_stage_uidx" ON "knowledge_generations" USING btree ("ingestion_run_id","stage") WHERE "knowledge_generations"."ingestion_run_id" is not null;
