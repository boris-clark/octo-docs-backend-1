/**
 * Version-restore core (§4 feature #4). Pure, DB-free helpers so the union-safe
 * restore mechanics and the schema forward-compat gate are unit-testable without
 * live infrastructure.
 *
 * Restore is a FORWARD, non-destructive operation on the live authoritative
 * state — never a CRDT rewind, and never a detached-doc union-merge (which would
 * trigger the computeFinalState union reback documented in persistence.ts). We
 * hydrate a Y.Doc from the CURRENT live state and reconcile the target version's
 * content INTO its fragment in-place, so the deletions become causal tombstones
 * on the live struct store. diffUpdate(live, sv(reconciled)) is then empty
 * (reconciled ⊇ live) and store() takes the direct-write bypass — no union.
 */
import * as Y from 'yjs'
import { prosemirrorToYXmlFragment, yDocToProsemirrorJSON } from 'y-prosemirror'
import { Node as PMNode } from 'prosemirror-model'
import { buildSchema, COLLAB_FIELD, SCHEMA_VERSION } from '../schema/index.js'
import { SHEET_YMAP_FIELD, SHEET_DIMS_FIELD, validateSheetCells, validateSheetCell, validateSheetDims, validateSheetDim } from '../agent/sheetConversion.js'
import { WB_SCHEMA_VERSION } from '../whiteboard/schema/index.js'
import { getElementsMap, getFilesMap, readEntry, readElements, type YElements } from '../whiteboard/ydoc.js'
export { SheetSnapshotInvalidError } from '../agent/sheetConversion.js'

const schema = buildSchema()

/**
 * Version-content discriminator (§11.5 schema isolation). A doc_version row's
 * blob is a ProseMirror/spreadsheet Y.Doc for a `document`, or an Excalidraw
 * `elements`/`files` Y.Doc for a `board`. The two schema lines are strictly
 * isolated: `document` gates on the ProseMirror SCHEMA_VERSION, `board` on the
 * whiteboard WB_SCHEMA_VERSION (which is intentionally a SEPARATE, smaller
 * number — see whiteboard/schema/constants.ts §6). The kind is derived from the
 * doc's immutable `doc_meta.doc_type`, so every decode/gate/restore path selects
 * the correct decoder and schema line for the row it is handling.
 */
export type VersionContentKind = 'document' | 'board'

/** doc_type value the front-end stamps on whiteboards (see routes/docs.ts). */
export const WHITEBOARD_DOC_TYPE = 'board'

/** Map a doc's `doc_meta.doc_type` to its version-content kind. */
export function contentKindFromDocType(docType: string): VersionContentKind {
  return docType === WHITEBOARD_DOC_TYPE ? 'board' : 'document'
}

/**
 * The current server schema version for a content kind — the value a snapshot's
 * `schema_version` is stamped with and gated against. Board and document lines
 * are isolated: never gate a board blob on the ProseMirror SCHEMA_VERSION or a
 * document blob on WB_SCHEMA_VERSION.
 */
export function currentSchemaVersionFor(kind: VersionContentKind): number {
  return kind === 'board' ? WB_SCHEMA_VERSION : SCHEMA_VERSION
}

// SHEET_YMAP_FIELD is the single shared constant (defined in agent/sheetConversion.ts,
// the cross-repo contract anchor). A text document never creates this map, so all
// sheet-aware helpers below are strict no-ops for docs.
export { SHEET_YMAP_FIELD, SHEET_DIMS_FIELD }

/**
 * Read the spreadsheet cells out of a snapshot's binary state. Returns a plain
 * `{ cellKey: cell }` object (empty for a text document — it has no 'sheet' map),
 * suitable for JSON preview.
 *
 * Fail-closed: every cell is validated against the `{v,f,s}` contract before it
 * leaves this function. A snapshot containing a value that violates the contract
 * (unexpected keys, wrong types, non-cell entries, hostile keys) throws
 * SheetSnapshotInvalidError instead of serializing arbitrary writer-controlled
 * data into the HTTP preview response — the sheet-side mirror of the ProseMirror
 * path's SchemaIncompatibleError. The route maps it to 409.
 */
