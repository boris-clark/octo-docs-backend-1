import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as Y from 'yjs'
import { gzipSync, gunzipSync } from 'node:zlib'

// Offline unit test: mock the auth guard and the MySQL pool. The real repos run
// against the mocked `query` / `transaction`, so route handlers and the repo
// round-trip are exercised without live infra (mirrors attachments.test.ts).
vi.mock('../src/api/guard.js', () => ({
  requireDocRole: vi.fn(),
}))
vi.mock('../src/db/pool.js', () => ({
  query: vi.fn(async () => []),
  transaction: vi.fn(),
}))
// The content write happens on the LIVE Hocuspocus document via
// openDirectConnection; mock that boundary so the service is unit-testable
// without a running collab server.
vi.mock('../src/collab/liveRestore.js', () => ({
  applyRestoreToLiveDoc: vi.fn(async () => {}),
  applyBoardRestoreToLiveDoc: vi.fn(async () => {}),
}))

import {
  listVersionsHandler,
  createVersionHandler,
  getVersionStateHandler,
  renameVersionHandler,
  deleteVersionHandler,
  restoreVersionHandler,
} from '../src/api/routes/versions.js'
import { requireDocRole } from '../src/api/guard.js'
import {
  docVersionRepo,
  KIND_AUTO,
  KIND_NAMED,
  KIND_RESTORE_MARKER,
} from '../src/db/repos/docVersionRepo.js'
import { restoreVersion } from '../src/api/services/restoreVersion.js'
import { persistence } from '../src/collab/persistence.js'
import { applyRestoreToLiveDoc, applyBoardRestoreToLiveDoc } from '../src/collab/liveRestore.js'
import { query, transaction } from '../src/db/pool.js'
import {
  gateSchema,
  gateSchemaForKind,
  restoreReconcile,
  restoreReconcileBoard,
  decodeBoardSnapshot,
  contentKindFromDocType,
  currentSchemaVersionFor,
  SchemaIncompatibleError,
} from '../src/collab/versionRestore.js'
import { computeFinalState } from '../src/collab/persistence.js'
import { buildSchema, COLLAB_FIELD, SCHEMA_VERSION } from '../src/schema/index.js'
import { WB_SCHEMA_VERSION } from '../src/whiteboard/schema/index.js'
import { Node as PMNode } from 'prosemirror-model'
import { prosemirrorToYDoc, prosemirrorToYXmlFragment, yDocToProsemirrorJSON } from 'y-prosemirror'

const schema = buildSchema()

interface MockRes {
  statusCode: number
  body: unknown
  headers: Record<string, string>
  sent: unknown
  status(c: number): MockRes
  json(b: unknown): MockRes
  setHeader(k: string, v: string): void
  send(b: unknown): MockRes
}

function mockRes(): MockRes {
  return {
    statusCode: 0,
    body: undefined,
    headers: {},
    sent: undefined,
    status(c: number) {
      this.statusCode = c
      return this
    },
    json(b: unknown) {
      this.body = b
      return this
    },
    setHeader(k: string, v: string) {
      this.headers[k] = v
    },
    send(b: unknown) {
      this.sent = b
      return this
    },
  }
}

function req(params: Record<string, string>, opts: { body?: unknown; query?: Record<string, unknown> } = {}) {
  return { uid: 'u_1', spaceId: 's1', params, body: opts.body, query: opts.query ?? {} } as never
}

const adminGuard = {
  meta: { doc_id: 'd_1', document_name: 'octo:s1:f_default:d_1', permission_epoch: 7 },
  role: 'admin',
} as never

/** Build a Yjs state from ProseMirror JSON (the snapshot format). */
function stateFromPM(pmJSON: unknown): Uint8Array {
  const node = PMNode.fromJSON(schema, pmJSON as Parameters<typeof PMNode.fromJSON>[1])
  const doc = prosemirrorToYDoc(node, COLLAB_FIELD)
  return Y.encodeStateAsUpdate(doc)
}

/**
 * Build a Yjs state for a whiteboard snapshot: the ELEMENTS_FIELD / FILES_FIELD
 * maps keyed by id, each value a per-entry Y.Map (matches whiteboard/ydoc.ts).
 */
function stateFromBoard(
  elements: Array<Record<string, unknown>>,
  files: Record<string, Record<string, unknown>> = {},
): Uint8Array {
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
  return Y.encodeStateAsUpdate(doc)
}

function para(text: string) {
  return { type: 'paragraph', content: [{ type: 'text', text }] }
}

/** Concatenate all paragraph texts of a doc's ProseMirror JSON. */
function paragraphTexts(pmJSON: unknown): string[] {
  const doc = pmJSON as { content?: Array<{ content?: Array<{ text?: string }> }> }
  return (doc.content ?? []).map((b) => (b.content ?? []).map((c) => c.text ?? '').join(''))
}

beforeEach(() => {
  vi.mocked(requireDocRole).mockReset()
  vi.mocked(query).mockReset()
  vi.mocked(query).mockResolvedValue([] as never)
  vi.mocked(transaction).mockReset()
  vi.mocked(applyRestoreToLiveDoc).mockReset()
  vi.mocked(applyRestoreToLiveDoc).mockResolvedValue(undefined)
  vi.mocked(applyBoardRestoreToLiveDoc).mockReset()
  vi.mocked(applyBoardRestoreToLiveDoc).mockResolvedValue(undefined)
})

// ── role gating: the min-role chosen per endpoint ─────────────────────────────
describe('role gating (server authority, §4.2 / §5.6)', () => {
  beforeEach(() => {
    // Block at the guard so each handler returns after the requireDocRole call;
    // we only assert which minRole it demanded.
    vi.mocked(requireDocRole).mockResolvedValue(null)
  })

  it('list requires reader', async () => {
    await listVersionsHandler(req({ docId: 'd_1' }), mockRes() as never)
    // The space (4th arg) is threaded from req.spaceId; the minRole is the 5th arg.
    expect(vi.mocked(requireDocRole).mock.calls[0]![3]).toBe('s1')
    expect(vi.mocked(requireDocRole).mock.calls[0]![4]).toBe('reader')
  })

  it('state preview requires reader', async () => {
    await getVersionStateHandler(req({ docId: 'd_1', versionId: '1' }), mockRes() as never)
    expect(vi.mocked(requireDocRole).mock.calls[0]![4]).toBe('reader')
  })

  it('snapshot requires writer', async () => {
    await createVersionHandler(req({ docId: 'd_1' }, { body: {} }), mockRes() as never)
    expect(vi.mocked(requireDocRole).mock.calls[0]![4]).toBe('writer')
  })

  it('rename requires writer', async () => {
    await renameVersionHandler(req({ docId: 'd_1', versionId: '1' }, { body: { name: 'x' } }), mockRes() as never)
    expect(vi.mocked(requireDocRole).mock.calls[0]![4]).toBe('writer')
  })

  it('delete requires admin (boss call)', async () => {
    await deleteVersionHandler(req({ docId: 'd_1', versionId: '1' }), mockRes() as never)
    expect(vi.mocked(requireDocRole).mock.calls[0]![4]).toBe('admin')
  })

  it('restore requires admin (boss call)', async () => {
    await restoreVersionHandler(req({ docId: 'd_1', versionId: '1' }), mockRes() as never)
    expect(vi.mocked(requireDocRole).mock.calls[0]![4]).toBe('admin')
  })
})

