/**
 * Version restore orchestration (§4 feature #4, design §5.6). Restore has two
 * halves: a DB-bound transaction (authorization recheck + safety snapshot) and
 * an authoritative content write onto the LIVE Hocuspocus document.
 *
 * N1 TOCTOU guard: the route's requireDocRole(admin) is only the first check.
 * Here we re-read the doc rows FOR UPDATE and re-check the caller's role +
 * permission_epoch INSIDE the lock, so a writer/reader who bypasses the
 * admin-only frontend and calls POST /restore directly is denied server-side —
 * the backend is the authority, the frontend gate is only UX.
 *
 * Lock order matches persistence.store (yjs_document first, then doc_meta) so
 * the two write paths cannot deadlock. Before the restore we record an auto
 * safety snapshot of the current live state in the same transaction, so the
 * restore is itself undoable (returned as newDocVersionSeq).
 *
 * The content write does NOT touch yjs_document directly. After the transaction
 * commits we apply the reconcile onto the live in-memory document via
 * openDirectConnection (see src/collab/liveRestore.ts): this broadcasts the
 * restore to connected clients in real time AND is the single authoritative
 * persisted write. A separate transient-doc write would diverge by clientId and
 * force the union fallback in persistence.store, duplicating the restored
 * content — so it is deliberately omitted.
 */
import { transaction, type Tx } from '../../db/pool.js'
import { yjsDocumentRepo } from '../../db/repos/yjsDocumentRepo.js'
import { docVersionRepo, KIND_RESTORE_MARKER } from '../../db/repos/docVersionRepo.js'
import { docMemberRepo } from '../../db/repos/docMemberRepo.js'
import {
  restoreReconcile,
  restoreReconcileBoard,
  gateSchemaForKind,
  currentSchemaVersionFor,
  SchemaIncompatibleError,
  SheetSnapshotInvalidError,
  type VersionContentKind,
} from '../../collab/versionRestore.js'
import { applyRestoreToLiveDoc, applyBoardRestoreToLiveDoc } from '../../collab/liveRestore.js'
import { config } from '../../config/env.js'
import { roleAtLeast } from '../../permission/role.js'
import * as Y from 'yjs'

export type RestoreResult =
  | { ok: true; restoredFrom: number; newDocVersionSeq: number }
  | { ok: false; status: number; error: string }

export interface RestoreInput {
  uid: string
  docId: string
  documentName: string
  versionId: number
  /** permission_epoch observed when the request was authorized (TOCTOU baseline). */
  authorizedEpoch: number
  /**
   * Content kind of the doc being restored (delta #4), derived from
   * `doc_meta.doc_type`. Selects the schema line to gate/stamp against and the
   * decode/reconcile/live-apply path — `board` restores an Excalidraw scene,
   * `document` restores a ProseMirror/spreadsheet Y.Doc. Defaults to `document`
   * so existing callers/tests are unaffected.
   */
  contentKind?: VersionContentKind
}

interface LockedMetaRow {
  owner_id: string
  permission_epoch: number
  status: number
}

/** Re-check the caller's role under the doc_meta lock (owner => admin). */
async function isAdminTx(tx: Tx, docId: string, uid: string, ownerId: string): Promise<boolean> {
  if (uid === ownerId) return true
  const role = await docMemberRepo.getRoleTx(tx, docId, uid)
  return role !== undefined && roleAtLeast(role, 'admin')
}

