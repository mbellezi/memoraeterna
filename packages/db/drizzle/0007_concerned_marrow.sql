ALTER TABLE "ai_profile_tasks" DROP CONSTRAINT "ai_profile_tasks_provider_config_id_ai_provider_configs_id_fk";
--> statement-breakpoint
ALTER TABLE "ai_profile_tasks" DROP CONSTRAINT "ai_profile_tasks_local_model_id_local_models_id_fk";
--> statement-breakpoint
ALTER TABLE "ai_profile_sets" ADD COLUMN "provider_config_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_profile_sets" ADD COLUMN "local_model_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_profile_sets" ADD COLUMN "model_id" text;--> statement-breakpoint
ALTER TABLE "ai_profile_sets" ADD COLUMN "runtime" text;--> statement-breakpoint
ALTER TABLE "ai_profile_sets" ADD COLUMN "capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
WITH selected_models AS (
	SELECT DISTINCT ON (task.profile_id)
		task.profile_id,
		task.provider_config_id,
		task.local_model_id,
		task.model_id,
		task.runtime,
		COALESCE(local_model.capabilities, provider.metadata->'capabilities', task.required_capabilities, '[]'::jsonb) AS capabilities
	FROM ai_profile_tasks AS task
	LEFT JOIN ai_provider_configs AS provider ON provider.id = task.provider_config_id
	LEFT JOIN local_models AS local_model ON local_model.id = task.local_model_id
	WHERE task.status = 'active'
	ORDER BY task.profile_id, task.updated_at DESC, task.created_at DESC
)
UPDATE ai_profile_sets AS profile
SET provider_config_id = selected.provider_config_id,
	local_model_id = selected.local_model_id,
	model_id = selected.model_id,
	runtime = selected.runtime,
	capabilities = selected.capabilities
FROM selected_models AS selected
WHERE selected.profile_id = profile.id;--> statement-breakpoint
ALTER TABLE "ai_profile_sets" ADD CONSTRAINT "ai_profile_sets_provider_config_id_ai_provider_configs_id_fk" FOREIGN KEY ("provider_config_id") REFERENCES "public"."ai_provider_configs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_profile_sets" ADD CONSTRAINT "ai_profile_sets_local_model_id_local_models_id_fk" FOREIGN KEY ("local_model_id") REFERENCES "public"."local_models"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_profile_tasks" DROP COLUMN "provider_config_id";--> statement-breakpoint
ALTER TABLE "ai_profile_tasks" DROP COLUMN "local_model_id";--> statement-breakpoint
ALTER TABLE "ai_profile_tasks" DROP COLUMN "model_id";--> statement-breakpoint
ALTER TABLE "ai_profile_tasks" DROP COLUMN "runtime";--> statement-breakpoint
ALTER TABLE "ai_profile_tasks" DROP COLUMN "required_capabilities";