// ── wire contract: serialized field names (FE<->BE) ───────────────────────────
describe('version wire contract (serialized field names)', () => {
  it('list serializes the full row field set (docVersionSeq, kind, label, restoredFrom, ...) and the nextCursor wrapper', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(adminGuard)
    vi.spyOn(docVersionRepo, 'listByDoc').mockResolvedValue({
      items: [
        {
          id: 43,
          kind: 3,
          name: 'Auto-safety before restore',
          restoredFrom: 12,
          sizeBytes: 20,
          schemaVersion: SCHEMA_VERSION,
          createdAt: new Date(0),
          createdBy: 'u_2',
        },
        {
          id: 42,
          kind: 2,
          name: 'My snapshot',
          restoredFrom: null,
          sizeBytes: 10,
          schemaVersion: SCHEMA_VERSION,
          createdAt: new Date(0),
          createdBy: 'u_1',
        },
      ],
      nextCursor: 42,
    } as never)

    const res = mockRes()
    await listVersionsHandler(req({ docId: 'd_1' }), res as never)

    const body = res.body as { items: Array<Record<string, unknown>>; nextCursor: number | null }
    // Paginated wrapper carries the rows array and `nextCursor`.
    expect(body.nextCursor).toBe(42)

    const marker = body.items[0]!
    // EXACT canonical field set — no more, no less.
    expect(Object.keys(marker).sort()).toEqual(
      ['createdAt', 'createdBy', 'docVersionSeq', 'kind', 'label', 'restoredFrom', 'schemaVersion', 'sizeBytes'].sort(),
    )
    expect(marker.docVersionSeq).toBe(43)
    expect(marker.kind).toBe(3)
    expect(marker.label).toBe('Auto-safety before restore')
    expect(marker.restoredFrom).toBe(12)

    const named = body.items[1]!
    expect(named.docVersionSeq).toBe(42)
    expect(named.label).toBe('My snapshot')
    expect(named.kind).toBe(2)
    // Ordinary snapshot was not produced by a restore.
    expect(named.restoredFrom).toBeNull()
    // Legacy keys are gone (the frontend drift guard rejects id/name).
    expect(named).not.toHaveProperty('id')
    expect(named).not.toHaveProperty('name')
    expect(named).not.toHaveProperty('safetyVersionId')
    expect(named.sizeBytes).toBe(10)
    expect(named.schemaVersion).toBe(SCHEMA_VERSION)

    vi.mocked(docVersionRepo.listByDoc).mockRestore()
  })

  it('list reads pagination from the canonical cursor/limit query params', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(adminGuard)
    const listSpy = vi.spyOn(docVersionRepo, 'listByDoc').mockResolvedValue({
      items: [],
      nextCursor: null,
    } as never)

    const res = mockRes()
    await listVersionsHandler(req({ docId: 'd_1' }, { query: { cursor: '99', limit: '5' } }), res as never)

    expect(listSpy.mock.calls[0]![1]).toMatchObject({ cursor: 99, limit: 5 })

    listSpy.mockRestore()
  })

  it('create reads the label from req.body.label and returns docVersionSeq', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(adminGuard)
    vi.spyOn(persistence, 'fetch').mockResolvedValue(null)
    const createSpy = vi.spyOn(docVersionRepo, 'create').mockResolvedValue(7)

    const res = mockRes()
    await createVersionHandler(req({ docId: 'd_1' }, { body: { label: 'Named A' } }), res as never)

    expect(res.statusCode).toBe(201)
    expect((res.body as { docVersionSeq: number }).docVersionSeq).toBe(7)
    expect(createSpy.mock.calls[0]![0].name).toBe('Named A')

    createSpy.mockRestore()
    vi.mocked(persistence.fetch).mockRestore()
  })

  it('restore response uses restoredFrom and newDocVersionSeq (end-to-end through the handler)', async () => {
    const documentName = 'octo:s1:f_default:d_1'
    vi.mocked(requireDocRole).mockResolvedValue(adminGuard)
    vi.spyOn(docVersionRepo, 'getStateById').mockResolvedValue({
      version: {
        id: 5,
        docId: 'd_1',
        documentName,
        kind: 2,
        name: '',
        compressed: 1,
        sizeBytes: 2,
        schemaVersion: SCHEMA_VERSION,
        createdAt: new Date(0),
        createdBy: 'u_1',
      },
      state: stateFromPM({ type: 'doc', content: [para('A')] }),
    })
    const createSpy = vi.spyOn(docVersionRepo, 'createTx').mockResolvedValue(99)
    vi.mocked(transaction).mockImplementation(async (fn: never) => {
      const tx = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes('FROM yjs_document')) return []
          if (sql.includes('FROM doc_meta')) return [{ owner_id: 'u_1', permission_epoch: 7, status: 1 }]
          if (sql.includes('LAST_INSERT_ID')) return [{ id: 99 }]
          return []
        }),
      }
      return (fn as unknown as (t: typeof tx) => Promise<unknown>)(tx)
    })

    const res = mockRes()
    await restoreVersionHandler(req({ docId: 'd_1', versionId: '5' }), res as never)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ restoredFrom: 5, newDocVersionSeq: 99 })
    expect(applyRestoreToLiveDoc).toHaveBeenCalledTimes(1)

    createSpy.mockRestore()
    vi.mocked(docVersionRepo.getStateById).mockRestore()
  })
})

// ── schema forward-compat gate ────────────────────────────────────────────────
describe('gateSchema (forward-compat)', () => {
  it('rejects a target from a NEWER schema with version_schema_newer', () => {
    const g = gateSchema(SCHEMA_VERSION + 1)
    expect(g.ok).toBe(false)
    if (!g.ok) {
      expect(g.code).toBe('version_schema_newer')
      expect(g.status).toBe(409)
    }
  })

  it('accepts the current schema version', () => {
    expect(gateSchema(SCHEMA_VERSION).ok).toBe(true)
  })

  it('accepts an OLDER schema version (loadability checked at reconcile time)', () => {
    expect(gateSchema(1).ok).toBe(true)
  })
})

describe('restore endpoint schema gate', () => {
  it('returns 409 version_schema_newer when the target schema is newer', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(adminGuard)
    vi.spyOn(docVersionRepo, 'getStateById').mockResolvedValue({
      version: {
        id: 1,
        docId: 'd_1',
        documentName: 'octo:s1:f_default:d_1',
        kind: 2,
        name: '',
        compressed: 1,
        sizeBytes: 2,
        schemaVersion: SCHEMA_VERSION + 1,
        createdAt: new Date(0),
        createdBy: 'u_1',
      },
      state: stateFromPM({ type: 'doc', content: [para('A')] }),
    })
    const res = mockRes()
    await restoreVersionHandler(req({ docId: 'd_1', versionId: '1' }), res as never)
    expect(res.statusCode).toBe(409)
    expect((res.body as { error: string }).error).toBe('version_schema_newer')
    vi.mocked(docVersionRepo.getStateById).mockRestore()
  })
})

