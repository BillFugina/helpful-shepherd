CREATE TYPE "public"."contract_type" AS ENUM('equity_itc', 'sdc', 'non_union');--> statement-breakpoint
CREATE TYPE "public"."pipeline_status" AS ENUM('offer_accepted', 'contract_sent', 'contract_signed', 'paperwork_complete', 'travel_booked', 'arrived', 'departed');--> statement-breakpoint
CREATE TYPE "public"."program" AS ENUM('main_stage', 'childrens_theatre');--> statement-breakpoint
CREATE TABLE "agent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"agency" text,
	"email" text,
	"phone" text,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conflict" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"engagement_id" uuid NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conflict_dates_in_order" CHECK ("conflict"."starts_on" <= "conflict"."ends_on")
);
--> statement-breakpoint
CREATE TABLE "engagement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"production_id" uuid NOT NULL,
	"agent_id" uuid,
	"role" text NOT NULL,
	"contract_type" "contract_type" NOT NULL,
	"pipeline_status" "pipeline_status" DEFAULT 'offer_accepted' NOT NULL,
	"weekly_pay_cents" integer,
	"commission_percent" numeric(5, 2),
	"weekly_stipend_cents" integer,
	"travel_provided" boolean DEFAULT false NOT NULL,
	"car_provided" boolean DEFAULT false NOT NULL,
	"housing_provided" boolean DEFAULT false NOT NULL,
	"preferred_arrival" date,
	"preferred_departure" date,
	"script_needed" boolean DEFAULT false NOT NULL,
	"comp_allotment" integer DEFAULT 2 NOT NULL,
	"notes" text,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "engagement_person_production_uq" UNIQUE("person_id","production_id"),
	CONSTRAINT "engagement_money_not_negative" CHECK (coalesce("engagement"."weekly_pay_cents", 0) >= 0 and coalesce("engagement"."weekly_stipend_cents", 0) >= 0),
	CONSTRAINT "engagement_commission_range" CHECK ("engagement"."commission_percent" is null or "engagement"."commission_percent" between 0 and 100),
	CONSTRAINT "engagement_comps_not_negative" CHECK ("engagement"."comp_allotment" >= 0),
	CONSTRAINT "engagement_travel_dates_in_order" CHECK ("engagement"."preferred_arrival" is null or "engagement"."preferred_departure" is null or "engagement"."preferred_arrival" <= "engagement"."preferred_departure")
);
--> statement-breakpoint
CREATE TABLE "production" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"season_id" uuid NOT NULL,
	"title" text NOT NULL,
	"rehearsal_start" date,
	"tech_start" date,
	"opening" date,
	"closing" date,
	"performance_schedule" text,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "production_rehearsal_before_tech" CHECK ("production"."rehearsal_start" is null or "production"."tech_start" is null or "production"."rehearsal_start" <= "production"."tech_start"),
	CONSTRAINT "production_tech_before_opening" CHECK ("production"."tech_start" is null or "production"."opening" is null or "production"."tech_start" <= "production"."opening"),
	CONSTRAINT "production_rehearsal_before_opening" CHECK ("production"."rehearsal_start" is null or "production"."opening" is null or "production"."rehearsal_start" <= "production"."opening"),
	CONSTRAINT "production_opening_before_closing" CHECK ("production"."opening" is null or "production"."closing" is null or "production"."opening" <= "production"."closing"),
	CONSTRAINT "production_rehearsal_before_closing" CHECK ("production"."rehearsal_start" is null or "production"."closing" is null or "production"."rehearsal_start" <= "production"."closing"),
	CONSTRAINT "production_tech_before_closing" CHECK ("production"."tech_start" is null or "production"."closing" is null or "production"."tech_start" <= "production"."closing")
);
--> statement-breakpoint
CREATE TABLE "season" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"program" "program" DEFAULT 'main_stage' NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "season_dates_in_order" CHECK ("season"."starts_on" <= "season"."ends_on")
);
--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "airport_prefs" text;--> statement-breakpoint
ALTER TABLE "conflict" ADD CONSTRAINT "conflict_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagement"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement" ADD CONSTRAINT "engagement_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement" ADD CONSTRAINT "engagement_production_id_production_id_fk" FOREIGN KEY ("production_id") REFERENCES "public"."production"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement" ADD CONSTRAINT "engagement_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production" ADD CONSTRAINT "production_season_id_season_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."season"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_name_idx" ON "agent" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "conflict_engagement_id_idx" ON "conflict" USING btree ("engagement_id");--> statement-breakpoint
CREATE INDEX "engagement_production_id_idx" ON "engagement" USING btree ("production_id");--> statement-breakpoint
CREATE INDEX "engagement_agent_id_idx" ON "engagement" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "production_season_id_idx" ON "production" USING btree ("season_id");--> statement-breakpoint
CREATE INDEX "person_email_idx" ON "person" USING btree (lower("email"));