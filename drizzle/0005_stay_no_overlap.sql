-- Two stays can't share a night in the same room, and one engagement can't
-- have two stays on the same night. The app checks first for a friendly
-- message; these constraints are what make it true when two people save at
-- once. A stay covers [starts_on, ends_on): the move-out day is free.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE "housing_assignment" ADD CONSTRAINT "housing_assignment_room_no_overlap"
  EXCLUDE USING gist ("room_id" WITH =, daterange("starts_on", "ends_on") WITH &&);
--> statement-breakpoint
ALTER TABLE "housing_assignment" ADD CONSTRAINT "housing_assignment_engagement_no_overlap"
  EXCLUDE USING gist ("engagement_id" WITH =, daterange("starts_on", "ends_on") WITH &&);