export function decodeSheetSnapshot(targetState: Uint8Array): Record<string, unknown> {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, targetState)
  const sheet = doc.getMap(SHEET_YMAP_FIELD)
  const raw: Record<string, unknown> = {}
  for (const [key, val] of sheet.entries()) raw[key] = val
  // Validate + sanitize the whole map fail-closed (throws on any deviation).
  return validateSheetCells(raw)
}

/**
 * Read the spreadsheet column-width / row-height overrides out of a snapshot's
 * binary state. Returns a plain `{ c<idx>|r<idx>: number }` object (empty for a
 * text document — it has no 'sheetDims' map), suitable for JSON preview.
 *
 * Fail-closed like decodeSheetSnapshot: every dimension is validated (key shape
 * + positive finite value) before it leaves this function; a violation throws
 * SheetSnapshotInvalidError, which the route maps to 409. This is the second
 * synced grid field — the preview must surface it so the version panel can
 * render a historical sheet's layout, not just its cell contents.
 */
export function decodeSheetDimsSnapshot(targetState: Uint8Array): Record<string, number> {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, targetState)
  const dims = doc.getMap(SHEET_DIMS_FIELD)
  const raw: Record<string, unknown> = {}
  for (const [key, val] of dims.entries()) raw[key] = val
  return validateSheetDims(raw)
}

/**
 * Reconcile a snapshot's 'sheet' cell map INTO a live doc's 'sheet' map, in place.
 * MUST be called inside a Yjs transaction. Makes the live cells equal the target's:
 * live-only cells are deleted, target cells are set/overwritten. Returns true if a
 * sheet map was involved (either side non-empty), false for a pure text document —
 * in which case the doc's encoded state is left byte-identical (no map is touched).
 *
 * Fail-closed: every target cell is validated against the `{v,f,s}` contract
 * BEFORE any mutation of the live map, so a malformed snapshot can neither be
 * rebroadcast to connected clients nor persisted. If validation throws, the
 * caller's transaction is abandoned and the live doc is left untouched.
 *
 * This is the sheet counterpart of reconcileFragment: version restore for docs
 * rebuilds the ProseMirror fragment; for sheets it must ALSO restore the cells
 * AND the column-width / row-height overrides (sheetDims), which both live in
 * their own Y.Maps, not in the COLLAB_FIELD fragment. Dropping dims would leave
 * a silent partial restore (cells roll back, layout keeps current values).
 */
export function reconcileSheetMap(liveDoc: Y.Doc, targetState: Uint8Array): boolean {
  const targetYDoc = new Y.Doc()
  Y.applyUpdate(targetYDoc, targetState)
  const targetSheet = targetYDoc.getMap(SHEET_YMAP_FIELD)
  const liveSheet = liveDoc.getMap(SHEET_YMAP_FIELD)
  const targetDims = targetYDoc.getMap(SHEET_DIMS_FIELD)
  const liveDims = liveDoc.getMap(SHEET_DIMS_FIELD)
  if (
    targetSheet.size === 0 && liveSheet.size === 0 &&
    targetDims.size === 0 && liveDims.size === 0
  ) {
    return false // pure text doc — untouched
  }
  // Validate the ENTIRE target of BOTH maps first (fail-closed) so a bad cell or
  // dimension aborts before we mutate anything — no partial, half-restored state.
  const validatedCells: Record<string, import('../agent/sheetConversion.js').SheetCell> = {}
  for (const [key, val] of targetSheet.entries()) validatedCells[key] = validateSheetCell(key, val)
  const validatedDims: Record<string, number> = {}
  for (const [key, val] of targetDims.entries()) validatedDims[key] = validateSheetDim(key, val)
  // Cells: make live equal target (delete live-only, set/overwrite target).
  for (const key of [...liveSheet.keys()]) {
    if (!(key in validatedCells)) liveSheet.delete(key)
  }
  for (const [key, val] of Object.entries(validatedCells)) {
    liveSheet.set(key, val)
  }
  // Dims: same reconcile so a restored sheet's layout matches the target too.
  for (const key of [...liveDims.keys()]) {
    if (!(key in validatedDims)) liveDims.delete(key)
  }
  for (const [key, val] of Object.entries(validatedDims)) {
    liveDims.set(key, val)
  }
  return true
}

