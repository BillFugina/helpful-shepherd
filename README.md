# Theatre Raleigh company management (demo)

A company management app for Theatre Raleigh: one record per contracted person
per production, replacing the personnel spreadsheet and Basecamp document
tracking. **This is a demo with made-up data only.** Real personal information
waits until the app moves to theater-owned accounts with fresh secrets (see the
build plan).

## Stack

Vite + React SPA, tRPC, TanStack Query and Form, Drizzle on Postgres (Neon in
the cloud), Better Auth with required two-factor, deployed as Vercel functions.

## What's here (foundation)

- **Sign-in with required two-factor.** Email and password, then an
  authenticator app (TOTP) with backup codes. No self sign-up: the seed script
  creates staff logins. The API returns no data until two-factor is on.
  Sign-in and two-factor attempts are rate limited.
- **Two roles:** Company Manager (admin) and Finance Manager.
- **Field-group permissions, default deny.** Every field belongs to a group
  (`shared/access.ts`); a role sees a group only through an explicit grant.
  The filter runs on the server for every record returned, so a hidden column
  never reaches the browser. DOB, travel IDs and tax and bank docs are masked
  and open only through **Reveal**, which is logged. The Company Manager edits
  grants on the Access screen; Travel ID and Tax and bank docs need a second
  confirmation, and the Company Manager's own grants are fixed.
- **Audit log.** Append-only (a database trigger refuses updates and deletes):
  sign-ins, reveals and grant changes so far, filterable by person. It records
  field names, never values.
- **Field encryption.** DOB, TSA/KTN and frequent-flyer numbers are encrypted
  with AES-256-GCM before they reach the database, with a key held only in an
  environment variable.
- **Fake seed data** and an installable web app shell (manifest and icon).

## What's here (roster)

- **Seasons and productions**, with rehearsal, tech, opening and closing dates
  (the database refuses dates out of order).
- **People and engagements.** A person is one record reused every season; an
  engagement is their deal on one production: role, contract type (Equity
  ITC, SDC, non-union), pay, agent and commission, weekly stipend, travel, car
  and housing, preferred arrival and departure, comps, notes and conflicts.
  A person can be on a production once.
- **Season dashboard.** Every production and its people, with each person's
  pipeline stage (Offer accepted through Departed), changeable in place.
- **Fast-entry form**, laid out in the order of the acceptance email. Search
  for a returning person and their profile and last agent fill in. One save
  writes the person, agent, deal and conflicts together, or none of it.
- **Agents**, with their agency and contact details.
- **Spreadsheet import.** Load a CSV export of the personnel sheet, say which
  column is which, preview, then import. Returning people match by email, or by
  name when there's no email. Nothing is saved while any row has a problem.
  `samples/personnel-demo.csv` is a made-up sheet to try it with.
- Every change goes through the field-group permissions (writing a field needs
  edit on its group) and lands in the audit log, one event per group touched,
  with field names and never values.

## What's here (arrivals)

- **Travel per engagement** (Travel and housing, from an engagement): flights
  typed in each airport's local time and stored as instants, and rental cars
  in Raleigh time. A flight that's rebooked loses its old live status.
- **Arrivals board** (`/arrivals`): who lands and leaves on one day, with live
  status, gate, baggage claim, car pickup, where they sleep tonight, Call and
  Text buttons, and Mark arrived. People expected that day with no flight
  logged are listed too. It refreshes every minute and works on a phone.
- **Simulated flight feed.** No paid API: `server/flights/provider.ts` sits
  behind the same adapter a real feed (AeroDataBox, per the plan) would use.
  What happens to a flight depends on the last digit of its number: 9
  cancelled, 7 late by 45 minutes, 4 late by 95, 3 gate change, 1 lands 12
  minutes early, anything else on time. Changes are logged as alerts.
- **Demo clock.** The demo season is in 2027, so the Company Manager can start
  a travel day at 6 AM and step it forward an hour at a time. Moving the clock
  clears what the feed said; the board fills in again for the new moment.
- **Housing** (`/housing`): places and rooms (floor, and a bathroom name; rooms
  with the same bathroom name share it), a four-week calendar of who sleeps
  where, and assignment from each person's travel page. A room can't be
  double-booked. Housing needs (own bathroom, ground floor) and travel that
  starts before or ends after a stay show as warnings, never blocks.
- Finance has no travel or housing access by default, matching the plan.
- Demo data: flights and cars for everyone the theater flies in, made-up places and
  rooms, stays for each production, and two housing needs
  that trip warnings in the second production. The first travel day is Jan 10,
  2027, with a delay, a gate change and an early landing.

**Not yet:** the plan runs the flight tracker on a schedule (Inngest) with
phone push alerts and an "arriving tomorrow" summary. Here the tracker runs
when someone looks at the board, throttled to once a minute per flight. The
scheduled job needs an Inngest account and push keys.

## What's here (housing)

- **Who still needs a room**: each person's nights come from their flights
  (when the role can see travel), else the dates they asked for, else the
  production's rehearsal start to the day after closing. Anyone whose deal
  includes housing shows as housed, missing nights (named), no room yet, or
  no dates to go on. The Housing page lists everyone on an open production who
  still needs something.
- **Housing plan** (`/housing/plan`): one production at a time, where each
  person stays with first night and move-out day, what's missing, and the
  warnings on their stays. Links straight to assigning a room.
- **Moving in and out**: the Housing page lists move-ins and move-outs in the
  four weeks shown, and marks a room that turns over the same day.
