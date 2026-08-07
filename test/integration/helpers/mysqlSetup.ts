/**
 * Real-MySQL schema setup for the PPT relay integration suite (XIN-1740).
 *
 * The default unit suite (`test/pptDbRelayStore.test.ts`) drives the store against
 * a hand-written in-memory fake mocked at the `db/pool` seam. That fake is
 * self-confirming: it models MySQL's semantics, so a wrong model and a wrong
 * production expectation fail the same way and the suite still passes (round-12
 * review §5). This helper stands up the store's durability paths against a REAL
 * MySQL 8, applying the SAME migrations a production deploy applies:
 *
 *  1. `migrations/schema.sql` — the fresh-install contract, applied via the
 *     production statement splitter (`splitSqlStatements`), so the exact DDL a new
 *     database gets is validated end-to-end (not just as SQL text).
 *  2. `migrations/upgrades/*.sql` — every incremental migration, run through the
 *     production migration runner (`runMigrations`), so the payload-hash and
 *     `utf8mb4_bin` collation migrations execute against a real engine and the
 *     runner's idempotency contract holds over the fresh schema.
 *
 * Reuses the production `src/db/migrate.ts` functions verbatim — no re-implemented
 * migration logic to drift from what deploys run.
 */
import mysql from 'mysql2/promise'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  connectionMigrationDb,
  loadMigrationFiles,
  runMigrations,
  splitSqlStatements,
} from '../../../src/db/migrate.js'
import { itMysql } from './itEnv.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const RELAY_TABLES = ['ppt_collab_op', 'ppt_collab_frame', 'ppt_collab_seq', 'ppt_live_snapshot'] as const

/** A privileged connection with NO database selected, for DROP/CREATE DATABASE. */
async function adminConnection(): Promise<mysql.Connection> {
  return mysql.createConnection({
    host: itMysql.host,
    port: itMysql.port,
    user: itMysql.user,
    password: itMysql.password,
    multipleStatements: false,
  })
}

/** A connection bound to the throwaway test database. */
async function dbConnection(): Promise<mysql.Connection> {
  return mysql.createConnection({
    host: itMysql.host,
    port: itMysql.port,
    user: itMysql.user,
    password: itMysql.password,
    database: itMysql.database,
  })
}

/**
 * Drop and recreate the throwaway database, apply `schema.sql`, then run every
 * upgrade migration on top. Call once in `beforeAll`. The double application
 * (fresh schema + idempotent upgrades) is deliberate: it exercises BOTH the
 * fresh-install contract and the upgrade path against the same real engine.
 */
export async function resetDatabase(): Promise<void> {
  const admin = await adminConnection()
  try {
    await admin.query(`DROP DATABASE IF EXISTS \`${itMysql.database}\``)
    await admin.query(`CREATE DATABASE \`${itMysql.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`)
  } finally {
    await admin.end()
  }

  const conn = await dbConnection()
  try {
    const schemaSql = await fs.readFile(path.join(repoRoot, 'migrations/schema.sql'), 'utf8')
    for (const statement of splitSqlStatements(schemaSql)) {
      await conn.query(statement)
    }
    const files = await loadMigrationFiles(path.join(repoRoot, 'migrations/upgrades'))
    const db = connectionMigrationDb({ query: (sql, params) => conn.query(sql, params) })
    await runMigrations(db, files)
  } finally {
    await conn.end()
  }
}

/** Truncate the four relay tables so each test starts from an empty room set. */
export async function truncateRelayTables(): Promise<void> {
  const conn = await dbConnection()
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0')
    for (const table of RELAY_TABLES) await conn.query(`TRUNCATE TABLE \`${table}\``)
    await conn.query('SET FOREIGN_KEY_CHECKS = 1')
  } finally {
    await conn.end()
  }
}

export { dbConnection }
