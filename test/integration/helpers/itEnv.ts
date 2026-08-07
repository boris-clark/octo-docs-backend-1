/**
 * Integration-test env seeding for the real-MySQL PPT relay suite (XIN-1740).
 *
 * Imported FIRST by the integration test (before any module that reads
 * `src/config/env.ts`), mirroring `test/helpers/pptRelayEnv.ts`: `config/env.ts`
 * snapshots `process.env` at module-eval time, so the `MYSQL_*` the production
 * pool uses must be populated before `src/db/pool.ts` is imported.
 *
 * Connection settings resolve from `PPT_IT_MYSQL_*` first (so a CI job or a local
 * docker-compose can point the suite at its own throwaway MySQL without touching
 * a developer's real `MYSQL_*`), then any pre-set `MYSQL_*`, then defaults that
 * match `docker-compose.integration.yml` and the CI service container.
 *
 * The suite only runs when `PPT_MYSQL_IT` is truthy (set by
 * `npm run test:integration` and by CI). The default `npm test` never sets it, so
 * the suite is skipped on machines without MySQL — the additive-and-gated
 * contract the ticket requires.
 */

function pick(...values: Array<string | undefined>): string | undefined {
  for (const v of values) if (v !== undefined && v !== '') return v
  return undefined
}

export const itMysql = {
  host: pick(process.env.PPT_IT_MYSQL_HOST, process.env.MYSQL_HOST) ?? '127.0.0.1',
  port: Number(pick(process.env.PPT_IT_MYSQL_PORT, process.env.MYSQL_PORT) ?? '3306'),
  user: pick(process.env.PPT_IT_MYSQL_USER, process.env.MYSQL_USER) ?? 'root',
  password: pick(process.env.PPT_IT_MYSQL_PASSWORD, process.env.MYSQL_PASSWORD) ?? 'root',
  database: pick(process.env.PPT_IT_MYSQL_DATABASE, process.env.MYSQL_DATABASE) ?? 'ppt_relay_it',
  connectionLimit: Number(pick(process.env.MYSQL_CONNECTION_LIMIT) ?? '10'),
}

// Publish the resolved settings back onto the standard vars the production
// `config/env.ts` reads, so `getPool()` connects to the same throwaway DB the
// setup helper migrates.
process.env.MYSQL_HOST = itMysql.host
process.env.MYSQL_PORT = String(itMysql.port)
process.env.MYSQL_USER = itMysql.user
process.env.MYSQL_PASSWORD = itMysql.password
process.env.MYSQL_DATABASE = itMysql.database
process.env.MYSQL_CONNECTION_LIMIT = String(itMysql.connectionLimit)

/** True when the operator explicitly opted the live-MySQL suite in. */
export const itEnabled = ['1', 'true', 'yes'].includes(
  (process.env.PPT_MYSQL_IT ?? '').toLowerCase(),
)
