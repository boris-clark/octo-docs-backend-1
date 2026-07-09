import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as Y from 'yjs'

// Offline unit test for XIN-656: a board version snapshot must capture the LIVE
// authoritative scene, not the possibly-stale persisted row. We drive both the
// POST create-version handler and the backend auto-snapshot path with a live doc
// that holds drawn Excalidraw elements while the persisted row is still empty
// (the debounced store has not flushed) — exactly the production condition that
// produced ~2-byte empty board snapshots.
//
// The named create-version handler reads the live doc via readLiveDocState
// (openDirectConnection); the auto path encodes the live Y.Doc the store hook
// hands in directly. We drive both with a live scene that holds drawn Excalidraw
// elements while the persisted row is still empty (the debounced store has not
// flushed) — exactly the production condition that produced ~2-byte empty board
// snapshots.

const { live } = vi.hoisted(() => ({ live: { state: new Uint8Array([0, 0]) } }))

vi.mock('../src/api/guard.js', () => ({ requireDocRole: vi.fn() }))
vi.mock('../src/db/pool.js', () => ({ query: vi.fn(async () => []), transaction: vi.fn() }))
// createVersionHandler captures the current live in-memory doc; mock that
// boundary so the handler is unit-testable without a running collab server.
vi.mock('../src/collab/liveDocRead.js', () => ({
  readLiveDocState: vi.fn(async () => live.state),
}))
// Auto-snapshot config gate + Redis dedup + repo (mirrors autoSnapshot.test.ts).
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    autoSnapshot: { enabled: true, idleMs: 15_000, minIntervalMs: 60_000, retainCount: 50, retainDays: 7 },
  },
}))
vi.mock('../src/config/env.js', () => ({ config: mockConfig }))
vi.mock('../src/db/redis.js', () => ({
  acquireLock: vi.fn(async () => true),
  rkey: (...parts: string[]) => ['octo-docs', ...parts].join(':'),
}))

import { createVersionHandler } from '../src/api/routes/versions.js'
import { handleAfterStore, __resetAutoSnapshotState } from '../src/collab/autoSnapshot.js'
import { requireDocRole } from '../src/api/guard.js'
import { docVersionRepo } from '../src/db/repos/docVersionRepo.js'
import { decodeBoardSnapshot } from '../src/collab/versionRestore.js'
import { WB_SCHEMA_VERSION } from '../src/whiteboard/schema/index.js'

interface MockRes {
  statusCode: number
  body: unknown
  status(c: number): MockRes
  json(b: unknown): MockRes
}
function mockRes(): MockRes {
  return {
    statusCode: 0,
    body: undefined,
    status(c: number) {
      this.statusCode = c
      return this
    },
    json(b: unknown) {
      this.body = b
      return this
    },
  }
}
function req(params: Record<string, string>, body: unknown) {
  return { uid: 'u_1', spaceId: 's1', params, body, query: {} } as never
}

/** A minimal Excalidraw rectangle element (fractional index + geometry). */
function rect(id: string, index: string, x = 0): Record<string, unknown> {
  return { id, type: 'rectangle', index, x, y: 0, width: 100, height: 50, isDeleted: false }
}

/**
 * Build a live board Y.Doc the way the front-end binding writes it: a top-level
 * Y.Map('elements') keyed by id, each value a per-element Y.Map, plus a
 * Y.Map('files'). Matches src/whiteboard/ydoc.ts.
 */
function liveBoardDoc(
  elements: Array<Record<string, unknown>>,
  files: Record<string, Record<string, unknown>> = {},
): Y.Doc {
  const doc = new Y.Doc()
  const elMap = doc.getMap('elements')
  const fMap = doc.getMap('files')
  doc.transact(() => {
    for (const el of elements) {
      const y = new Y.Map<unknown>()
      for (const [k, v] of Object.entries(el)) y.set(k, v)
      elMap.set(el.id as string, y)
    }
    for (const [fid, f] of Object.entries(files)) {
      const y = new Y.Map<unknown>()
      for (const [k, v] of Object.entries(f)) y.set(k, v)
      fMap.set(fid, y)
    }
  })
  return doc
}

/** The encoded live board state (what readLiveDocState returns for the doc). */
function liveBoard(
  elements: Array<Record<string, unknown>>,
  files: Record<string, Record<string, unknown>> = {},
): Uint8Array {
  return Y.encodeStateAsUpdate(liveBoardDoc(elements, files))
}

const BOARD_KEY = 'octo:s1:f_default:wb:b_1'
const boardGuard = {
  meta: { doc_id: 'b_1', document_name: BOARD_KEY, doc_type: 'board', permission_epoch: 1 },
  role: 'writer',
} as never

/** An empty Yjs v1 update encodes as exactly two zero bytes. */
const EMPTY_UPDATE_LEN = 2

beforeEach(() => {
  vi.useFakeTimers()
  __resetAutoSnapshotState()
  mockConfig.autoSnapshot.enabled = true
  mockConfig.autoSnapshot.idleMs = 15_000
  mockConfig.autoSnapshot.minIntervalMs = 60_000
  vi.mocked(requireDocRole).mockReset()
})
afterEach(() => {
  __resetAutoSnapshotState()
  vi.useRealTimers()
})

describe('XIN-656 — board version snapshots capture the live scene', () => {
  it('POST create-version stores the drawn elements (non-trivial bytes + round-trip)', async () => {
    // The user has drawn one rectangle; it is live in the in-memory board doc,
    // but the debounced store has NOT flushed it to the persisted row yet.
    live.state = liveBoard([rect('e1', 'a0', 10)])
    vi.mocked(requireDocRole).mockResolvedValue(boardGuard)
    const createSpy = vi.spyOn(docVersionRepo, 'create').mockResolvedValue(42)

    const res = mockRes()
    await createVersionHandler(req({ docId: 'b_1' }, { label: 'v1' }), res as never)

    expect(res.statusCode).toBe(201)
    const stored = createSpy.mock.calls[0]![0]
    // (a) the stored snapshot is NOT the empty ~2-byte payload.
    expect(stored.state.length).toBeGreaterThan(EMPTY_UPDATE_LEN)
    expect(stored.schemaVersion).toBe(WB_SCHEMA_VERSION)
    // (b) it round-trips back to the drawn Excalidraw element.
    const scene = decodeBoardSnapshot(stored.state)
    expect(scene.elements.map((e) => e.id)).toEqual(['e1'])

    createSpy.mockRestore()
  })

  it('auto-snapshot stores the drawn elements (non-trivial bytes + round-trip)', async () => {
    // The live board doc handed to the store hook holds two drawn rectangles.
    const doc = liveBoardDoc([rect('e1', 'a0', 10), rect('e2', 'a1', 20)])
    const createAuto = vi.spyOn(docVersionRepo, 'createAutoWithPrune').mockResolvedValue(7)

    vi.setSystemTime(0)
    await handleAfterStore(BOARD_KEY, { user: { id: 'u_w' } } as never, doc)
    await vi.advanceTimersByTimeAsync(15_000) // idle frame

    expect(createAuto).toHaveBeenCalledTimes(1)
    const stored = createAuto.mock.calls[0]![0]
    expect(stored.state.length).toBeGreaterThan(EMPTY_UPDATE_LEN)
    expect(stored.schemaVersion).toBe(WB_SCHEMA_VERSION)
    const scene = decodeBoardSnapshot(stored.state)
    expect(scene.elements.map((e) => e.id)).toEqual(['e1', 'e2'])

    createAuto.mockRestore()
  })
})