// ── preview endpoint: backend-decoded PM JSON, schema gate + empty-doc fallback ─
// Mirrors the restore path's protections (gateSchema + decodeTargetSnapshot) that
// the preview endpoint previously lacked. Preview reuses the SAME pure helpers and
// must never touch any restore write path.
describe('getVersionStateHandler — decoded preview (A3)', () => {
  function versionRow(overrides: Partial<{ docId: string; schemaVersion: number }> = {}) {
    return {
      id: 5,
      docId: overrides.docId ?? 'd_1',
      documentName: 'octo:s1:f_default:d_1',
      kind: 2,
      name: '',
      restoredFrom: null,
      compressed: 1,
      sizeBytes: 2,
      schemaVersion: overrides.schemaVersion ?? SCHEMA_VERSION,
      createdAt: new Date(0),
      createdBy: 'u_1',
    }
  }

  // T1: a brand-new doc snapshotted before any edit stores an empty Y.Doc, which
  // decodes to a contentless `doc` — preview must return the canonical empty doc
  // (one empty paragraph), NOT an error.
  it('returns 200 + canonical empty doc for an empty snapshot (new doc, immediate save)', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(adminGuard)
    const emptyState = Y.encodeStateAsUpdate(new Y.Doc())
    vi.spyOn(docVersionRepo, 'getStateById').mockResolvedValue({
      version: versionRow() as never,
      state: emptyState,
    })

    const res = mockRes()
    await getVersionStateHandler(req({ docId: 'd_1', versionId: '5' }), res as never)

    expect(res.statusCode).toBe(200)
    expect(res.headers['Content-Type']).toBeUndefined() // JSON, not octet-stream
    const body = res.body as { doc: { content?: unknown[] }; schemaVersion: number; docVersionSeq: number }
    expect(body.doc.content).toHaveLength(1)
    expect(paragraphTexts(body.doc)).toEqual([''])
    expect(body.schemaVersion).toBe(SCHEMA_VERSION)
    expect(body.docVersionSeq).toBe(5)

    vi.mocked(docVersionRepo.getStateById).mockRestore()
  })

  // T2: a snapshot from a NEWER schema cannot be safely loaded → 409, consistent
  // with the restore path's error code.
  it('returns 409 version_schema_newer when the target schema is newer', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(adminGuard)
    vi.spyOn(docVersionRepo, 'getStateById').mockResolvedValue({
      version: versionRow({ schemaVersion: SCHEMA_VERSION + 1 }) as never,
      state: stateFromPM({ type: 'doc', content: [para('A')] }),
    })

    const res = mockRes()
    await getVersionStateHandler(req({ docId: 'd_1', versionId: '5' }), res as never)

    expect(res.statusCode).toBe(409)
    expect((res.body as { error: string }).error).toBe('version_schema_newer')

    vi.mocked(docVersionRepo.getStateById).mockRestore()
  })

  // T3: a normal non-empty snapshot decodes to its exact PM JSON content.
  it('returns 200 with the decoded PM JSON for a normal non-empty version', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(adminGuard)
    vi.spyOn(docVersionRepo, 'getStateById').mockResolvedValue({
      version: versionRow() as never,
      state: stateFromPM({ type: 'doc', content: [para('hello'), para('world')] }),
    })

    const res = mockRes()
    await getVersionStateHandler(req({ docId: 'd_1', versionId: '5' }), res as never)

    expect(res.statusCode).toBe(200)
    const body = res.body as { doc: unknown; schemaVersion: number; docVersionSeq: number }
    expect((body.doc as { type: string }).type).toBe('doc')
    expect(paragraphTexts(body.doc)).toEqual(['hello', 'world'])
    expect(body.docVersionSeq).toBe(5)

    vi.mocked(docVersionRepo.getStateById).mockRestore()
  })

  // T4: a versionId belonging to another doc is hidden behind 404 (no existence leak).
  it('returns 404 not_found for a cross-doc versionId', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(adminGuard)
    vi.spyOn(docVersionRepo, 'getStateById').mockResolvedValue({
      version: versionRow({ docId: 'd_other' }) as never,
      state: stateFromPM({ type: 'doc', content: [para('A')] }),
    })

    const res = mockRes()
    await getVersionStateHandler(req({ docId: 'd_1', versionId: '5' }), res as never)

    expect(res.statusCode).toBe(404)
    expect((res.body as { error: string }).error).toBe('not_found')

    vi.mocked(docVersionRepo.getStateById).mockRestore()
  })

  it('returns 400 invalid_version_id for a non-positive-integer versionId', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(adminGuard)
    const res = mockRes()
    await getVersionStateHandler(req({ docId: 'd_1', versionId: 'abc' }), res as never)
    expect(res.statusCode).toBe(400)
    expect((res.body as { error: string }).error).toBe('invalid_version_id')
  })

  // T5: preview reuses only the PURE decode helpers — it must NOT touch any restore
  // write path (no transaction, no createTx, no live-document apply).
  it('never touches the restore write path (pure decode only)', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(adminGuard)
    vi.spyOn(docVersionRepo, 'getStateById').mockResolvedValue({
      version: versionRow() as never,
      state: stateFromPM({ type: 'doc', content: [para('A')] }),
    })
    const createTxSpy = vi.spyOn(docVersionRepo, 'createTx')

    const res = mockRes()
    await getVersionStateHandler(req({ docId: 'd_1', versionId: '5' }), res as never)

    expect(res.statusCode).toBe(200)
    expect(transaction).not.toHaveBeenCalled()
    expect(createTxSpy).not.toHaveBeenCalled()
    expect(applyRestoreToLiveDoc).not.toHaveBeenCalled()

    createTxSpy.mockRestore()
    vi.mocked(docVersionRepo.getStateById).mockRestore()
  })
})

