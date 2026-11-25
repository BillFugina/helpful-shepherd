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
