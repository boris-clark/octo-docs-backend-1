/**
 * Real-MySQL integration suite for `DbPptRelayStore` durability paths (XIN-1740).
 *
 * Round-12 review §5 flagged that the whole MySQL store was only ever tested
 * against a hand-written in-memory fake mocked at the `db/pool` seam
 * (`test/pptDbRelayStore.test.ts`): the fake models MySQL, so a wrong model and a
 * wrong production expectation fail identically and the suite still passes. This
 * suite drives the SAME production `DbPptRelayStore` + its repos against a REAL
 * MySQL 8, with `migrations/schema.sql` + every `migrations/upgrades/*.sql`
 * applied to the live database in `beforeAll`.
 *
 * It is ADDITIVE and GATED: it runs only when `PPT_MYSQL_IT` is set (via
 * `npm run test:integration` or CI). The default `npm test` neither includes this
 * directory (see `vitest.config.ts` exclude) nor sets the flag, so it stays green
 * on machines without MySQL.
 *
 * P1-4 is a first-class deliverable here — see the dedicated describe block: it
 * proves against real MySQL 8 whether `START TRANSACTION WITH CONSISTENT SNAPSHOT`
 * runs on the `conn.execute()` prepared-statement path the store uses
 * (`dbStore.ts` `inConsistentSnapshot`). No production logic is changed here; the
 * test that catches the bug lands here, the fix belongs to the ordering-model
 * ticket.
 */
import './helpers/itEnv.js'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { itEnabled } from './helpers/itEnv.js'
import { resetDatabase, truncateRelayTables } from './helpers/mysqlSetup.js'
import { DbPptRelayStore } from '../../src/ppt/relay/dbStore.js'
import { closePool, getPool } from '../../src/db/pool.js'
import type { BentoDoc } from '../../src/ppt/bentoDoc.js'

function deck(title = 'S'): BentoDoc {
  return {
    format: 'bento/slides',
    version: 1,
    docId: 'bento_x',
    title,
    size: { width: 1280, height: 720 },
    theme: { background: '#fff', color: '#111', accent: '#3366ff', fontFamily: 'Inter' },
    slides: [{ id: 's1', background: '#fff', transition: 'none', elements: [], notes: '' }],
    modified: '2026-01-01T00:00:00.000Z',
  }
}

const opsFrame = (value: unknown, extra: Record<string, unknown> = {}): unknown => ({
  t: 'ops',
  pv: 2,
  k: 1,
  frameId: 'x',
  epoch: 0,
  ops: [{ kind: 'set', key: 's1e1', prop: 'x', value }],
  ...extra,
})

const D = 'doc_it'

// The whole suite is skipped unless the operator opted into a live MySQL.
const suite = itEnabled ? describe : describe.skip

