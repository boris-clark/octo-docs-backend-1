import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as Y from 'yjs'

// Offline unit test for the A4 auto-snapshot trigger logic. We mock the config
// (so the feature gate / thresholds are controllable), the Redis dedup lock,
// and the doc_version repo. The snapshot payload is encoded from the live Y.Doc
// the hook hands in. The pruning SQL itself is covered separately in
// docVersionPrune.test.ts against the mocked pool.
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    autoSnapshot: {
      enabled: true,
      idleMs: 15_000,
      minIntervalMs: 60_000,
      retainCount: 50,
      retainDays: 7,
    },
  },
}))

vi.mock('../src/config/env.js', () => ({ config: mockConfig }))
vi.mock('../src/db/redis.js', () => ({
  acquireLock: vi.fn(async () => true),
  rkey: (...parts: string[]) => ['octo-docs', ...parts].join(':'),
}))
vi.mock('../src/db/repos/docVersionRepo.js', () => ({
  docVersionRepo: { createAutoWithPrune: vi.fn(async () => 1) },
  KIND_AUTO: 1,
}))

import {
  handleAfterStore,
  handleBeforeUnload,
  __resetAutoSnapshotState,
} from '../src/collab/autoSnapshot.js'
import { docVersionRepo } from '../src/db/repos/docVersionRepo.js'
import { acquireLock } from '../src/db/redis.js'
import { SCHEMA_VERSION } from '../src/schema/index.js'
import { WB_SCHEMA_VERSION } from '../src/whiteboard/schema/index.js'

const DOC = 'octo:s1:f1:d1'
const ctx = (id: string) => ({ user: { id } }) as never
/** A fresh live Y.Doc stand-in for the one the store/unload hook hands in. */
const liveDoc = () => new Y.Doc()

const createAuto = vi.mocked(docVersionRepo.createAutoWithPrune)

beforeEach(() => {
  vi.useFakeTimers()
  __resetAutoSnapshotState()
  mockConfig.autoSnapshot.enabled = true
  mockConfig.autoSnapshot.idleMs = 15_000
  mockConfig.autoSnapshot.minIntervalMs = 60_000
  createAuto.mockClear()
  createAuto.mockResolvedValue(1)
  vi.mocked(acquireLock).mockReset()
  vi.mocked(acquireLock).mockResolvedValue(true)
})

afterEach(() => {
  __resetAutoSnapshotState()
  vi.useRealTimers()
})

// ── idle timer: "stopped typing -> clean restore point" ───────────────────────
describe('idle trigger', () => {
  it('fires a single auto snapshot after the idle window with no new store', async () => {
    vi.setSystemTime(0)
    await handleAfterStore(DOC, ctx('u_w'), liveDoc())
    // nothing yet: min-interval not due (0-0<60s), idle timer pending.
    expect(createAuto).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(15_000)
    expect(createAuto).toHaveBeenCalledTimes(1)
    // createdBy is the last writer seen on the store path.
    expect(createAuto.mock.calls[0]![0]).toMatchObject({ docId: 'd1', createdBy: 'u_w' })

    // no further store -> no further frames.
    await vi.advanceTimersByTimeAsync(120_000)
    expect(createAuto).toHaveBeenCalledTimes(1)
  })

  it('only the latest stop snapshots when stores keep coming (timer re-armed)', async () => {
    vi.setSystemTime(0)
    await handleAfterStore(DOC, ctx('u_w'), liveDoc())
    vi.setSystemTime(10_000)
    await handleAfterStore(DOC, ctx('u_w'), liveDoc()) // clears the first timer, re-arms @25s
    // advance only to 24s: the first (cleared) timer's slot passes, nothing fires.
    await vi.advanceTimersByTimeAsync(14_000)
    expect(createAuto).not.toHaveBeenCalled()
    // reach 25s: the single live timer fires exactly once.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(createAuto).toHaveBeenCalledTimes(1)
  })

  it('uses the short idle dedup key', async () => {
    vi.setSystemTime(0)
    await handleAfterStore(DOC, ctx('u_w'), liveDoc())
    await vi.advanceTimersByTimeAsync(15_000)
    expect(acquireLock).toHaveBeenCalledWith('octo-docs:autosnap:idle:' + DOC, 15_000)
  })

  it('skips the idle frame when the Redis idle lock is already held', async () => {
    vi.mocked(acquireLock).mockResolvedValue(false)
    vi.setSystemTime(0)
    await handleAfterStore(DOC, ctx('u_w'), liveDoc())
    await vi.advanceTimersByTimeAsync(15_000)
    expect(createAuto).not.toHaveBeenCalled()
  })
})

