CREATE TYPE "public"."contract_status" AS ENUM('draft', 'sent', 'signed', 'void');--> statement-breakpoint
CREATE TYPE "public"."contract_template_format" AS ENUM('equity_itc_form', 'sdc_form', 'text');--> statement-breakpoint
CREATE TABLE "contract" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"engagement_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"template_family_id" uuid NOT NULL,
	"status" "contract_status" DEFAULT 'draft' NOT NULL,
	"overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sent_values" jsonb,
	"sent_on" date,
	"sent_at" timestamp with time zone,
	"sent_to" text,
	"signed_on" date,
	"voided_at" timestamp with time zone,
	"created_by" text,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contract_sent_has_date" CHECK ("contract"."status" in ('draft', 'void') or "contract"."sent_on" is not null),
	CONSTRAINT "contract_signed_has_date" CHECK ("contract"."status" <> 'signed' or "contract"."signed_on" is not null)
);
--> statement-breakpoint
CREATE TABLE "contract_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"name" text NOT NULL,
	"format" "contract_template_format" NOT NULL,
	"contract_type" "contract_type" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"pdf" "bytea",
	"file_name" text,
	"body" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contract_template_family_version_uq" UNIQUE("family_id","version"),
	CONSTRAINT "contract_template_content_matches_format" CHECK (("contract_template"."format" = 'text' and "contract_template"."body" is not null and "contract_template"."pdf" is null) or ("contract_template"."format" <> 'text' and "contract_template"."pdf" is not null and "contract_template"."body" is null))
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"name" text,
	"street" text,
	"city_state_zip" text,
	"phone" text,
	"email" text,
	"signer_name" text,
	"ein" text,
	"unemployment_number" text,
	"equity_employer_agreement" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_single_row" CHECK ("organization"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "engagement" DROP CONSTRAINT "engagement_money_not_negative";--> statement-breakpoint
ALTER TABLE "engagement" ADD COLUMN "fee_cents" integer;--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "union_member_id" text;--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "home_street_enc" text;--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "home_city_state_zip_enc" text;--> statement-breakpoint
ALTER TABLE "production" ADD COLUMN "venue_name" text;--> statement-breakpoint
ALTER TABLE "production" ADD COLUMN "venue_capacity" integer;--> statement-breakpoint
ALTER TABLE "production" ADD COLUMN "top_ticket_cents" integer;--> statement-breakpoint
ALTER TABLE "production" ADD COLUMN "scheduled_performances" integer;--> statement-breakpoint
ALTER TABLE "production" ADD COLUMN "rehearsal_location" text;--> statement-breakpoint
ALTER TABLE "production" ADD COLUMN "rehearsal_call_time" text;--> statement-breakpoint
ALTER TABLE "contract" ADD CONSTRAINT "contract_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagement"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract" ADD CONSTRAINT "contract_template_id_contract_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."contract_template"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract" ADD CONSTRAINT "contract_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_template" ADD CONSTRAINT "contract_template_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contract_engagement_id_idx" ON "contract" USING btree ("engagement_id");--> statement-breakpoint
CREATE INDEX "contract_template_id_idx" ON "contract" USING btree ("template_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contract_engagement_family_live_uq" ON "contract" USING btree ("engagement_id","template_family_id") WHERE "contract"."status" <> 'void';--> statement-breakpoint
ALTER TABLE "engagement" ADD CONSTRAINT "engagement_money_not_negative" CHECK (coalesce("engagement"."weekly_pay_cents", 0) >= 0 and coalesce("engagement"."weekly_stipend_cents", 0) >= 0 and coalesce("engagement"."fee_cents", 0) >= 0);--> statement-breakpoint
ALTER TABLE "production" ADD CONSTRAINT "production_venue_numbers_positive" CHECK (coalesce("production"."venue_capacity", 1) > 0 and coalesce("production"."top_ticket_cents", 0) >= 0 and coalesce("production"."scheduled_performances", 1) > 0);