// ── gzip round-trip through the repo (compress on write, decompress on read) ──
describe('docVersionRepo gzip round-trip (§4 state_blob)', () => {
  it('create gzips the state; getStateById gunzips back to identical bytes', async () => {
    const state = stateFromPM({ type: 'doc', content: [para('hello'), para('world')] })

    // Capture the blob the repo inserts under a faked transaction.
    let insertedBlob: Buffer | undefined
    vi.mocked(transaction).mockImplementation(async (fn: never) => {
      const tx = {
        query: vi.fn(async (sql: string, params?: unknown[]) => {
          if (sql.includes('INSERT INTO doc_version')) {
            insertedBlob = params![5] as Buffer
            return []
          }
          if (sql.includes('LAST_INSERT_ID')) return [{ id: 42 }]
          return []
        }),
      }
      return (fn as unknown as (t: typeof tx) => Promise<unknown>)(tx)
    })

    const id = await docVersionRepo.create({
      docId: 'd_1',
      documentName: 'octo:s1:f_default:d_1',
      kind: 2,
      state,
      schemaVersion: SCHEMA_VERSION,
      createdBy: 'u_1',
    })
    expect(id).toBe(42)
    expect(insertedBlob).toBeInstanceOf(Buffer)
    // Stored blob is gzip-compressed, not the raw state.
    expect(Uint8Array.from(insertedBlob!)).not.toEqual(state)

    // Feed that same blob back through getStateById's SELECT.
    vi.mocked(query).mockResolvedValue([
      {
        id: 42,
        doc_id: 'd_1',
        document_name: 'octo:s1:f_default:d_1',
        kind: 2,
        name: '',
        compressed: 1,
        size_bytes: state.length,
        schema_version: SCHEMA_VERSION,
        created_at: new Date(0),
        created_by: 'u_1',
        state_blob: insertedBlob,
      },
    ] as never)
    const got = await docVersionRepo.getStateById(42)
    expect(got!.state).toEqual(state)
    // And the decoded content round-trips.
    const doc = new Y.Doc()
    Y.applyUpdate(doc, got!.state)
    expect(paragraphTexts(yDocToProsemirrorJSON(doc, COLLAB_FIELD))).toEqual(['hello', 'world'])
  })

  it('getStateById returns raw bytes unchanged when compressed=0', async () => {
    const state = stateFromPM({ type: 'doc', content: [para('plain')] })
    vi.mocked(query).mockResolvedValue([
      {
        id: 7,
        doc_id: 'd_1',
        document_name: 'octo:s1:f_default:d_1',
        kind: 2,
        name: '',
        compressed: 0,
        size_bytes: state.length,
        schema_version: SCHEMA_VERSION,
        created_at: new Date(0),
        created_by: 'u_1',
        state_blob: Buffer.from(state),
      },
    ] as never)
    const got = await docVersionRepo.getStateById(7)
    expect(got!.state).toEqual(state)
  })

  it('plain node:zlib gzip of the Yjs state round-trips losslessly', () => {
    const state = stateFromPM({ type: 'doc', content: [para('round')] })
    const blob = gzipSync(Buffer.from(state))
    expect(Uint8Array.from(gunzipSync(blob))).toEqual(state)
  })
})

// ── restore reconcile: forward, union-safe, deletions take effect ─────────────
describe('restoreReconcile — union-safe forward restore (the core, §4)', () => {
  it('reconciles target content into live and drops the live-only paragraph (no union reback)', () => {
    // Snapshot (target): [A, B]. Live continues forward: [A, B, C].
    const targetState = stateFromPM({ type: 'doc', content: [para('A'), para('B')] })

    // Build live as a FORWARD continuation of the target snapshot's doc, so live
    // ⊇ target in CRDT terms (mirrors a doc that kept evolving after the snapshot).
    const liveDoc = new Y.Doc()
    Y.applyUpdate(liveDoc, targetState)
    const liveFragment = liveDoc.get(COLLAB_FIELD, Y.XmlFragment)
    const liveJSON = PMNode.fromJSON(schema, { type: 'doc', content: [para('A'), para('B'), para('C')] })
    liveDoc.transact(() => {
      prosemirrorToYXmlFragment(liveJSON, liveFragment)
    })
    const liveState = Y.encodeStateAsUpdate(liveDoc)
    // Sanity: live really has the extra paragraph before restore.
    expect(paragraphTexts(yDocToProsemirrorJSON(liveDoc, COLLAB_FIELD))).toEqual(['A', 'B', 'C'])

    // Restore the target into the live state.
    const reconciled = restoreReconcile(liveState, targetState)

    // 1) Content now equals the TARGET — the live-only 'C' paragraph is gone
    //    (the deletion actually took effect; not a no-op).
    const out = new Y.Doc()
    Y.applyUpdate(out, reconciled)
    const texts = paragraphTexts(yDocToProsemirrorJSON(out, COLLAB_FIELD))
    expect(texts).toEqual(['A', 'B'])
    expect(texts).not.toContain('C')

    // 2) The write is on the union-safe direction: reconciled ⊇ liveState, so
    //    computeFinalState takes the diffUpdate bypass — NO union reback.
    const { finalState, usedUnion } = computeFinalState(liveState, reconciled)
    expect(usedUnion).toBe(false)
    expect(Uint8Array.from(finalState)).toEqual(reconciled)

    // 3) And the persisted result still has 'C' gone (proves no reback resurrects it).
    const persisted = new Y.Doc()
    Y.applyUpdate(persisted, new Uint8Array(finalState))
    expect(paragraphTexts(yDocToProsemirrorJSON(persisted, COLLAB_FIELD))).not.toContain('C')
  })

  it('restores onto a null (cold) live state by reconstructing the target content', () => {
    const targetState = stateFromPM({ type: 'doc', content: [para('only')] })
    const reconciled = restoreReconcile(null, targetState)
    const out = new Y.Doc()
    Y.applyUpdate(out, reconciled)
    expect(paragraphTexts(yDocToProsemirrorJSON(out, COLLAB_FIELD))).toEqual(['only'])
  })

  it('throws SchemaIncompatibleError when the target uses an unknown node type', () => {
    // Hand-build a Y.Doc whose fragment holds a node the current schema lacks.
    const bad = new Y.Doc()
    const frag = bad.get(COLLAB_FIELD, Y.XmlFragment)
    bad.transact(() => {
      frag.insert(0, [new Y.XmlElement('frobnicate')])
    })
    const badState = Y.encodeStateAsUpdate(bad)
    expect(() => restoreReconcile(null, badState)).toThrow(SchemaIncompatibleError)
  })

  // ── empty-snapshot restore: canonical empty doc, NOT a 409 (BUG1) ───────────
  it('restores an empty snapshot as the canonical empty doc (not version_schema_incompatible)', () => {
    // A brand-new doc snapshotted before any edit stores an empty Y.Doc (see
    // createVersionHandler). Decoding it yields a contentless `doc`, which
    // violates the top node's `block+` expression — but that is a valid empty
    // document, not a schema incompatibility.
    const emptyState = Y.encodeStateAsUpdate(new Y.Doc())
    let reconciled: Uint8Array | undefined
    expect(() => {
      reconciled = restoreReconcile(null, emptyState)
    }).not.toThrow()

    const out = new Y.Doc()
    Y.applyUpdate(out, reconciled!)
    const json = yDocToProsemirrorJSON(out, COLLAB_FIELD) as { content?: unknown[] }
    // Canonical empty doc: createAndFill supplies a single empty paragraph.
    expect(json.content).toHaveLength(1)
    expect(paragraphTexts(json)).toEqual([''])
  })

  it('restoring an empty snapshot over a populated live doc reduces it to the canonical empty doc', () => {
    const liveState = stateFromPM({ type: 'doc', content: [para('A'), para('B')] })
    const emptyState = Y.encodeStateAsUpdate(new Y.Doc())

    const reconciled = restoreReconcile(liveState, emptyState)
    const out = new Y.Doc()
    Y.applyUpdate(out, reconciled)
    expect(paragraphTexts(yDocToProsemirrorJSON(out, COLLAB_FIELD))).toEqual([''])

    // Still union-safe: reconciled ⊇ live, so no union reback (Steve's invariant).
    const { usedUnion } = computeFinalState(liveState, reconciled)
    expect(usedUnion).toBe(false)
  })

  it('non-empty content that is genuinely incompatible still throws (empty-case fix does not swallow real incompatibility)', () => {
    // A fragment with a known node wrapping an unknown one: not empty, but cannot
    // load under the current schema → must still be SchemaIncompatibleError.
    const bad = new Y.Doc()
    const frag = bad.get(COLLAB_FIELD, Y.XmlFragment)
    bad.transact(() => {
      const el = new Y.XmlElement('paragraph')
      el.insert(0, [new Y.XmlElement('frobnicate')])
      frag.insert(0, [el])
    })
    const badState = Y.encodeStateAsUpdate(bad)
    expect(() => restoreReconcile(null, badState)).toThrow(SchemaIncompatibleError)
  })
})

