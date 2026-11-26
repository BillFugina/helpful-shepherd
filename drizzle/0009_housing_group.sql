-- Hand-edited: Housing splits in two. Where people stay (places, rooms, stay
-- dates) becomes the new housing group; housing_access keeps only how to get
-- in (address, door code, entry instructions, notes), so the Claude connector
-- can answer "who stays where" without ever seeing a door code. The type is
-- rebuilt rather than extended because the migrator runs in one transaction
-- (see 0008), and every role keeps the level it had on housing_access.
ALTER TYPE "public"."field_group" RENAME TO "field_group_old";--> statement-breakpoint
CREATE TYPE "public"."field_group" AS ENUM('general', 'contact', 'personal_id', 'travel_id', 'pay_terms', 'contracts', 'tax_bank', 'documents', 'travel_logistics', 'housing', 'housing_access', 'comps');--> statement-breakpoint
ALTER TABLE "role_grant" ALTER COLUMN "field_group" TYPE "public"."field_group" USING "field_group"::text::"public"."field_group";--> statement-breakpoint
ALTER TABLE "audit_event" ALTER COLUMN "field_group" TYPE "public"."field_group" USING "field_group"::text::"public"."field_group";--> statement-breakpoint
DROP TYPE "public"."field_group_old";--> statement-breakpoint
INSERT INTO "role_grant" ("role", "field_group", "level")
  SELECT "role", 'housing', "level" FROM "role_grant" WHERE "field_group" = 'housing_access'
  ON CONFLICT DO NOTHING;
