# PPT relay real-MySQL integration suite (XIN-1740)

`pptDbRelayStore.integration.test.ts` drives the **production**
`DbPptRelayStore` and its repos against a **real MySQL 8**, not the in-memory
fake that the default unit suite (`test/pptDbRelayStore.test.ts`) mocks at the
`db/pool` seam.

## Why this exists

Round-12 review §5 flagged that the entire MySQL store was validated only
against a hand-written model of MySQL. That fake is self-confirming: if the
model of a MySQL behavior is wrong, the production expectation built on the same
assumption is wrong the same way, and the suite still passes. This suite closes
that gap by exercising the real engine, with `migrations/schema.sql` plus every
`migrations/upgrades/*.sql` applied to the live database during setup.

The headline case is **P1-4**: whether
`START TRANSACTION WITH CONSISTENT SNAPSHOT`, issued via mysql2's
`conn.execute()` (the prepared-statement path the store's `inConsistentSnapshot`
uses), actually runs on MySQL 8. The fake no-ops that statement, so only a real
engine can answer it. It does not: real MySQL 8 rejects it with
`ER_UNSUPPORTED_PS` (1295). Exercising the real engine also surfaced a second
prepared-statement defect on the same replay path — `pptCollabOpRepo` binds an
integer to `LIMIT ?` on `conn.execute()`, which MySQL rejects with
`ER_WRONG_ARGUMENTS`. Both are pinned by the tests in the
`prepared-statement protocol defects on the replay path` block; the fixes belong
to the ordering-model ticket, not here.

## Additive and gated

- The default `npm test` **excludes** `test/integration/**` (see
  `vitest.config.ts`) and never sets `PPT_MYSQL_IT`, so it stays green on
  machines without MySQL.
- The suites additionally self-skip when `PPT_MYSQL_IT` is unset, so running
  this config without a database reports skipped tests rather than failing.

## Running locally

```bash
docker compose -f docker-compose.integration.yml up -d

PPT_IT_MYSQL_PORT=33306 \
PPT_IT_MYSQL_USER=root \
PPT_IT_MYSQL_PASSWORD=rootpw \
PPT_IT_MYSQL_DATABASE=ppt_relay_it \
  npm run test:integration

docker compose -f docker-compose.integration.yml down -v
```

`npm run test:integration` sets `PPT_MYSQL_IT=1` for you. Setup drops and
recreates `PPT_IT_MYSQL_DATABASE`, so point it at a throwaway database only.

## Connection settings

Resolved in `helpers/itEnv.ts`, in order: `PPT_IT_MYSQL_*`, then any pre-set
`MYSQL_*`, then defaults (`127.0.0.1:3306`, user `root`, password `root`,
database `ppt_relay_it`). The resolved values are published back onto the
standard `MYSQL_*` vars so the production pool connects to the same throwaway DB.

## CI

`.github/workflows/ci-ppt-relay-integration.yml` runs this suite (plus
typecheck, lint, and the default unit suite) with a MySQL 8 service container,
**including on draft PRs** — the default `ci.yml` gates skip while a PR is Draft,
so that workflow surfaces a real signal for the relay/store path before the PR
leaves Draft.