// ── safety snapshot rolls back on a failed restore (BUG2) ─────────────────────
// The safety-snapshot insert must happen only after the fallible reconcile +
// size check succeed. transaction() rolls back only on a THROW, and the failure
// branches `return { ok: false }` (not throw) — so an early safety insert would
// be committed, leaking an orphan "Auto-safety before restore" row. Assert ZERO
// safety rows are inserted on the failure path, and exactly one on success.
describe('restoreVersion service — safety snapshot (BUG2 rollback)', () => {
  const documentName = 'octo:s1:f_default:d_1'

  function metaRow() {
    // owner_id === uid ⇒ admin under the lock without a docMemberRepo lookup.
    return { owner_id: 'u_1', permission_epoch: 7, status: 1 }
  }

  /** transaction() mock that runs the callback against an SQL-routed tx. */
  function mockTx(captured?: string[]) {
    vi.mocked(transaction).mockImplementation(async (fn: never) => {
      const tx = {
        query: vi.fn(async (sql: string) => {
          captured?.push(sql)
          if (sql.includes('FROM yjs_document')) return [] // cold live state
          if (sql.includes('FROM doc_meta')) return [metaRow()]
          if (sql.includes('LAST_INSERT_ID')) return [{ id: 99 }]
          return []
        }),
      }
      return (fn as unknown as (t: typeof tx) => Promise<unknown>)(tx)
    })
  }

  it('inserts NO safety row when the reconcile fails after the auth/epoch checks', async () => {
    // Target snapshot holding an unknown node ⇒ restoreReconcile throws
    // SchemaIncompatibleError AFTER the FOR UPDATE auth/epoch checks — exactly
    // where the old code had already inserted the safety row.
    const bad = new Y.Doc()
    const frag = bad.get(COLLAB_FIELD, Y.XmlFragment)
    bad.transact(() => {
      frag.insert(0, [new Y.XmlElement('frobnicate')])
    })
    const badState = Y.encodeStateAsUpdate(bad)

    vi.spyOn(docVersionRepo, 'getStateById').mockResolvedValue({
      version: {
        id: 5,
        docId: 'd_1',
        documentName,
        kind: 2,
        name: '',
        compressed: 1,
        sizeBytes: badState.length,
        schemaVersion: SCHEMA_VERSION,
        createdAt: new Date(0),
        createdBy: 'u_1',
      },
      state: badState,
    })
    const createSpy = vi.spyOn(docVersionRepo, 'createTx')
    mockTx()

    const result = await restoreVersion({
      uid: 'u_1',
      docId: 'd_1',
      documentName,
      versionId: 5,
      authorizedEpoch: 7,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('version_schema_incompatible')
    // The orphan safety row is never inserted ⇒ nothing to leak on rollback.
    expect(createSpy).not.toHaveBeenCalled()
    // And the live document is never touched on the failure path.
    expect(applyRestoreToLiveDoc).not.toHaveBeenCalled()

    createSpy.mockRestore()
    vi.mocked(docVersionRepo.getStateById).mockRestore()
  })

  it('inserts exactly one safety row and persists on a successful restore', async () => {
    const targetState = stateFromPM({ type: 'doc', content: [para('A')] })
    vi.spyOn(docVersionRepo, 'getStateById').mockResolvedValue({
      version: {
        id: 5,
        docId: 'd_1',
        documentName,
        kind: 2,
        name: '',
        compressed: 1,
        sizeBytes: targetState.length,
        schemaVersion: SCHEMA_VERSION,
        createdAt: new Date(0),
        createdBy: 'u_1',
      },
      state: targetState,
    })
    const createSpy = vi.spyOn(docVersionRepo, 'createTx').mockResolvedValue(99)
    const captured: string[] = []
    mockTx(captured)

    const result = await restoreVersion({
      uid: 'u_1',
      docId: 'd_1',
      documentName,
      versionId: 5,
      authorizedEpoch: 7,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      // Wire contract: the restore returns the source version + the auto-created
      // safety snapshot, under the canonical keys.
      expect(result.restoredFrom).toBe(5)
      expect(result.newDocVersionSeq).toBe(99)
    }
    expect(createSpy).toHaveBeenCalledTimes(1)
    // The safety/restore-marker row records the source version it was restored
    // from, so the list can render "restored from #5".
    expect(createSpy.mock.calls[0]![1]).toMatchObject({
      kind: KIND_RESTORE_MARKER,
      restoredFrom: 5,
    })
    // The restore is NOT written to yjs_document inside this transaction; the
    // authoritative content write happens on the live document afterwards.
    expect(captured.some((q) => q.includes('INSERT INTO yjs_document'))).toBe(false)
    expect(captured.some((q) => q.includes('UPDATE doc_meta'))).toBe(true)
    // The live-document apply (broadcast + persist) ran with the target state.
    expect(applyRestoreToLiveDoc).toHaveBeenCalledTimes(1)
    expect(vi.mocked(applyRestoreToLiveDoc).mock.calls[0]![0]).toBe(documentName)
    expect(vi.mocked(applyRestoreToLiveDoc).mock.calls[0]![1]).toBe('u_1')

    createSpy.mockRestore()
    vi.mocked(docVersionRepo.getStateById).mockRestore()
  })
})

// ── A4: kind-filtered streams + per-kind counts ───────────────────────────────
// The list path is mocked at the SQL boundary (`query`), so these assert the
// exact kind predicate the repo emits — that IS the filter mechanism. A `manual`
// query can never surface auto rows because the DB is told `kind <> AUTO`.
describe('docVersionRepo.listByDoc — kind filter (A4 streams)', () => {
  /** Capture every (sql, args) the repo issues; return empty rows. */
  function captureQuery() {
    const calls: { sql: string; args: unknown[] }[] = []
    vi.mocked(query).mockImplementation((async (sql: string, args?: unknown[]) => {
      calls.push({ sql, args: args ?? [] })
      return [] as never
    }) as never)
    return calls
  }

  it('kind=manual filters kind <> AUTO (named + restore, excludes auto)', async () => {
    const calls = captureQuery()
    await docVersionRepo.listByDoc('d_1', { kind: 'manual' })
    expect(calls[0]!.sql).toContain('kind <> ?')
    expect(calls[0]!.sql).not.toContain('kind = ?')
    expect(calls[0]!.args).toContain(KIND_AUTO)
  })

  it('kind=auto filters kind = AUTO (auto only)', async () => {
    const calls = captureQuery()
    await docVersionRepo.listByDoc('d_1', { kind: 'auto' })
    expect(calls[0]!.sql).toContain('kind = ?')
    expect(calls[0]!.sql).not.toContain('kind <> ?')
    expect(calls[0]!.args).toContain(KIND_AUTO)
  })

  it('kind=all applies no kind predicate (all kinds)', async () => {
    const calls = captureQuery()
    await docVersionRepo.listByDoc('d_1', { kind: 'all' })
    expect(calls[0]!.sql).not.toContain('kind <> ?')
    expect(calls[0]!.sql).not.toContain('kind = ?')
  })

  it('default (no kind, no includeAuto) behaves like manual — backward compat', async () => {
    const calls = captureQuery()
    await docVersionRepo.listByDoc('d_1', {})
    expect(calls[0]!.sql).toContain('kind <> ?')
    expect(calls[0]!.args).toContain(KIND_AUTO)
  })

  it('includeAuto=true (no kind) behaves like all', async () => {
    const calls = captureQuery()
    await docVersionRepo.listByDoc('d_1', { includeAuto: true })
    expect(calls[0]!.sql).not.toContain('kind <> ?')
    expect(calls[0]!.sql).not.toContain('kind = ?')
  })

  it('includeAuto=false (no kind) behaves like manual', async () => {
    const calls = captureQuery()
    await docVersionRepo.listByDoc('d_1', { includeAuto: false })
    expect(calls[0]!.sql).toContain('kind <> ?')
  })

  it('explicit kind overrides includeAuto (kind=auto wins over includeAuto=false)', async () => {
    const calls = captureQuery()
    await docVersionRepo.listByDoc('d_1', { kind: 'auto', includeAuto: false })
    expect(calls[0]!.sql).toContain('kind = ?')
    expect(calls[0]!.sql).not.toContain('kind <> ?')
  })

  it('cursor narrows each stream independently (id < cursor coexists with the kind predicate)', async () => {
    const calls = captureQuery()
    await docVersionRepo.listByDoc('d_1', { kind: 'manual', cursor: 50 })
    // Both the manual kind predicate and the cursor bound are present, so paging
    // the manual stream never spills into auto rows.
    expect(calls[0]!.sql).toContain('kind <> ?')
    expect(calls[0]!.sql).toContain('id < ?')
    expect(calls[0]!.args).toEqual(['d_1', KIND_AUTO, 50])
  })

  it('manual stream is not crowded out by auto rows — a full page of manual rows still pages', async () => {
    // The DB only ever returns manual/restore rows for a manual query (kind<>AUTO),
    // so even with thousands of auto rows in the table, limit applies to manual.
    const metaRow = (id: number, kind: number) => ({
      id,
      doc_id: 'd_1',
      document_name: 'octo:s1:f_default:d_1',
      kind,
      name: kind === KIND_NAMED ? `n${id}` : '',
      restored_from: null,
      compressed: 1,
      size_bytes: 1,
      schema_version: SCHEMA_VERSION,
      created_at: new Date(0),
      created_by: 'u_1',
    })
    // limit=2 → repo fetches 3; all named ⇒ hasMore=true, nextCursor = last id.
    vi.mocked(query).mockResolvedValue([
      metaRow(30, KIND_NAMED),
      metaRow(20, KIND_NAMED),
      metaRow(10, KIND_NAMED),
    ] as never)
    const { items, nextCursor } = await docVersionRepo.listByDoc('d_1', { kind: 'manual', limit: 2 })
    expect(items.map((i) => i.id)).toEqual([30, 20])
    expect(items.every((i) => i.kind !== KIND_AUTO)).toBe(true)
    expect(nextCursor).toBe(20)
  })
})

describe('docVersionRepo.countsByKind — per-kind full counts', () => {
  it('maps GROUP BY kind rows to {auto, manual, restore, total}', async () => {
    vi.mocked(query).mockResolvedValue([
      { kind: KIND_AUTO, c: 50 },
      { kind: KIND_NAMED, c: 3 },
      { kind: KIND_RESTORE_MARKER, c: 2 },
    ] as never)
    const counts = await docVersionRepo.countsByKind('d_1')
    expect(counts).toEqual({ auto: 50, manual: 3, restore: 2, total: 55 })
  })

  it('reports 0 for absent kinds', async () => {
    vi.mocked(query).mockResolvedValue([{ kind: KIND_NAMED, c: 1 }] as never)
    const counts = await docVersionRepo.countsByKind('d_1')
    expect(counts).toEqual({ auto: 0, manual: 1, restore: 0, total: 1 })
  })

  it('counts are independent of limit/cursor (full-doc tally regardless of paging)', async () => {
    // N auto + M named + K restore for the doc; counts reflect the whole doc.
    const N = 7, M = 3, K = 2
    vi.mocked(query).mockResolvedValue([
      { kind: KIND_AUTO, c: N },
      { kind: KIND_NAMED, c: M },
      { kind: KIND_RESTORE_MARKER, c: K },
    ] as never)
    const counts = await docVersionRepo.countsByKind('d_1')
    expect(counts).toEqual({ auto: N, manual: M, restore: K, total: N + M + K })
  })

  it('issues a single GROUP BY kind query scoped to the doc', async () => {
    const calls: { sql: string; args: unknown[] }[] = []
    vi.mocked(query).mockImplementation((async (sql: string, args?: unknown[]) => {
      calls.push({ sql, args: args ?? [] })
      return [] as never
    }) as never)
    await docVersionRepo.countsByKind('d_1')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.sql).toContain('GROUP BY kind')
    expect(calls[0]!.sql).toContain('doc_id = ?')
    expect(calls[0]!.args).toEqual(['d_1'])
  })
})

describe('listVersionsHandler — kind param + counts response', () => {
  it('returns 400 invalid_kind for an unrecognized kind value', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(adminGuard)
    const res = mockRes()
    await listVersionsHandler(req({ docId: 'd_1' }, { query: { kind: 'bogus' } }), res as never)
    expect(res.statusCode).toBe(400)
    expect((res.body as { error: string }).error).toBe('invalid_kind')
  })

  it('passes a valid kind through to listByDoc and embeds counts in the response', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(adminGuard)
    const listSpy = vi
      .spyOn(docVersionRepo, 'listByDoc')
      .mockResolvedValue({ items: [], nextCursor: null } as never)
    const countsSpy = vi
      .spyOn(docVersionRepo, 'countsByKind')
      .mockResolvedValue({ auto: 50, manual: 1, restore: 0, total: 51 })

    const res = mockRes()
    await listVersionsHandler(req({ docId: 'd_1' }, { query: { kind: 'auto' } }), res as never)

    expect(res.statusCode).toBe(200)
    expect(listSpy.mock.calls[0]![1]).toMatchObject({ kind: 'auto' })
    const body = res.body as { items: unknown[]; nextCursor: number | null; counts: unknown }
    expect(body.counts).toEqual({ auto: 50, manual: 1, restore: 0, total: 51 })
    expect(countsSpy).toHaveBeenCalledWith('d_1')

    listSpy.mockRestore()
    countsSpy.mockRestore()
  })

  it('forwards includeAuto as a compat alias only when kind is absent', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(adminGuard)
    const listSpy = vi
      .spyOn(docVersionRepo, 'listByDoc')
      .mockResolvedValue({ items: [], nextCursor: null } as never)
    vi.spyOn(docVersionRepo, 'countsByKind').mockResolvedValue({ auto: 0, manual: 0, restore: 0, total: 0 })

    const res = mockRes()
    await listVersionsHandler(req({ docId: 'd_1' }, { query: { includeAuto: 'true' } }), res as never)
    expect(listSpy.mock.calls[0]![1]).toMatchObject({ includeAuto: true, kind: undefined })

    listSpy.mockRestore()
    vi.mocked(docVersionRepo.countsByKind).mockRestore()
  })

  it('ignores includeAuto when an explicit kind is provided', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(adminGuard)
    const listSpy = vi
      .spyOn(docVersionRepo, 'listByDoc')
      .mockResolvedValue({ items: [], nextCursor: null } as never)
    vi.spyOn(docVersionRepo, 'countsByKind').mockResolvedValue({ auto: 0, manual: 0, restore: 0, total: 0 })

    const res = mockRes()
    await listVersionsHandler(
      req({ docId: 'd_1' }, { query: { kind: 'manual', includeAuto: 'true' } }),
      res as never,
    )
    // kind set, includeAuto NOT forwarded (parsed only when kind absent).
    expect(listSpy.mock.calls[0]![1]).toMatchObject({ kind: 'manual', includeAuto: undefined })

    listSpy.mockRestore()
    vi.mocked(docVersionRepo.countsByKind).mockRestore()
  })
})

