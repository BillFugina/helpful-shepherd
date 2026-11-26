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
- Demo data: flights and cars for everyone the theater flies in, three made-up
  places with seven rooms, stays for each production, and two housing needs
  that trip warnings in the second production. The first travel day is Jan 10,
  2027, with a delay, a gate change and an early landing.

**Not yet:** the plan runs the flight tracker on a schedule (Inngest) with
phone push alerts and an "arriving tomorrow" summary. Here the tracker runs
when someone looks at the board, throttled to once a minute per flight. The
scheduled job needs an Inngest account and push keys.

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
  contract PDF downloads, and no admin screens.
- **Own demo clock.** Each guest moves time on the Arrivals board without
  changing it for anyone else; their board replays the simulated feed in memory.
- **Free-tier guardrails:** 5 starts a minute per visitor, at most 1000 live
  guest sessions, expired ones cleaned up, and guest sign-ins kept out of the
  audit log. Set `DEMO_GUEST=off` to turn it off.

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
