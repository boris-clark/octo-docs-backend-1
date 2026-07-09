/**
 * Backend-autonomous auto-save version history (A4, design §5.2 / §5.5).
 *
 * Creates KIND_AUTO snapshots off the Hocuspocus store path, reusing the
 * existing doc_version table + KIND_AUTO discriminator + includeAuto list
 * filter (no schema migration). server.ts wires two thin hooks into this
 * module; all trigger / timer / throttle / dedup logic lives here.
 *
 * Trigger model (§5.2, A4-1 correction): afterStoreDocument only fires AFTER a
 * store, so a user who stops typing produces no further store — the idle point
 * cannot be observed by the hook alone. Hence:
 *   - idle timer:   each afterStoreDocument (re)arms a per-doc setTimeout(idleMs);
 *                   if no newer store arrived when it fires, take one auto frame
 *                   ("stopped typing -> clean restore point").
 *   - min-interval: if >= minIntervalMs since the last auto, take one immediately
 *                   in afterStoreDocument, so continuous high-frequency editing
 *                   still snapshots periodically instead of waiting for idle.
 *   - unload:       beforeUnloadDocument clears the timer and flushes a final
 *                   frame if there are edits since the last auto (don't lose the
 *                   last burst), then drops the per-doc state.
 *
 * Multi-writer dedup (§5.5 L1, A4-3): two DISTINCT Redis SET NX keys so idle is
 * never swallowed by the 60s min-interval window — min-interval acquires
 * `autosnap:mininterval:{doc}` (PX=minIntervalMs); idle acquires
 * `autosnap:idle:{doc}` (PX=idleMs) and does NOT consult the min-interval lock.
 *
 * The whole feature is gated behind config.autoSnapshot.enabled (default false,
 * gray release): when disabled every entry point is inert.
 *
 * Snapshot failures must NEVER break the live store path, so every public entry
 * point swallows and logs its own errors.
 */
import * as Y from 'yjs'
import { config } from '../config/env.js'
import { docVersionRepo } from '../db/repos/docVersionRepo.js'
import { acquireLock, rkey } from '../db/redis.js'
import { parseDocumentName } from '../permission/documentName.js'
import { SCHEMA_VERSION } from '../schema/index.js'
import { WB_SCHEMA_VERSION } from '../whiteboard/schema/index.js'
import type { AuthContext } from './authenticate.js'

/** Per-document in-memory trigger state (process-local). */
interface DocAutoState {
  /** monotonic-ish timestamp of the most recent store (Date.now()). */
  lastStoreAt: number
  /** timestamp of the most recent auto snapshot written by THIS node. */
  lastAutoAt: number
  /** the armed idle timer, or null if none is pending. */
  idleTimer: ReturnType<typeof setTimeout> | null
  /** uid of the last writer seen on the store path; 'system' sentinel otherwise. */
  lastWriter: string
  /**
   * The LIVE in-memory Y.Doc for this document, captured from the store hook so
   * a delayed idle frame snapshots the current scene (XIN-656). Read directly —
   * never via openDirectConnection, which would re-add a connection and is
   * unsafe to call from inside the unload hook.
   */
  liveDoc: Y.Doc | null
}

const SYSTEM_WRITER = 'system'

const docState = new Map<string, DocAutoState>()

function getState(documentName: string): DocAutoState {
  let s = docState.get(documentName)
  if (!s) {
    s = { lastStoreAt: 0, lastAutoAt: 0, idleTimer: null, lastWriter: SYSTEM_WRITER, liveDoc: null }
    docState.set(documentName, s)
  }
  return s
}

/**
 * doc_id is the 4th segment of a document key, or the board id (5th segment) of
 * a whiteboard key — both are created with their id as doc_meta.doc_id, so we
 * derive it without a DB hit. M2 (XIN-26 item 5): whiteboards keep the same auto
 * crash-recovery snapshots as documents, hence the whiteboard branch here.
 * Malformed keys yield null and are skipped. `schemaVersion` tracks the KIND's
 * schema line, strictly isolated (§11.5 / §6): whiteboard boards stamp
 * WB_SCHEMA_VERSION, rich-text docs stamp the ProseMirror SCHEMA_VERSION.
 */
function deriveSnapshotTarget(
  documentName: string,
): { docId: string; schemaVersion: number } | null {
  try {
    const parsed = parseDocumentName(documentName)
    return parsed.kind === 'document'
      ? { docId: parsed.doc, schemaVersion: SCHEMA_VERSION }
      : { docId: parsed.board, schemaVersion: WB_SCHEMA_VERSION }
  } catch {
    return null
  }
}

/**
 * Snapshot the CURRENT live authoritative state into a KIND_AUTO row (with
 * same-transaction pruning). Encodes the LIVE in-memory Y.Doc handed in by the
 * store/unload hook, mirroring createVersionHandler's live-state capture: a
 * board's drawn scene is snapshotted even before the debounced store flushes it
 * to the row (XIN-656), and a brand-new doc still records a valid (empty)
 * snapshot. Returns true if a row was written.
 */