// ── whiteboard version path: board list/create/preview/restore are ungated ────
// The old 409 board gate (§11.6 deferred board version UI) is removed. Boards now
// share the version routes with documents, but each request decodes/gates/restores
// against its OWN schema line (delta #1-#4): a board stamps/gates WB_SCHEMA_VERSION
// and decodes to an Excalidraw scene, never through the ProseMirror decoder.
describe('version routes — whiteboard (Excalidraw scene) path', () => {
  const boardGuard = {
    meta: {
      doc_id: 'b_1',
      document_name: 'octo:s1:f_default:wb:b_1',
      doc_type: 'board',
      permission_epoch: 7,
    },
    role: 'admin',
  } as never

  const rect = (id: string, index: string, x = 0) => ({
    id,
    type: 'rectangle',
    index,
    x,
    y: 0,
    width: 10,
    height: 10,
    version: 1,
    versionNonce: 123,
  })

  it('createVersionHandler snapshots a board and stamps WB_SCHEMA_VERSION', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(boardGuard)
    vi.spyOn(persistence, 'fetch').mockResolvedValue(stateFromBoard([rect('e1', 'a0')]))
    const createSpy = vi.spyOn(docVersionRepo, 'create').mockResolvedValue(42)

    const res = mockRes()
    await createVersionHandler(req({ docId: 'b_1' }, { body: { label: 'v1' } }), res as never)

    expect(res.statusCode).toBe(201)
    expect((res.body as { docVersionSeq: number }).docVersionSeq).toBe(42)
    // The board version row is stamped on the whiteboard schema line, NOT the PM
    // SCHEMA_VERSION — that is what lets the reader pick the right decoder later.
    expect(createSpy.mock.calls[0]![0].schemaVersion).toBe(WB_SCHEMA_VERSION)

    createSpy.mockRestore()
    vi.mocked(persistence.fetch).mockRestore()
  })

  it('listVersionsHandler returns board versions (list is never gated by kind)', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(boardGuard)
    const listSpy = vi.spyOn(docVersionRepo, 'listByDoc').mockResolvedValue({
      items: [
        { id: 2, docId: 'b_1', documentName: 'octo:s1:f_default:wb:b_1', kind: 2, name: 'v2', restoredFrom: null, compressed: 1, sizeBytes: 10, schemaVersion: WB_SCHEMA_VERSION, createdAt: new Date(0), createdBy: 'u_1' },
        { id: 1, docId: 'b_1', documentName: 'octo:s1:f_default:wb:b_1', kind: 1, name: '', restoredFrom: null, compressed: 1, sizeBytes: 8, schemaVersion: WB_SCHEMA_VERSION, createdAt: new Date(0), createdBy: 'u_1' },
      ],
      nextCursor: null,
    })
    const countsSpy = vi.spyOn(docVersionRepo, 'countsByKind').mockResolvedValue({ auto: 1, manual: 1, restore: 0, total: 2 })

    const res = mockRes()
    await listVersionsHandler(req({ docId: 'b_1' }, { query: { kind: 'all' } }), res as never)

    expect(res.statusCode).toBe(200)
    const body = res.body as { items: Array<{ docVersionSeq: number; schemaVersion: number }> }
    expect(body.items.map((i) => i.docVersionSeq)).toEqual([2, 1])
    expect(body.items.every((i) => i.schemaVersion === WB_SCHEMA_VERSION)).toBe(true)

    listSpy.mockRestore()
    countsSpy.mockRestore()
  })

  it('getVersionStateHandler returns an Excalidraw scene for a board (elements in index order)', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(boardGuard)
    // Insert out of index order to prove the decode sorts by fractional index.
    const state = stateFromBoard(
      [rect('e2', 'a2', 20), rect('e1', 'a1', 10)],
      { f1: { attachId: 'att_1', mimeType: 'image/png', status: 'ready', createdAt: 1 } },
    )
    vi.spyOn(docVersionRepo, 'getStateById').mockResolvedValue({
      version: {
        id: 5,
        docId: 'b_1',
        documentName: 'octo:s1:f_default:wb:b_1',
        kind: 2,
        name: '',
        restoredFrom: null,
        compressed: 1,
        sizeBytes: 2,
        schemaVersion: WB_SCHEMA_VERSION,
        createdAt: new Date(0),
        createdBy: 'u_1',
      } as never,
      state,
    })

    const res = mockRes()
    await getVersionStateHandler(req({ docId: 'b_1', versionId: '5' }), res as never)

    expect(res.statusCode).toBe(200)
    const body = res.body as {
      kind: string
      scene: { elements: Array<{ id: string }>; files: Record<string, unknown> }
      schemaVersion: number
      docVersionSeq: number
    }
    expect(body.kind).toBe('board')
    expect(body.scene.elements.map((e) => e.id)).toEqual(['e1', 'e2'])
    expect(body.scene.files.f1).toMatchObject({ attachId: 'att_1', status: 'ready' })
    expect(body.schemaVersion).toBe(WB_SCHEMA_VERSION)
    expect(body.docVersionSeq).toBe(5)

    vi.mocked(docVersionRepo.getStateById).mockRestore()
  })

  it('getVersionStateHandler 409s a board snapshot from a NEWER whiteboard schema', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(boardGuard)
    const getStateSpy = vi.spyOn(docVersionRepo, 'getStateById').mockResolvedValue({
      version: {
        id: 5,
        docId: 'b_1',
        documentName: 'octo:s1:f_default:wb:b_1',
        kind: 2,
        name: '',
        restoredFrom: null,
        compressed: 1,
        sizeBytes: 2,
        // A board schema NEWER than this server's WB_SCHEMA_VERSION must be
        // rejected — even though it is far below the PM SCHEMA_VERSION (delta #3).
        schemaVersion: WB_SCHEMA_VERSION + 1,
        createdAt: new Date(0),
        createdBy: 'u_1',
      } as never,
      state: stateFromBoard([rect('e1', 'a1')]),
    })

    const res = mockRes()
    await getVersionStateHandler(req({ docId: 'b_1', versionId: '5' }), res as never)

    expect(res.statusCode).toBe(409)
    expect((res.body as { error: string }).error).toBe('version_schema_newer')

    getStateSpy.mockRestore()
  })

  it('restoreVersionHandler restores a board via the Excalidraw-scene live apply', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(boardGuard)
    vi.spyOn(docVersionRepo, 'getStateById').mockResolvedValue({
      version: {
        id: 5,
        docId: 'b_1',
        documentName: 'octo:s1:f_default:wb:b_1',
        kind: 2,
        name: '',
        restoredFrom: null,
        compressed: 1,
        sizeBytes: 2,
        schemaVersion: WB_SCHEMA_VERSION,
        createdAt: new Date(0),
        createdBy: 'u_1',
      } as never,
      state: stateFromBoard([rect('e1', 'a1')]),
    })
    const createSpy = vi.spyOn(docVersionRepo, 'createTx').mockResolvedValue(99)
    vi.mocked(transaction).mockImplementation(async (fn: never) => {
      const tx = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes('FROM yjs_document')) return []
          if (sql.includes('FROM doc_meta')) return [{ owner_id: 'u_1', permission_epoch: 7, status: 1 }]
          if (sql.includes('LAST_INSERT_ID')) return [{ id: 99 }]
          return []
        }),
      }
      return (fn as unknown as (t: typeof tx) => Promise<unknown>)(tx)
    })

    const res = mockRes()
    await restoreVersionHandler(req({ docId: 'b_1', versionId: '5' }), res as never)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ restoredFrom: 5, newDocVersionSeq: 99 })
    // Board restore takes the Excalidraw-scene apply, NOT the ProseMirror one, and
    // stamps the safety snapshot on the whiteboard schema line.
    expect(applyBoardRestoreToLiveDoc).toHaveBeenCalledTimes(1)
    expect(applyRestoreToLiveDoc).not.toHaveBeenCalled()
    expect(createSpy.mock.calls[0]![1].schemaVersion).toBe(WB_SCHEMA_VERSION)

    createSpy.mockRestore()
    vi.mocked(docVersionRepo.getStateById).mockRestore()
  })

  it('a document is unaffected: create still stamps the PM SCHEMA_VERSION', async () => {
    // Regression guard: the kind branch must not change the document path.
    vi.mocked(requireDocRole).mockResolvedValue({
      meta: { doc_id: 'd_1', document_name: 'octo:s1:f_default:d_1', doc_type: 'doc', permission_epoch: 7 },
      role: 'admin',
    } as never)
    vi.spyOn(persistence, 'fetch').mockResolvedValue(null)
    const createSpy = vi.spyOn(docVersionRepo, 'create').mockResolvedValue(7)

    const res = mockRes()
    await createVersionHandler(req({ docId: 'd_1' }, { body: { label: 'ok' } }), res as never)

    expect(res.statusCode).toBe(201)
    expect(createSpy.mock.calls[0]![0].schemaVersion).toBe(SCHEMA_VERSION)

    createSpy.mockRestore()
    vi.mocked(persistence.fetch).mockRestore()
  })
})