/** Transaction origin tag for the in-place restore write (diagnostics). */
export const RESTORE_ORIGIN = 'version-restore'

/**
 * Raised when a target version cannot be loaded under the current schema (an
 * older snapshot referencing a node/mark the current schema no longer defines).
 * The route maps this to 409 `version_schema_incompatible`.
 */
export class SchemaIncompatibleError extends Error {
  readonly code = 'version_schema_incompatible'
  constructor(cause?: unknown) {
    super('version_schema_incompatible')
    this.name = 'SchemaIncompatibleError'
    if (cause !== undefined) this.cause = cause
  }
}

export type SchemaGateResult = { ok: true } | { ok: false; status: number; code: string }

/**
 * Forward-compat gate (the "newer" half — pure / synchronous): a snapshot taken
 * under a NEWER schema than this server runs cannot be safely loaded =>
 * 409 `version_schema_newer`. The OLDER-but-unloadable case is detected at load
 * time (SchemaIncompatibleError) since it depends on the actual content.
 */
export function gateSchema(
  targetSchemaVersion: number,
  currentSchemaVersion: number = SCHEMA_VERSION,
): SchemaGateResult {
  if (targetSchemaVersion > currentSchemaVersion) {
    return { ok: false, status: 409, code: 'version_schema_newer' }
  }
  return { ok: true }
}

/**
 * Kind-aware forward-compat gate (delta #3): gate a snapshot's `schema_version`
 * against the CURRENT server version for its own content line — WB_SCHEMA_VERSION
 * for a board, SCHEMA_VERSION for a document/sheet. Because the two lines are
 * isolated and numbered independently, a board blob MUST NOT be gated against
 * the (much larger) ProseMirror SCHEMA_VERSION: doing so would wave through a
 * genuinely-newer board schema (its version is below 15) and later mis-decode it.
 * This is the single entry point routes/service use so board and document
 * versions each validate against the right schema.
 */
export function gateSchemaForKind(
  targetSchemaVersion: number,
  kind: VersionContentKind,
): SchemaGateResult {
  return gateSchema(targetSchemaVersion, currentSchemaVersionFor(kind))
}

/**
 * Decode a target snapshot's binary state into a schema-validated ProseMirror
 * document under the CURRENT schema.
 *
 * Throws SchemaIncompatibleError if the target content does not load under the
 * current schema. A snapshot taken before any edit decodes to a contentless
 * `doc` (violates the top node's `block+` expression) — that is NOT an
 * incompatibility, so it is substituted with the canonical empty document.
 */
export function decodeTargetSnapshot(targetState: Uint8Array): PMNode {
  try {
    const targetYDoc = new Y.Doc()
    Y.applyUpdate(targetYDoc, targetState)
    const targetJSON = yDocToProsemirrorJSON(targetYDoc, COLLAB_FIELD)
    const decoded = PMNode.fromJSON(schema, targetJSON as Parameters<typeof PMNode.fromJSON>[1])
    if (decoded.childCount === 0) {
      // A brand-new doc snapshotted before any edit stores an empty Y.Doc, which
      // decodes to a contentless `doc` node. That violates the top node's
      // `block+` content expression, but it is NOT a schema incompatibility —
      // substitute the canonical empty document instead of throwing. createAndFill
      // supplies the required content (e.g. a single empty paragraph) so the
      // restore yields a valid empty doc rather than a spurious 409.
      const empty = schema.topNodeType.createAndFill()
      if (!empty) throw new Error('schema defines no canonical empty document')
      return empty
    }
    // check() surfaces content-expression violations that fromJSON alone misses
    // — genuine incompatibility from a newer/incompatible schema must still
    // throw (only the empty-content case above is reclassified as valid).
    decoded.check()
    return decoded
  } catch (err) {
    throw new SchemaIncompatibleError(err)
  }
}