async function writeAutoSnapshot(
  documentName: string,
  createdBy: string,
  liveDoc: Y.Doc,
): Promise<boolean> {
  const target = deriveSnapshotTarget(documentName)
  if (!target) return false
  const state = Y.encodeStateAsUpdate(liveDoc)
  await docVersionRepo.createAutoWithPrune({
    docId: target.docId,
    documentName,
    state,
    schemaVersion: target.schemaVersion,
    createdBy,
    retainCount: config.autoSnapshot.retainCount,
    retainDays: config.autoSnapshot.retainDays,
  })
  return true
}

/**
 * afterStoreDocument: record the store, run the min-interval fallback, and
 * (re)arm the idle timer. lastContext carries the last writer's uid (§5.2);
 * absent (e.g. server-internal write) => 'system'. `liveDoc` is the live
 * in-memory Y.Doc from the hook — retained so a later idle frame snapshots the
 * current scene, and passed straight to the snapshot write here (XIN-656).
 */
export async function handleAfterStore(
  documentName: string,
  lastContext: AuthContext | undefined,
  liveDoc: Y.Doc,
): Promise<void> {
  if (!config.autoSnapshot.enabled) return
  try {
    const now = Date.now()
    const s = getState(documentName)
    s.lastStoreAt = now
    s.liveDoc = liveDoc
    const writer = lastContext?.user?.id
    if (writer) s.lastWriter = writer

    // min-interval fallback: at most one auto per minIntervalMs window. The
    // Redis NX key dedups across nodes; the in-memory lastAutoAt short-circuits
    // the common case without a Redis round-trip.
    if (now - s.lastAutoAt >= config.autoSnapshot.minIntervalMs) {
      const key = rkey('autosnap', 'mininterval', documentName)
      if (await acquireLock(key, config.autoSnapshot.minIntervalMs)) {
        if (await writeAutoSnapshot(documentName, s.lastWriter, liveDoc)) s.lastAutoAt = Date.now()
      }
    }

    // (re)arm the per-doc idle timer. Capture the store timestamp so the timer
    // can tell, when it fires, whether a newer store has superseded it.
    if (s.idleTimer) clearTimeout(s.idleTimer)
    const armedAt = s.lastStoreAt
    s.idleTimer = setTimeout(() => {
      void fireIdle(documentName, armedAt)
    }, config.autoSnapshot.idleMs)
    // Don't keep the process alive solely for a pending idle snapshot.
    s.idleTimer.unref?.()
  } catch (err) {
    logFailure('afterStore', documentName, err)
  }
}

/**
 * Idle timer callback: the "stopped typing -> clean restore point" frame. Fires
 * only if no newer store arrived since the timer was armed (lastStoreAt
 * unchanged). Uses the short idle key so multiple nodes converge to one frame
 * for the same idle point, independent of the min-interval window.
 */
async function fireIdle(documentName: string, armedAt: number): Promise<void> {
  const s = docState.get(documentName)
  if (!s) return
  s.idleTimer = null
  // A newer store re-armed a later timer; this stale firing is a no-op.
  if (s.lastStoreAt !== armedAt) return
  if (!config.autoSnapshot.enabled) return
  // The live doc was captured on the store that armed this timer; without it we
  // cannot encode the scene (should not happen, since the timer is only armed
  // from handleAfterStore, which always sets it).
  if (!s.liveDoc) return
  try {
    const key = rkey('autosnap', 'idle', documentName)
    if (!(await acquireLock(key, config.autoSnapshot.idleMs))) return
    if (await writeAutoSnapshot(documentName, s.lastWriter, s.liveDoc)) s.lastAutoAt = Date.now()
  } catch (err) {
    logFailure('idle', documentName, err)
  }
}

/**
 * beforeUnloadDocument: clear the idle timer, flush a final frame if there are
 * edits since the last auto (avoid losing the last burst), then drop the
 * per-doc state. Dedups on the idle key so a multi-node unload race resolves to
 * a single frame. `liveDoc` is the live doc being unloaded — encoded directly
 * (never via openDirectConnection, which would re-add a connection mid-unload).
 */
export async function handleBeforeUnload(documentName: string, liveDoc: Y.Doc): Promise<void> {
  const s = docState.get(documentName)
  if (!s) return
  if (s.idleTimer) {
    clearTimeout(s.idleTimer)
    s.idleTimer = null
  }
  try {
    if (config.autoSnapshot.enabled && s.lastStoreAt > s.lastAutoAt) {
      const key = rkey('autosnap', 'idle', documentName)
      if (await acquireLock(key, config.autoSnapshot.idleMs)) {
        await writeAutoSnapshot(documentName, s.lastWriter, liveDoc)
      }
    }
  } catch (err) {
    logFailure('unload', documentName, err)
  } finally {
    docState.delete(documentName)
  }
}

function logFailure(where: string, documentName: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[octo-docs] auto-snapshot ${where} failed for ${documentName}:`, err)
}

/** Test-only: reset all per-document in-memory state. */
export function __resetAutoSnapshotState(): void {
  for (const s of docState.values()) {
    if (s.idleTimer) clearTimeout(s.idleTimer)
  }
  docState.clear()
}