// ── kind-aware helpers (delta #3/#4): schema line + decode selection ───────────
describe('version content kind (schema isolation)', () => {
  it('contentKindFromDocType maps board vs everything else', () => {
    expect(contentKindFromDocType('board')).toBe('board')
    expect(contentKindFromDocType('doc')).toBe('document')
    expect(contentKindFromDocType('sheet')).toBe('document')
  })

  it('currentSchemaVersionFor isolates the two schema lines', () => {
    expect(currentSchemaVersionFor('board')).toBe(WB_SCHEMA_VERSION)
    expect(currentSchemaVersionFor('document')).toBe(SCHEMA_VERSION)
  })

  it('gateSchemaForKind gates a board against WB_SCHEMA_VERSION, a document against SCHEMA_VERSION', () => {
    // A version at WB_SCHEMA_VERSION+1 is newer for a board but far older for a doc.
    expect(gateSchemaForKind(WB_SCHEMA_VERSION + 1, 'board').ok).toBe(false)
    expect(gateSchemaForKind(WB_SCHEMA_VERSION + 1, 'document').ok).toBe(true)
    expect(gateSchemaForKind(WB_SCHEMA_VERSION, 'board').ok).toBe(true)
    expect(gateSchemaForKind(SCHEMA_VERSION + 1, 'document').ok).toBe(false)
  })
})