- **Editing**: places and rooms can be edited in place, and a stay can move to
  another room or other dates from the person's travel page.
- **Two field groups**: _Housing_ covers place and room names and who stays
  when; _Housing access_ covers the address, door code, how to get in and
  notes. A place's name is a label, not its address. Migration 0009 gives
  every role the same Housing level it already had for Housing access.
- **Claude connector**: a `housing_plan` tool and a housing block on the
  person card give place and room names and dates only. Housing access is
  never sent over the connector, and the guest demo never sees door codes or
  how to get in.
- Demo data adds a downtown hotel with two suites, leaves two people on the
  last production without a room, and starts one stay on the fourth
  production two nights late.

## What's here (documents)

- **A checklist per engagement** (Documents, on the engagement page): W-4,
  NC-4, I-9, W-9, Equity deferral, direct deposit and bank verification, as
  Missing, Received, Sent to Finance, Accepted by Finance or Not needed. Which
  forms each contract type needs is set on `/documents/settings`.
- **Upload links.** The Company Manager makes a private link for the forms
  still open and sends it themselves. The person opens `/upload/<token>` with
  no account and uploads a PDF or a photo (up to 3 MB; the server checks the
  bytes, not the name). Only a hash of the token is stored; the link expires
  (14 days by default), takes at most 20 uploads and can be turned off. The
  Company Manager can also upload a form by hand.
- **Encrypted files.** Each file and its name are encrypted with AES-256-GCM
  before they reach Postgres, bound to their document. Opening one needs Tax
  and bank docs and is logged; the guest demo and the Claude connector never
  get files.
- **Handoff to Finance.** Send to Finance puts a form in Finance's queue
  (`/documents`). Finance accepts it, and the app deletes its copy at once and
  keeps only the status and dates, or sends it back with a note the person
  sees on their link. A signed deal moves to Paperwork complete when every
  form is accepted or not needed.
- **Retention backstop.** Any file still held a set number of years after its
  production closes is deleted. It starts at 3 years and is marked as waiting
  for Finance to confirm. It runs when staff open a production's documents, at
  most once an hour, so it needs no scheduler.
- **Claude connector:** `missing_documents` reads one production's statuses.
- Demo data holds statuses only, never a file; opening a demo form gives a
  SAMPLE page. Any real upload closes the guest demo until the file is gone.

**Not yet:** emailing links, reminders and a daily digest need an email
service or Inngest. Files live in Postgres rather than Vercel Blob so no new
account is needed; swapping in Blob later is a contained change.

## Guest demo

Anyone can look around the whole app without an account: **Try the demo** on
the sign-in page, or the `/demo` link, signs them in as a shared read-only
guest.

- **No password, no second factor**, a two-hour session that isn't extended.
  Staff logins are unchanged and still need two-factor.
- **Read-only on the server.** Every change is refused (`DEMO_READ_ONLY`), the
  connector refuses the guest, and the guest can't list sessions, edit the
  account or turn on two-factor.
- **Fixed, view-only access** (`GUEST_GRANTS` in `shared/access.ts`): never
  dates of birth, travel IDs, tax or bank details, door codes, access notes or
  contract PDF downloads or uploaded forms (it sees the checklist's statuses),
  and no admin screens.
- **Own demo clock.** Each guest moves time on the Arrivals board without
  changing it for anyone else; their board replays the simulated feed in memory.
- **Free-tier guardrails:** 5 starts a minute per visitor, at most 1000 live
  guest sessions, expired ones cleaned up, and guest sign-ins kept out of the
  audit log. Set `DEMO_GUEST=off` to turn it off.

## Reminder emails

The Company Manager can email a reminder to one person or everyone on a
production with missing forms. Each reminder names the forms still needed
(missing, or sent back by Finance) and carries a fresh upload link.

Nothing is sent unless `RESEND_API_KEY` and `EMAIL_FROM` are set and
`EMAIL_DELIVERY` is `allowlist` or `live`. Until then the app shows the email
for her to copy. Demo people and reserved domains like example.com never get
mail, the guest and the connector can't send, and the audit log records what
was asked for without the address or the link.

## Setting a password

A staff login with no password yet, or a forgotten one, gets a link by email: "Set your password" on the sign-in page. The link goes only to the login's own address, works once, for an hour, and only its hash is stored (in the auth verification table). A login gets at most one such email every ten minutes, and the form says the same thing whether or not the address has a login. Setting the password signs that login out everywhere, disconnects its connected apps (Claude), and leaves two-factor alone: an account with it still needs its code, and one without is sent to set it up first. Nobody can create a login this way, and the guest demo and the Claude connector can't use it.

It goes out through the same email settings as reminders, so in allowlist mode the address must be on `EMAIL_ALLOWLIST`.

## Local setup

```sh
npm install
cp .env.example .env   # fill in DATABASE_URL, BETTER_AUTH_SECRET, FIELD_ENCRYPTION_KEY
npm run db:migrate
npm run db:seed        # demo logins and a made-up 2027 season; prints the password if SEED_DEMO_PASSWORD isn't set
npm run dev            # http://localhost:5173
```

Demo logins: `company.manager@example.com` and `finance@example.com` (change
with `SEED_CM_EMAIL` and `SEED_FINANCE_EMAIL`). Each sets up two-factor on
first sign-in.

## Checks

```sh
npm run lint && npm run format:check && npm run typecheck
npm test               # database tests run when DATABASE_URL points at a migrated, disposable database
npm run build
```

CI runs all of these against a throwaway Postgres, plus a check that the schema
matches the committed migrations.