export async function restoreVersion(input: RestoreInput): Promise<RestoreResult> {
  const kind: VersionContentKind = input.contentKind ?? 'document'
  // Load the target version (immutable) up front so the schema "newer" gate can
  // fail fast without taking any lock. Cross-doc ids are hidden behind 404.
  const target = await docVersionRepo.getStateById(input.versionId)
  if (!target || target.version.docId !== input.docId) {
    return { ok: false, status: 404, error: 'not_found' }
  }
  // Kind-aware gate (delta #3): a board blob gates on WB_SCHEMA_VERSION, a
  // document/sheet blob on the ProseMirror SCHEMA_VERSION.
  const gate = gateSchemaForKind(target.version.schemaVersion, kind)
  if (!gate.ok) {
    return { ok: false, status: gate.status, error: gate.code }
  }

  const txResult = await transaction(async (tx) => {
    // 1. Lock the authoritative state row FIRST (same order as
    //    persistence.store: yjs_document -> doc_meta) and read current state.
    const currentState = await yjsDocumentRepo.selectForUpdateTx(tx, input.documentName)

    // 2. Lock the doc_meta row; re-read role inputs + epoch under the lock.
    const metaRows = await tx.query<LockedMetaRow>(
      'SELECT owner_id, permission_epoch, status FROM doc_meta WHERE doc_id = ? FOR UPDATE',
      [input.docId],
    )
    const meta = metaRows[0]
    if (!meta || Number(meta.status) === 0) return { ok: false as const, status: 404, error: 'not_found' }
    if (Number(meta.status) === 2) return { ok: false as const, status: 409, error: 'conflict' }

    // 3. Re-check role INSIDE the lock — server authority, not just frontend UX.
    if (!(await isAdminTx(tx, input.docId, input.uid, meta.owner_id))) {
      return { ok: false as const, status: 403, error: 'forbidden' }
    }

    // 4. Re-check permission_epoch: if it moved since authorization, abort.
    if (Number(meta.permission_epoch) !== input.authorizedEpoch) {
      return { ok: false as const, status: 409, error: 'epoch_changed' }
    }

    // 5. Validate the forward reconcile against the CURRENT state: this surfaces
    //    schema incompatibility (a target that cannot load) and enforces the
    //    size cap BEFORE we record the safety snapshot or touch the live doc.
    //    The encoded result is used only for validation here — the authoritative
    //    content write happens on the LIVE document after this transaction
    //    commits (see below), never as a second yjs_document write, which would
    //    diverge by clientId and force the union fallback in persistence.store.
    let validated: Uint8Array
    try {
      validated = kind === 'board'
        ? restoreReconcileBoard(currentState, target.state)
        : restoreReconcile(currentState, target.state)
    } catch (err) {
      if (err instanceof SchemaIncompatibleError) {
        return { ok: false as const, status: 409, error: 'version_schema_incompatible' }
      }
      if (err instanceof SheetSnapshotInvalidError) {
        // Target sheet snapshot violated the {v,f,s} contract — fail-closed
        // (no safety snapshot, no live write) so a malformed version can never
        // be replayed onto the live doc or rebroadcast to clients.
        return { ok: false as const, status: 409, error: 'sheet_snapshot_invalid' }
      }
      throw err
    }
    if (validated.length > config.maxDocBytes) {
      return { ok: false as const, status: 413, error: 'doc_too_large' }
    }

    // 6. Auto safety snapshot of the CURRENT live state (undo for the restore),
    //    recorded only after the reconcile + size check have passed. Stamp the
    //    schema line that matches this doc's kind (delta #3/#4) so the safety
    //    row itself decodes correctly on a later preview/restore.
    const safetyState = currentState ?? Y.encodeStateAsUpdate(new Y.Doc())
    const safetyVersionId = await docVersionRepo.createTx(tx, {
      docId: input.docId,
      documentName: input.documentName,
      kind: KIND_RESTORE_MARKER,
      name: 'Auto-safety before restore',
      restoredFrom: input.versionId,
      state: safetyState,
      schemaVersion: currentSchemaVersionFor(kind),
      createdBy: input.uid,
    })

    // 7. Touch doc_meta so the restore is reflected immediately; the live-doc
    //    store path (step 8) writes the authoritative yjs_document state and
    //    re-stamps updated_by once persisted.
    await tx.query('UPDATE doc_meta SET updated_at = NOW(3), updated_by = ? WHERE document_name = ?', [
      input.uid,
      input.documentName,
    ])

    return { ok: true as const, restoredFrom: input.versionId, newDocVersionSeq: safetyVersionId }
  })

  if (!txResult.ok) return txResult

  // 8. Apply the reconcile onto the LIVE Hocuspocus document and broadcast it to
  //    connected clients. This is the authoritative content write: it issues
  //    real Yjs deletes on the live struct store (so deletions converge to every
  //    tab and are NOT resurrected by a stale client's union) and durably
  //    persists via the awaited store flush on disconnect. extension-redis
  //    propagates the same update to other nodes that have the doc loaded. Board
  //    docs take the Excalidraw-scene apply, documents/sheets the ProseMirror one.
  if (kind === 'board') {
    await applyBoardRestoreToLiveDoc(input.documentName, input.uid, target.state)
  } else {
    await applyRestoreToLiveDoc(input.documentName, input.uid, target.state)
  }

  return { ok: true, restoredFrom: txResult.restoredFrom, newDocVersionSeq: txResult.newDocVersionSeq }
}
