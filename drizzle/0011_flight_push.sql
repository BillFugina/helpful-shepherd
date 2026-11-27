CREATE TABLE "flight_push" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"number" text NOT NULL,
	"status" text NOT NULL,
	"from_airport" text,
	"to_airport" text,
	"scheduled_departure" timestamp with time zone,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "flight_subscription" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" text,
	"flight_number" text NOT NULL,
	"token_hash" text NOT NULL,
	"purpose" text NOT NULL,
	"started_by" text,
	"active" boolean DEFAULT true NOT NULL,
	"credits_remaining" integer,
	"last_push_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "flight" ADD COLUMN "push_subscription_id" uuid;--> statement-breakpoint
ALTER TABLE "flight_push" ADD CONSTRAINT "flight_push_subscription_id_flight_subscription_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."flight_subscription"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "flight_push_subscription_id_idx" ON "flight_push" USING btree ("subscription_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "flight_subscription_flight_live_uq" ON "flight_subscription" USING btree ("flight_number") WHERE "flight_subscription"."active" and "flight_subscription"."purpose" = 'flight';--> statement-breakpoint
CREATE UNIQUE INDEX "flight_subscription_token_hash_uq" ON "flight_subscription" USING btree ("token_hash");--> statement-breakpoint
ALTER TABLE "flight" ADD CONSTRAINT "flight_push_subscription_id_flight_subscription_id_fk" FOREIGN KEY ("push_subscription_id") REFERENCES "public"."flight_subscription"("id") ON DELETE set null ON UPDATE no action;