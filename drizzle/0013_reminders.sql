CREATE TABLE "reminder_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"paperwork_days_before" integer DEFAULT 14 NOT NULL,
	"contract_days_after" integer DEFAULT 7 NOT NULL,
	"digest_on" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reminder_settings_single_row" CHECK ("reminder_settings"."id" = 1),
	CONSTRAINT "reminder_settings_paperwork_days" CHECK ("reminder_settings"."paperwork_days_before" between 0 and 90),
	CONSTRAINT "reminder_settings_contract_days" CHECK ("reminder_settings"."contract_days_after" between 0 and 60)
);