// ── min-interval fallback: continuous high-frequency editing ──────────────────
describe('min-interval fallback', () => {
  it('snapshots at most once per min-interval window during continuous editing', async () => {
    const base = 1_000_000
    // 7 stores spaced 10s apart (< idleMs, so the idle timer never fires) span
    // 60s -> exactly two min-interval frames (t and t+60s).
    for (let i = 0; i <= 6; i++) {
      vi.setSystemTime(base + i * 10_000)
      await handleAfterStore(DOC, ctx('u_w'), liveDoc())
    }
    expect(createAuto).toHaveBeenCalledTimes(2)
    expect(acquireLock).toHaveBeenCalledWith('octo-docs:autosnap:mininterval:' + DOC, 60_000)
  })

  it('skips the min-interval frame when its Redis lock is already held', async () => {
    vi.mocked(acquireLock).mockResolvedValue(false)
    vi.setSystemTime(1_000_000)
    await handleAfterStore(DOC, ctx('u_w'), liveDoc())
    expect(createAuto).not.toHaveBeenCalled()
  })
})

// ── feature gate ──────────────────────────────────────────────────────────────
describe('AUTO_SNAPSHOT_ENABLED gate', () => {
  it('produces zero auto rows when disabled', async () => {
    mockConfig.autoSnapshot.enabled = false
    vi.setSystemTime(1_000_000)
    await handleAfterStore(DOC, ctx('u_w'), liveDoc())
    await vi.advanceTimersByTimeAsync(120_000)
    await handleBeforeUnload(DOC, liveDoc())
    expect(createAuto).not.toHaveBeenCalled()
    expect(acquireLock).not.toHaveBeenCalled()
  })
})

// ── unload flush + state cleanup ──────────────────────────────────────────────
describe('unload', () => {
  it('flushes a final frame when there are edits since the last auto', async () => {
    vi.setSystemTime(5_000)
    await handleAfterStore(DOC, ctx('u_w'), liveDoc()) // lastStore=5000 > lastAuto=0, no min-interval
    expect(createAuto).not.toHaveBeenCalled()
    await handleBeforeUnload(DOC, liveDoc())
    expect(createAuto).toHaveBeenCalledTimes(1)
    // the idle timer was cleared and per-doc state dropped: time passing is inert.
    await vi.advanceTimersByTimeAsync(120_000)
    expect(createAuto).toHaveBeenCalledTimes(1)
  })

  it('does not flush when no edits happened since the last auto', async () => {
    vi.setSystemTime(1_000_000)
    await handleAfterStore(DOC, ctx('u_w'), liveDoc()) // min-interval frame -> lastAuto == lastStore
    expect(createAuto).toHaveBeenCalledTimes(1)
    await handleBeforeUnload(DOC, liveDoc())
    expect(createAuto).toHaveBeenCalledTimes(1) // no extra flush
  })

  it('is a no-op for an unknown / already-unloaded document', async () => {
    await handleBeforeUnload('octo:s1:f1:dX', liveDoc())
    expect(createAuto).not.toHaveBeenCalled()
  })
})

// ── docId derivation ──────────────────────────────────────────────────────────
describe('docId derivation', () => {
  it('snapshots whiteboard keys, deriving docId from the board segment (XIN-26 item 5)', async () => {
    vi.setSystemTime(0)
    await handleAfterStore('octo:s1:f1:wb:b1', ctx('u_w'), liveDoc()) // whiteboard key
    await vi.advanceTimersByTimeAsync(15_000)
    expect(createAuto).toHaveBeenCalled()
    // Board snapshots stamp the whiteboard schema line (WB_SCHEMA_VERSION),
    // strictly isolated from the ProseMirror SCHEMA_VERSION (§11.5 / P2).
    expect(createAuto.mock.calls[0]![0]).toMatchObject({
      docId: 'b1',
      documentName: 'octo:s1:f1:wb:b1',
      schemaVersion: WB_SCHEMA_VERSION,
    })
  })

  it('stamps the ProseMirror SCHEMA_VERSION on a rich-text doc snapshot (§11.5 isolation)', async () => {
    vi.setSystemTime(0)
    await handleAfterStore('octo:s1:f1:d1', ctx('u_d'), liveDoc()) // 4-seg document key
    await vi.advanceTimersByTimeAsync(15_000)
    expect(createAuto).toHaveBeenCalled()
    expect(createAuto.mock.calls[0]![0]).toMatchObject({ docId: 'd1', schemaVersion: SCHEMA_VERSION })
    // sanity: the two schema lines are distinct, so the board branch is meaningful.
    expect(SCHEMA_VERSION).not.toBe(WB_SCHEMA_VERSION)
  })

  it('skips a malformed key that parses to neither a document nor a whiteboard', async () => {
    vi.setSystemTime(0)
    await handleAfterStore('not-an-octo-key', ctx('u_w'), liveDoc())
    await vi.advanceTimersByTimeAsync(15_000)
    expect(createAuto).not.toHaveBeenCalled()
  })
})
