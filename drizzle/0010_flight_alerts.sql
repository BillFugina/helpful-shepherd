-- Hand-edited: the scheduled flight job emails each change once. Changes
-- logged before this migration count as already sent, so the first run
-- doesn't mail out old news.
ALTER TABLE "flight_event" ADD COLUMN "alerted_at" timestamp with time zone;--> statement-breakpoint
UPDATE "flight_event" SET "alerted_at" = now();
