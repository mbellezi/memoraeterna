ALTER TABLE "bibliographic_instances" ADD COLUMN "creators" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "bibliographic_instances" ADD COLUMN "page_count" integer;--> statement-breakpoint
ALTER TABLE "bibliographic_instances" ADD COLUMN "series" text;--> statement-breakpoint
ALTER TABLE "bibliographic_works" ADD COLUMN "creators" jsonb DEFAULT '[]'::jsonb NOT NULL;