/**
 * Reconcile a decoded target document INTO a live Yjs XmlFragment, in place.
 * MUST be called inside a Yjs transaction (the caller owns the transaction so
 * the deletions land as causal tombstones on the live struct store). This is
 * the single shared reconcile primitive used by both the pure/DB-side encode
 * (restoreReconcile) and the live-document apply (liveRestore.ts).
 */
export function reconcileFragment(targetPMDoc: PMNode, liveFragment: Y.XmlFragment): void {
  prosemirrorToYXmlFragment(targetPMDoc, liveFragment)
}

/**
 * Reconcile the target version's content into a doc hydrated from the current
 * live state, returning the full encoded state to persist.
 *
 * `liveState` MUST be the current authoritative state (not a blank doc) so the
 * result is a forward continuation: the in-place reconcile records deletions as
 * tombstones relative to live, keeping the write on the union-safe direction.
 *
 * Throws SchemaIncompatibleError if the target content does not load under the
 * current schema.
 */
export function restoreReconcile(liveState: Uint8Array | null, targetState: Uint8Array): Uint8Array {
  const targetPMDoc = decodeTargetSnapshot(targetState)

  // Hydrate from the live state so the reconcile is a forward edit on the
  // authoritative instance, not a rebuild of a blank doc.
  const liveDoc = new Y.Doc()
  if (liveState) Y.applyUpdate(liveDoc, liveState)
  const liveFragment = liveDoc.get(COLLAB_FIELD, Y.XmlFragment)

  // In-place structural diff/reconcile (matches prefix/suffix, deletes+inserts
  // only the differing middle). Wrapped in a single transact on the live doc so
  // the deletions land as causal tombstones — DO NOT build a separate doc and
  // union it (that path triggers the union reback).
  liveDoc.transact(() => {
    reconcileFragment(targetPMDoc, liveFragment)
    // Sheets store their cells in the 'sheet' map, not the fragment — restore them
    // too so the validated (size-checked) state matches what the live apply writes.
    // No-op for a pure text document (neither side has a 'sheet' map).
    reconcileSheetMap(liveDoc, targetState)
  }, RESTORE_ORIGIN)

  return Y.encodeStateAsUpdate(liveDoc)
}

// ── Whiteboard (Excalidraw scene) version path (delta #2) ─────────────────────
//
// The board counterpart of the ProseMirror path above. A board version's blob is
// a Y.Doc holding the two top-level whiteboard maps (ELEMENTS_FIELD / FILES_FIELD,
// see whiteboard/ydoc.ts), NOT a COLLAB_FIELD XmlFragment. These helpers decode a
// board snapshot for preview and reconcile it INTO the live board doc in place —
// exactly parallel to decodeTargetSnapshot / reconcileFragment / restoreReconcile,
// so a board version can be read and restored as an Excalidraw scene.

/** Excalidraw scene shape returned to the version panel for a board preview. */
export interface BoardScene {
  /** Elements in fractional-index order (Excalidraw render order). */
  elements: Array<Record<string, unknown>>
  /** File reference metadata keyed by fileId (§2 — no inline bytes). */
  files: Record<string, Record<string, unknown>>
}

/**
 * Field-value equality good enough for element/file maps (primitives + JSON),
 * NaN-tolerant so a passed-through NaN never forces a spurious rewrite. Mirrors
 * the whiteboard repair helper of the same name.
 */
function fieldEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a !== a && b !== b) return true // NaN/NaN (Object.is semantics)
  if (typeof a !== typeof b) return false
  if (a && b && typeof a === 'object') return JSON.stringify(a) === JSON.stringify(b)
  return false
}

/**
 * Decode a board snapshot's binary state into an Excalidraw scene for preview
 * (the board analogue of decodeTargetSnapshot). Reads the ELEMENTS_FIELD /
 * FILES_FIELD maps into plain JS; elements are returned sorted by fractional
 * `index` (then id) so the panel renders them in a stable, Excalidraw-faithful
 * z-order. Pure: no DB write, no live connection.
 */