// ── board scene decode + reconcile (pure helpers, delta #2) ───────────────────
describe('board scene decode/reconcile', () => {
  const rect = (id: string, index: string, x: number) => ({
    id, type: 'rectangle', index, x, y: 0, width: 5, height: 5, version: 1, versionNonce: 1,
  })

  it('decodeBoardSnapshot reads elements (index-ordered) and files', () => {
    const state = stateFromBoard(
      [rect('b', 'a2', 2), rect('a', 'a1', 1)],
      { f1: { attachId: 'x', mimeType: 'image/png', status: 'ready', createdAt: 0 } },
    )
    const scene = decodeBoardSnapshot(state)
    expect(scene.elements.map((e) => e.id)).toEqual(['a', 'b'])
    expect(scene.elements[0]).toMatchObject({ type: 'rectangle', x: 1 })
    expect(scene.files.f1).toMatchObject({ attachId: 'x' })
  })

  it('restoreReconcileBoard makes the live board equal the target scene (union-safe)', () => {
    // Live has e1(old) + e2; target has e1(new) + e3. Expect live -> {e1(new), e3}.
    const live = stateFromBoard([rect('e1', 'a1', 1), rect('e2', 'a2', 2)])
    const target = stateFromBoard([{ ...rect('e1', 'a1', 99) }, rect('e3', 'a3', 3)])

    const out = restoreReconcileBoard(live, target)
    const scene = decodeBoardSnapshot(out)
    expect(scene.elements.map((e) => e.id).sort()).toEqual(['e1', 'e3'])
    // e1 converged to the target's x; e2 was deleted; e3 was added.
    const e1 = scene.elements.find((e) => e.id === 'e1')!
    expect(e1.x).toBe(99)
    expect(scene.elements.find((e) => e.id === 'e2')).toBeUndefined()
  })

  it('restoreReconcileBoard also reconciles the files map', () => {
    const live = stateFromBoard([], { fOld: { attachId: 'old', mimeType: 'image/png', status: 'ready', createdAt: 0 } })
    const target = stateFromBoard([], { fNew: { attachId: 'new', mimeType: 'image/png', status: 'ready', createdAt: 0 } })
    const scene = decodeBoardSnapshot(restoreReconcileBoard(live, target))
    expect(Object.keys(scene.files)).toEqual(['fNew'])
  })

  it('restoreReconcileBoard on two empty scenes is a no-op-shaped empty board', () => {
    const scene = decodeBoardSnapshot(restoreReconcileBoard(stateFromBoard([]), stateFromBoard([])))
    expect(scene.elements).toEqual([])
    expect(scene.files).toEqual({})
  })
})
