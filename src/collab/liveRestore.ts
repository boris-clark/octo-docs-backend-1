/**
 * Live-document side of version restore (§4 feature #4, design §7.3).
 *
 * The DB-bound half (safety snapshot, role/epoch recheck, doc_meta) runs in the
 * restoreVersion service. This module performs the SECOND, indispensable half:
 * applying the reconcile onto the LIVE Hocuspocus document so connected clients
 * see the restore in real time — and so the restore is the single authoritative
 * content write, never clobbered by a stale client's union.
 *
 * Why this is the only correct content-write path (the Bug B fix):
 *   - openDirectConnection returns the SAME in-memory Y.Doc the connected tabs
 *     are editing. reconcileFragment inside connection.transact issues REAL Yjs
 *     deletes/inserts on that doc's struct store, so deletions become causal
 *     tombstones every client converges to (Hocuspocus broadcasts the update +
 *     publishes it over extension-redis to other nodes).
 *   - Because the live doc itself carries the deletions forward, its next store
 *     is on the union-safe direction (incoming ⊇ existing in persistence.store),
 *     so the diffUpdate bypass — not the union fallback — runs and the deleted
 *     content is NOT resurrected.
 *   - A second, separately computed yjs_document write (a transient-doc encode)
 *     would carry a DIFFERENT clientId and therefore force the union fallback on
 *     the live doc's next store, doubling the restored content. So restore must
 *     NOT write yjs_document directly; this path is authoritative.
 *
 * disconnect() (unloadImmediately default) flushes onStoreDocument with debounce
 * 0 and is awaited, so the restored state is durably persisted before we return.
 */
import type { Document } from '@hocuspocus/server'
import { getCollabServer } from './server.js'
import { decodeTargetSnapshot, reconcileFragment, reconcileSheetMap, reconcileBoardMaps } from './versionRestore.js'
import { COLLAB_FIELD } from '../schema/index.js'

/**
 * Apply a target version's content onto the live document and broadcast it.
 *
 * @param documentName canonical persistence/connection key for the document
 * @param uid          acting user id (becomes doc_meta.updated_by on store)
 * @param targetState  the target snapshot's raw Yjs bytes
 *
 * Throws SchemaIncompatibleError if the target cannot load under the current
 * schema (the caller validates this before mutating any state).
 */
export async function applyRestoreToLiveDoc(
  documentName: string,
  uid: string,
  targetState: Uint8Array,
): Promise<void> {
  const targetPMDoc = decodeTargetSnapshot(targetState)
  const server = getCollabServer()

  // openDirectConnection attaches to the document's single live in-memory copy
  // (loading it from DB if no client is connected). It bypasses onAuthenticate,
  // so authorization MUST already have been enforced by the caller (the restore
  // service rechecks admin + permission_epoch under the row lock).
  const connection = await server.hocuspocus.openDirectConnection(documentName, { user: { id: uid } })
  try {
    await connection.transact((doc: Document) => {
      const fragment = doc.getXmlFragment(COLLAB_FIELD)
      reconcileFragment(targetPMDoc, fragment)
      // Spreadsheet cells live in the 'sheet' map, not the fragment — restore them
      // onto the same live doc so connected clients converge on the restored grid.
      // No-op for a text document (it has no 'sheet' map).
      reconcileSheetMap(doc, targetState)
    })
  } finally {
    // Flushes the final store (awaited) and releases the direct connection.
    await connection.disconnect()
  }
}

/**
 * Board (Excalidraw scene) counterpart of applyRestoreToLiveDoc (delta #2).
 *
 * Applies a board version's ELEMENTS_FIELD / FILES_FIELD scene onto the live
 * whiteboard document and broadcasts it, exactly like the ProseMirror path: the
 * reconcile issues real Yjs deletes/inserts on the SAME in-memory Y.Doc the
 * connected boards are editing (openDirectConnection), so deletions become
 * causal tombstones every client converges to and the live doc's next store stays
 * on the union-safe direction — no transient-doc write that would diverge by
 * clientId and force the union fallback. The server-authoritative repair observer
 * already attached to the live board (server.ts afterLoadDocument) normalizes the
 * reconciled elements under REPAIR_ORIGIN, so a restored scene lands canonical.
 *
 * openDirectConnection bypasses onAuthenticate, so the caller (restoreVersion)
 * MUST already have rechecked admin + permission_epoch under the row lock.
 */
export async function applyBoardRestoreToLiveDoc(
  documentName: string,
  uid: string,
  targetState: Uint8Array,
): Promise<void> {
  const server = getCollabServer()
  const connection = await server.hocuspocus.openDirectConnection(documentName, { user: { id: uid } })
  try {
    await connection.transact((doc: Document) => {
      reconcileBoardMaps(doc, targetState)
    })
  } finally {
    await connection.disconnect()
  }
}