export function decodeBoardSnapshot(targetState: Uint8Array): BoardScene {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, targetState)
  const elements: Array<Record<string, unknown>> = []
  for (const [, v] of getElementsMap(doc).entries()) elements.push(readEntry(v))
  elements.sort((a, b) => {
    const ai = typeof a.index === 'string' ? a.index : ''
    const bi = typeof b.index === 'string' ? b.index : ''
    if (ai !== bi) return ai < bi ? -1 : 1
    const aid = typeof a.id === 'string' ? a.id : ''
    const bid = typeof b.id === 'string' ? b.id : ''
    return aid < bid ? -1 : aid > bid ? 1 : 0
  })
  const files: Record<string, Record<string, unknown>> = {}
  for (const [fid, v] of getFilesMap(doc).entries()) files[fid] = readEntry(v)
  return { elements, files }
}

/**
 * Reconcile a target board map (elements or files) INTO a live per-entry Y.Map,
 * in place, making live equal to target: entries absent from target are deleted,
 * present entries are written field-level (only changed fields set, stale fields
 * removed) so concurrent edits to unrelated entries survive and the deletions
 * land as causal tombstones on the live struct store. MUST be called inside a
 * Yjs transaction (the caller owns it).
 */
function reconcileEntryMap(live: YElements, target: Map<string, Record<string, unknown>>): void {
  for (const key of [...live.keys()]) {
    if (!target.has(key)) live.delete(key)
  }
  for (const [key, obj] of target) {
    let yEntry = live.get(key)
    if (!(yEntry instanceof Y.Map)) {
      yEntry = new Y.Map()
      live.set(key, yEntry as Y.Map<unknown>)
    }
    const cur = readEntry(yEntry)
    // Sorted field iteration keeps struct-creation order stable across nodes.
    for (const f of Object.keys(obj).sort()) {
      if (!fieldEquals(cur[f], obj[f])) yEntry.set(f, obj[f])
    }
    for (const f of Object.keys(cur).sort()) {
      if (!(f in obj)) yEntry.delete(f)
    }
  }
}

/**
 * Reconcile a board snapshot's elements + files INTO a live board doc, in place
 * (the board counterpart of reconcileFragment + reconcileSheetMap). Makes the
 * live board equal the target scene. MUST be called inside a Yjs transaction so
 * the deletions become tombstones on the live doc (union-safe forward restore).
 * Returns true if a board map was involved (either side non-empty), false when
 * both sides are empty (nothing touched) — the board analogue of
 * reconcileSheetMap's text-doc no-op.
 */
export function reconcileBoardMaps(liveDoc: Y.Doc, targetState: Uint8Array): boolean {
  const targetDoc = new Y.Doc()
  Y.applyUpdate(targetDoc, targetState)
  const targetElements = readElements(targetDoc)
  const targetFiles = new Map<string, Record<string, unknown>>()
  for (const [fid, v] of getFilesMap(targetDoc).entries()) targetFiles.set(fid, readEntry(v))

  const liveElements = getElementsMap(liveDoc)
  const liveFiles = getFilesMap(liveDoc)
  if (
    targetElements.size === 0 && liveElements.size === 0 &&
    targetFiles.size === 0 && liveFiles.size === 0
  ) {
    return false
  }
  reconcileEntryMap(liveElements, targetElements)
  reconcileEntryMap(liveFiles, targetFiles)
  return true
}

/**
 * Reconcile a target board version's scene into a doc hydrated from the current
 * live state, returning the full encoded state to persist (the board counterpart
 * of restoreReconcile). Like the ProseMirror path, `liveState` MUST be the
 * current authoritative state so the reconcile is a forward continuation and the
 * deletions land as tombstones relative to live — keeping the write union-safe.
 */
export function restoreReconcileBoard(liveState: Uint8Array | null, targetState: Uint8Array): Uint8Array {
  const liveDoc = new Y.Doc()
  if (liveState) Y.applyUpdate(liveDoc, liveState)
  liveDoc.transact(() => {
    reconcileBoardMaps(liveDoc, targetState)
  }, RESTORE_ORIGIN)
  return Y.encodeStateAsUpdate(liveDoc)
}
