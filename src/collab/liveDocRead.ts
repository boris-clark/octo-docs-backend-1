/**
 * Read the CURRENT live authoritative state of a document (kind-agnostic).
 *
 * The version-snapshot paths — the named POST create-version handler and the
 * backend-autonomous auto-snapshot — must capture what the user is looking at
 * RIGHT NOW. For an actively-edited doc that state lives in the live in-memory
 * Hocuspocus Y.Doc: the store is debounced (server.ts debounce/maxDebounce), so
 * the latest edits may not have been flushed to the yjs_document row yet.
 *
 * Reading the persisted row directly (persistence.fetch) therefore snapshotted a
 * STALE payload. For whiteboards this was systematically empty: a board drawn
 * and then immediately versioned recorded a ~2-byte empty Yjs update because the
 * Excalidraw scene was still only in the live doc, never in the row the snapshot
 * read. The restore path already reaches the live doc via openDirectConnection
 * (see liveRestore.ts / liveDocWrite.ts) — this closes the same gap on the read
 * side so a snapshot captures the true current scene for every kind.
 *
 * openDirectConnection returns the SAME in-memory Y.Doc connected clients edit,
 * hydrating it from persistence when it is not yet loaded (a doc nobody is
 * editing therefore reads back exactly its persisted state, and a brand-new doc
 * with no edits reads back an empty Y.Doc). Read-only: it opens, encodes inside
 * a transact for a consistent view, and disconnects without mutating.
 */
import type { Document } from '@hocuspocus/server'
import * as Y from 'yjs'
import { getCollabServer } from './server.js'

export async function readLiveDocState(documentName: string): Promise<Uint8Array> {
  const server = getCollabServer()
  const connection = await server.hocuspocus.openDirectConnection(documentName, {
    user: { id: 'system' },
  })
  let state!: Uint8Array
  try {
    await connection.transact((doc: Document) => {
      state = Y.encodeStateAsUpdate(doc)
    })
  } finally {
    await connection.disconnect()
  }
  return state
}
