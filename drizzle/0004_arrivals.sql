CREATE TYPE "public"."flight_direction" AS ENUM('arrival', 'departure');--> statement-breakpoint
CREATE TYPE "public"."flight_event_kind" AS ENUM('delayed', 'gate_change', 'departed', 'landed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."housing_kind" AS ENUM('company_house', 'apartment', 'guesthouse', 'airbnb', 'hotel', 'other');--> statement-breakpoint
CREATE TYPE "public"."housing_rule" AS ENUM('private_bathroom', 'ground_floor');--> statement-breakpoint
CREATE TYPE "public"."flight_live_status" AS ENUM('scheduled', 'delayed', 'departed', 'landed', 'cancelled');--> statement-breakpoint
CREATE TABLE "demo_clock" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"offset_ms" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demo_clock_single_row" CHECK ("demo_clock"."id")
);
--> statement-breakpoint
CREATE TABLE "flight" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"engagement_id" uuid NOT NULL,
	"direction" "flight_direction" NOT NULL,
	"airline" text NOT NULL,
	"flight_number" text NOT NULL,
	"from_airport" text NOT NULL,
	"to_airport" text NOT NULL,
	"scheduled_departure" timestamp with time zone NOT NULL,
	"scheduled_arrival" timestamp with time zone NOT NULL,
	"confirmation" text,
	"booking_source" text,
	"notes" text,
	"live_status" "flight_live_status",
	"live_departure" timestamp with time zone,
	"live_arrival" timestamp with time zone,
	"live_gate" text,
	"live_terminal" text,
	"live_baggage" text,
	"live_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flight_departs_before_arriving" CHECK ("flight"."scheduled_departure" < "flight"."scheduled_arrival")
);
--> statement-breakpoint
CREATE TABLE "flight_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flight_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"kind" "flight_event_kind" NOT NULL,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "housing_assignment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"engagement_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "housing_assignment_dates_in_order" CHECK ("housing_assignment"."starts_on" < "housing_assignment"."ends_on")
);
--> statement-breakpoint
CREATE TABLE "housing_preference" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"rule" "housing_rule" NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "housing_preference_person_rule_uq" UNIQUE("person_id","rule")
);
--> statement-breakpoint
CREATE TABLE "housing_room" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"unit_id" uuid NOT NULL,
	"name" text NOT NULL,
	"floor" integer DEFAULT 1 NOT NULL,
	"bathroom" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "housing_room_unit_name_uq" UNIQUE("unit_id","name")
);
--> statement-breakpoint
CREATE TABLE "housing_unit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" "housing_kind" NOT NULL,
	"address" text,
	"access_notes" text,
	"door_code" text,
	"notes" text,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rental_car" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"engagement_id" uuid NOT NULL,
	"company" text NOT NULL,
	"confirmation" text,
	"pickup_at" timestamp with time zone NOT NULL,
	"pickup_place" text,
	"return_at" timestamp with time zone NOT NULL,
	"return_place" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rental_car_pickup_before_return" CHECK ("rental_car"."pickup_at" < "rental_car"."return_at")
);
--> statement-breakpoint
ALTER TABLE "flight" ADD CONSTRAINT "flight_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagement"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flight_event" ADD CONSTRAINT "flight_event_flight_id_flight_id_fk" FOREIGN KEY ("flight_id") REFERENCES "public"."flight"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "housing_assignment" ADD CONSTRAINT "housing_assignment_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagement"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "housing_assignment" ADD CONSTRAINT "housing_assignment_room_id_housing_room_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."housing_room"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "housing_preference" ADD CONSTRAINT "housing_preference_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "housing_room" ADD CONSTRAINT "housing_room_unit_id_housing_unit_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."housing_unit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rental_car" ADD CONSTRAINT "rental_car_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagement"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "flight_engagement_id_idx" ON "flight" USING btree ("engagement_id");--> statement-breakpoint
CREATE INDEX "flight_scheduled_arrival_idx" ON "flight" USING btree ("scheduled_arrival");--> statement-breakpoint
CREATE INDEX "flight_scheduled_departure_idx" ON "flight" USING btree ("scheduled_departure");--> statement-breakpoint
CREATE INDEX "flight_event_flight_id_idx" ON "flight_event" USING btree ("flight_id","at");--> statement-breakpoint
CREATE INDEX "housing_assignment_room_id_idx" ON "housing_assignment" USING btree ("room_id","starts_on");--> statement-breakpoint
CREATE INDEX "housing_assignment_engagement_id_idx" ON "housing_assignment" USING btree ("engagement_id");--> statement-breakpoint
CREATE INDEX "housing_room_unit_id_idx" ON "housing_room" USING btree ("unit_id");--> statement-breakpoint
CREATE INDEX "rental_car_engagement_id_idx" ON "rental_car" USING btree ("engagement_id");