suite('DbPptRelayStore — real MySQL 8 integration (XIN-1740)', () => {
  beforeAll(async () => {
    await resetDatabase()
  }, 120_000)

  beforeEach(async () => {
    await truncateRelayTables()
  })

  afterAll(async () => {
    await closePool()
  })

  describe('append monotonicity, dedup & first-writer race (P0-2 / B1)', () => {
    it('two concurrent first writers persist at DISTINCT seqs, neither refused', async () => {
      const store = new DbPptRelayStore()
      const [a, b] = await Promise.all([
        store.appendOp(D, 'f1', opsFrame(1, { frameId: 'f1' })),
        store.appendOp(D, 'f2', opsFrame(2, { frameId: 'f2' })),
      ])
      expect(a.duplicate).toBe(false)
      expect(b.duplicate).toBe(false)
      expect(new Set([a.seq, b.seq])).toEqual(new Set([1, 2]))
      expect(await store.currentSeq(D)).toBe(2)
    })

    it('a resent frameId re-acks its original seq without a second row', async () => {
      const store = new DbPptRelayStore()
      const first = await store.appendOp(D, 'dup', opsFrame(1, { frameId: 'dup' }))
      const again = await store.appendOp(D, 'dup', opsFrame(1, { frameId: 'dup' }))
      expect(again.duplicate).toBe(true)
      expect(again.seq).toBe(first.seq)
      expect((await store.opsSince(D, 0)).length).toBe(1)
    })

    it('a resent frameId with DIFFERENT ops is refused, not re-acked', async () => {
      const store = new DbPptRelayStore()
      await store.appendOp(D, 'dupp', opsFrame(1, { frameId: 'dupp' }))
      await expect(store.appendOp(D, 'dupp', opsFrame(2, { frameId: 'dupp' }))).rejects.toMatchObject({
        duplicatePayloadMismatch: true,
      })
      expect(await store.currentSeq(D)).toBe(1)
      expect((await store.opsSince(D, 0)).length).toBe(1)
    })

    it('P1-A: a resend of the SAME edit after an epoch/key-order change re-acks (canonical-ops hash)', async () => {
      const store = new DbPptRelayStore()
      const first = await store.appendOp(D, 'e1', opsFrame(1, { frameId: 'e1', epoch: 0, k: 1 }))
      const resend = { pv: 2, t: 'ops', frameId: 'e1', k: 9, epoch: 5, ops: [{ value: 1, prop: 'x', key: 's1e1', kind: 'set' }] }
      const again = await store.appendOp(D, 'e1', resend)
      expect(again).toMatchObject({ seq: first.seq, duplicate: true })
    })

    it('concurrent resend of the SAME frameId: one persists, the other re-acks (no storage-failed)', async () => {
      const store = new DbPptRelayStore()
      const [a, b] = await Promise.all([
        store.appendOp(D, 'same', opsFrame(1, { frameId: 'same' })),
        store.appendOp(D, 'same', opsFrame(1, { frameId: 'same' })),
      ])
      expect(a.seq).toBe(b.seq)
      expect(a.duplicate !== b.duplicate).toBe(true)
      expect((await store.opsSince(D, 0)).length).toBe(1)
    })

    it('seq does NOT regress after a full-coverage snapshot prunes every op (P0-2)', async () => {
      const store = new DbPptRelayStore()
      for (const [i, f] of ['f1', 'f2', 'f3'].entries()) await store.appendOp(D, f, opsFrame(i, { frameId: f }))
      await store.saveSnapshot({ docId: D, coveredSeq: 3, doc: deck() })
      await store.pruneOpsThrough(D, 3)
      expect((await store.opsSince(D, 0)).length).toBe(0)
      const next = await store.appendOp(D, 'f4', opsFrame(4, { frameId: 'f4' }))
      expect(next.seq).toBe(4)
      expect(await store.currentSeq(D)).toBe(4)
    })

    it('opsSince returns only the tail after the cursor, ascending', async () => {
      const store = new DbPptRelayStore()
      for (const f of ['f1', 'f2', 'f3']) await store.appendOp(D, f, opsFrame(f, { frameId: f }))
      expect((await store.opsSince(D, 1)).map((o) => o.seq)).toEqual([2, 3])
    })

    it('C1: dedup survives prune via the ledger — a resend of a pruned frameId re-acks its ORIGINAL seq', async () => {
      const store = new DbPptRelayStore()
      const first = await store.appendOp(D, 'frame-1', opsFrame(1, { frameId: 'frame-1' }))
      await store.appendOp(D, 'frame-2', opsFrame(2, { frameId: 'frame-2' }))
      expect(first.seq).toBe(1)
      await store.saveSnapshot({ docId: D, coveredSeq: 1, doc: deck() })
      await store.pruneOpsThrough(D, 1)
      expect((await store.opsSince(D, 0)).map((o) => o.seq)).toEqual([2]) // op row 1 pruned
      const resend = await store.appendOp(D, 'frame-1', opsFrame(1, { frameId: 'frame-1' }))
      expect(resend.duplicate).toBe(true)
      expect(resend.seq).toBe(1) // from the retained ledger, not re-minted
      expect(await store.currentSeq(D)).toBe(2) // counter did not advance
    })

    it('frameSeq / frameIdentity read the ledger and survive prune (D3)', async () => {
      const store = new DbPptRelayStore()
      await store.appendOp(D, 'frame-1', opsFrame(1, { frameId: 'frame-1' }))
      expect(await store.frameSeq(D, 'frame-1')).toBe(1)
      expect(await store.frameSeq(D, 'never')).toBeNull()
      await store.saveSnapshot({ docId: D, coveredSeq: 1, doc: deck() })
      await store.pruneOpsThrough(D, 1)
      expect(await store.frameSeq(D, 'frame-1')).toBe(1)
    })

    it('P1-1(b): a resend of a pre-upgrade op row with NO ledger row re-acks its original seq', async () => {
      // Model a DB migrated from an earlier deploy: an op row exists (and the
      // counter is at its seq) but the append-time ledger has no row for it. On
      // an ER_DUP_ENTRY from the op-table UNIQUE, the store must re-ack the op's
      // original seq, not surface a permanent storage-failed.
      const frame = opsFrame(1, { frameId: 'pre' })
      const frameJson = JSON.stringify(frame)
      const conn = await getPool().getConnection()
      try {
        await conn.query('INSERT INTO ppt_collab_op (doc_id, seq, frame_id, frame_json, frame_bytes) VALUES (?, ?, ?, ?, ?)', [
          D, 1, 'pre', frameJson, Buffer.byteLength(frameJson, 'utf8'),
        ])
        await conn.query('INSERT INTO ppt_collab_seq (doc_id, last_seq) VALUES (?, 1)', [D])
      } finally {
        conn.release()
      }
      const store = new DbPptRelayStore()
      const res = await store.appendOp(D, 'pre', frame)
      expect(res).toMatchObject({ seq: 1, duplicate: true })
      expect(await store.frameSeq(D, 'pre')).toBe(1) // ledger reconciled for future resends
    })
  })

  describe('snapshot version atomicity & prune (P0-3 / B2)', () => {
    it('two concurrent first snapshots ack DISTINCT versions (no same-version overwrite)', async () => {
      const store = new DbPptRelayStore()
      await store.appendOp(D, 'f1', opsFrame(1, { frameId: 'f1' }))
      const [r1, r2] = await Promise.all([
        store.saveSnapshot({ docId: D, coveredSeq: 1, doc: deck('A') }),
        store.saveSnapshot({ docId: D, coveredSeq: 1, doc: deck('B') }),
      ])
      expect(new Set([r1.snapshotVersion, r2.snapshotVersion])).toEqual(new Set([1, 2]))
    })

    it('a snapshot covering LESS neither rewinds coverage nor bumps the version (P0-3)', async () => {
      const store = new DbPptRelayStore()
      for (const f of ['f1', 'f2', 'f3']) await store.appendOp(D, f, opsFrame(f, { frameId: f }))
      const hi = await store.saveSnapshot({ docId: D, coveredSeq: 3, doc: deck('hi') })
      expect(hi.snapshotVersion).toBe(1)
      const lo = await store.saveSnapshot({ docId: D, coveredSeq: 1, doc: deck('lo') })
      expect(lo.snapshotVersion).toBe(1)
      const snap = await store.getSnapshot(D)
      expect(snap!.coveredSeq).toBe(3)
      expect(snap!.snapshotVersion).toBe(1)
      expect(snap!.doc.title).toBe('hi') // shorter-prefix doc did not overwrite
    })

    it('prune-after-durable reclaims bytes and getSnapshot reflects the latest save', async () => {
      const store = new DbPptRelayStore()
      const a = await store.appendOp(D, 'f1', opsFrame(1, { frameId: 'f1' }))
      const b = await store.appendOp(D, 'f2', opsFrame(2, { frameId: 'f2' }))
      expect(await store.roomBytes(D)).toBe(a.frameBytes + b.frameBytes)
      await store.saveSnapshot({ docId: D, coveredSeq: 1, doc: deck() })
      const freed = await store.pruneOpsThrough(D, 1)
      expect(freed).toBe(a.frameBytes)
      expect(await store.roomBytes(D)).toBe(b.frameBytes)
      expect((await store.opsSince(D, 0)).map((o) => o.seq)).toEqual([2])
    })
  })

  /**
   * The reason this suite exists. The store issues two kinds of statement on
   * mysql2's `conn.execute()` — the PREPARED-STATEMENT protocol — that that
   * protocol/driver cannot handle on real MySQL 8. The in-memory fake routes
   * `execute()` straight through its `query` model
   * (`test/pptDbRelayStore.test.ts`), so it can never tell "works" from
   * "unsupported": exactly the self-confirming gap round-12 review §5 flagged.
   * These tests answer it against a real engine and pin the two defects. No
   * production logic is changed here — the fixes belong to the ordering-model
   * ticket; the tests that CATCH them land here.
   *
   *   FINDING 1 (P1-4, the named case): `inConsistentSnapshot` (dbStore.ts) opens
   *   its replay transaction with
   *       conn.execute('START TRANSACTION WITH CONSISTENT SNAPSHOT')
   *   which is not in the prepared-statement grammar -> ER_UNSUPPORTED_PS (1295).
   *
   *   FINDING 2 (surfaced by this suite): `pptCollabOpRepo.since/sinceTx` bind an
   *   INTEGER to `LIMIT ?` on the same execute() path -> ER_WRONG_ARGUMENTS. Both
   *   the paged replay read and `opsSince(..., limit)` hit it.
   *
   * Blast radius: the production relay's replay() calls store.openReplay(...,
   * { pageRows }), which trips FINDING 1 on the head read and FINDING 2 on the op
   * page. Neither error code is transient, so withStoreRetry rethrows and the
   * relay maps it to the NON-retryable `storage-failed` (socket closed) — durable
   * replay (every client hello / late-join / reconnect) is broken on real MySQL 8.
   */
  describe('prepared-statement protocol defects on the replay path (real MySQL 8)', () => {
    it('P1-4 EVIDENCE: execute() REJECTS START TRANSACTION WITH CONSISTENT SNAPSHOT (ER_UNSUPPORTED_PS); query() accepts it', async () => {
      const conn = await getPool().getConnection()
      try {
        // SET TRANSACTION ISOLATION LEVEL is accepted on the prepared path…
        await expect(conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')).resolves.toBeDefined()
        // …but START TRANSACTION WITH CONSISTENT SNAPSHOT is NOT in the PS grammar.
        await expect(conn.execute('START TRANSACTION WITH CONSISTENT SNAPSHOT')).rejects.toMatchObject({
          code: 'ER_UNSUPPORTED_PS',
          errno: 1295,
        })
        // The text protocol (conn.query) accepts it — the fix is to issue the two
        // transaction-control statements via query(), not execute().
        await expect(conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT')).resolves.toBeDefined()
        await conn.rollback()
      } finally {
        conn.release()
      }
    })

    it('LIMIT EVIDENCE: execute() REJECTS an integer-bound `LIMIT ?` (ER_WRONG_ARGUMENTS); a string / query() accepts it', async () => {
      const conn = await getPool().getConnection()
      try {
        // The exact shape pptCollabOpRepo.sinceTx issues: `... LIMIT ?` with an
        // integer bound on the prepared path.
        await expect(
          conn.execute('SELECT seq FROM ppt_collab_op WHERE doc_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?', [D, 0, 10]),
        ).rejects.toMatchObject({ code: 'ER_WRONG_ARGUMENTS' })
        // A string-bound LIMIT, or the text protocol, both work — candidate fixes.
        await expect(
          conn.execute('SELECT seq FROM ppt_collab_op WHERE doc_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?', [D, 0, '10']),
        ).resolves.toBeDefined()
        await expect(
          conn.query('SELECT seq FROM ppt_collab_op WHERE doc_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?', [D, 0, 10]),
        ).resolves.toBeDefined()
      } finally {
        conn.release()
      }
    })

    it('CONSEQUENCE: store.openReplay() fails on real MySQL 8 (head read trips ER_UNSUPPORTED_PS)', async () => {
      const store = new DbPptRelayStore()
      await store.appendOp(D, 'f1', opsFrame(1, { frameId: 'f1' }))
      await expect(store.openReplay(D, 0, { pageRows: 10, pageBytes: 1_000_000 })).rejects.toMatchObject({
        code: 'ER_UNSUPPORTED_PS',
      })
    })

    it('CONSEQUENCE: store.readReplay() fails on real MySQL 8 (paged read trips ER_WRONG_ARGUMENTS)', async () => {
      // readReplay uses the beginTransaction path (so START TRANSACTION is not the
      // problem here), but its paged op read binds an integer LIMIT on execute().
      const store = new DbPptRelayStore()
      for (const f of ['f1', 'f2', 'f3']) await store.appendOp(D, f, opsFrame(f, { frameId: f }))
      await expect(store.readReplay(D, 0, 1000)).rejects.toMatchObject({ code: 'ER_WRONG_ARGUMENTS' })
    })

    it('CONSEQUENCE: opsSince() with a numeric limit fails; opsSince() without a limit works', async () => {
      const store = new DbPptRelayStore()
      for (const f of ['f1', 'f2', 'f3']) await store.appendOp(D, f, opsFrame(f, { frameId: f }))
      // The no-limit branch avoids `LIMIT ?` and reads fine…
      expect((await store.opsSince(D, 0)).map((o) => o.seq)).toEqual([1, 2, 3])
      // …but passing a bounded page (as the relay's fallback cursor does) trips it.
      await expect(store.opsSince(D, 0, 2)).rejects.toMatchObject({ code: 'ER_WRONG_ARGUMENTS' })
    })

    // Known-broken marker for the whole replay path. The assertion below is what
    // SHOULD hold once the ordering-model ticket fixes BOTH defects (issue the
    // transaction-control statements via query(), and bind LIMIT correctly).
    // openReplay currently THROWS, so `it.fails` passes and keeps the suite green;
    // when both fixes land, openReplay will succeed, this test will start FAILING,
    // and that failure is the signal to promote it to a plain `it(...)`.
    it.fails('WHEN FIXED: openReplay streams the un-pruned op tail from a consistent snapshot', async () => {
      const store = new DbPptRelayStore()
      for (const f of ['f1', 'f2', 'f3']) await store.appendOp(D, f, opsFrame(f, { frameId: f }))
      await store.saveSnapshot({ docId: D, coveredSeq: 1, doc: deck() })
      await store.pruneOpsThrough(D, 1)
      const cursor = await store.openReplay(D, 0, { pageRows: 10, pageBytes: 1_000_000 })
      expect(cursor.highWater).toBe(3)
      expect(cursor.snapshot?.coveredSeq).toBe(1)
      const seqs: number[] = []
      for (;;) {
        const page = await cursor.nextPage()
        if (page.length === 0) break
        seqs.push(...page.map((o) => o.seq))
      }
      await cursor.close()
      expect(seqs).toEqual([2, 3])
    })
  })
})
