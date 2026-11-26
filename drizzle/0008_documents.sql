CREATE TYPE "public"."document_status" AS ENUM('missing', 'received', 'sent_to_finance', 'accepted', 'not_needed');--> statement-breakpoint
CREATE TYPE "public"."document_type" AS ENUM('w4', 'nc4', 'i9', 'w9', 'equity_deferral', 'direct_deposit', 'bank_verification');--> statement-breakpoint
-- Hand-edited: the migrator runs every pending migration in one transaction,
-- and a value added with ALTER TYPE ... ADD VALUE can't be used until that
-- transaction commits. So the field_group type is rebuilt with the new value
-- instead, and the grants below can use it straight away.
ALTER TYPE "public"."field_group" RENAME TO "field_group_old";--> statement-breakpoint
CREATE TYPE "public"."field_group" AS ENUM('general', 'contact', 'personal_id', 'travel_id', 'pay_terms', 'contracts', 'tax_bank', 'documents', 'travel_logistics', 'housing_access', 'comps');--> statement-breakpoint
ALTER TABLE "role_grant" ALTER COLUMN "field_group" TYPE "public"."field_group" USING "field_group"::text::"public"."field_group";--> statement-breakpoint
ALTER TABLE "audit_event" ALTER COLUMN "field_group" TYPE "public"."field_group" USING "field_group"::text::"public"."field_group";--> statement-breakpoint
DROP TYPE "public"."field_group_old";--> statement-breakpoint
CREATE TABLE "document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"engagement_id" uuid NOT NULL,
	"document_type" "document_type" NOT NULL,
	"status" "document_status" DEFAULT 'missing' NOT NULL,
	"received_on" date,
	"received_via" text,
	"sent_to_finance_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"file_purged_at" timestamp with time zone,
	"finance_note" text,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_engagement_type_uq" UNIQUE("engagement_id","document_type"),
	CONSTRAINT "document_received_has_date" CHECK ("document"."status" in ('missing', 'not_needed') or "document"."received_on" is not null),
	CONSTRAINT "document_sent_has_time" CHECK ("document"."status" <> 'sent_to_finance' or "document"."sent_to_finance_at" is not null),
	CONSTRAINT "document_accepted_has_time" CHECK ("document"."status" <> 'accepted' or "document"."accepted_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "document_file" (
	"document_id" uuid PRIMARY KEY NOT NULL,
	"data" "bytea" NOT NULL,
	"file_name_enc" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" integer NOT NULL,
	"uploaded_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_requirement" (
	"contract_type" "contract_type" NOT NULL,
	"document_type" "document_type" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_requirement_contract_type_document_type_pk" PRIMARY KEY("contract_type","document_type")
);
--> statement-breakpoint
CREATE TABLE "document_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"link_days" integer DEFAULT 14 NOT NULL,
	"retention_years" integer DEFAULT 3 NOT NULL,
	"retention_confirmed" boolean DEFAULT false NOT NULL,
	"last_purge_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_settings_single_row" CHECK ("document_settings"."id" = 1),
	CONSTRAINT "document_settings_link_days" CHECK ("document_settings"."link_days" between 1 and 60),
	CONSTRAINT "document_settings_retention" CHECK ("document_settings"."retention_years" between 1 and 10)
);
--> statement-breakpoint
CREATE TABLE "upload_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"engagement_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"document_types" "document_type"[] NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"uploads" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagement"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_file" ADD CONSTRAINT "document_file_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_link" ADD CONSTRAINT "upload_link_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagement"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_link" ADD CONSTRAINT "upload_link_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_status_idx" ON "document" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "upload_link_token_hash_uq" ON "upload_link" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "upload_link_engagement_id_idx" ON "upload_link" USING btree ("engagement_id");--> statement-breakpoint
-- Hand-edited: starting rows. A database whose roles already have grants gets
-- the new documents group added (Company Manager edits, Finance reviews); a
-- fresh one gets every default from the seed instead.
INSERT INTO "role_grant" ("role", "field_group", "level")
  SELECT 'company_manager', 'documents', 'edit'
  WHERE EXISTS (SELECT 1 FROM "role_grant" WHERE "role" = 'company_manager')
  ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "role_grant" ("role", "field_group", "level")
  SELECT 'finance_manager', 'documents', 'review'
  WHERE EXISTS (SELECT 1 FROM "role_grant" WHERE "role" = 'finance_manager')
  ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "document_settings" ("id") VALUES (1) ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "document_requirement" ("contract_type", "document_type") VALUES
  ('equity_itc', 'w4'), ('equity_itc', 'nc4'), ('equity_itc', 'i9'), ('equity_itc', 'equity_deferral'),
  ('equity_itc', 'direct_deposit'), ('equity_itc', 'bank_verification'),
  ('sdc', 'w9'), ('sdc', 'direct_deposit'), ('sdc', 'bank_verification'),
  ('non_union', 'w4'), ('non_union', 'nc4'), ('non_union', 'i9'), ('non_union', 'direct_deposit'),
  ('non_union', 'bank_verification')
  ON CONFLICT DO NOTHING;
