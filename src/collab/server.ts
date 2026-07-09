/**
 * Hocuspocus Server instance (§2.1 / §2.2 / §4.1 / §5.1).
 *
 * - extension-database wired to the §3.2 persistence adapter (fetch/store).
 * - extension-redis for multi-instance pub/sub broadcast + document lock (§5.1/§5.3).
 * - extension-logger for structured logs.
 * - onAuthenticate implements §4.1 (verify token, epoch compare, role, readOnly).
 * - beforeHandleMessage does the per-principal write recheck (§4.5 step 4).
 * - beforeHandleAwareness validates presence identity + fields (§8.3.1).
 */
import { Server } from '@hocuspocus/server'
import { Database } from '@hocuspocus/extension-database'
import { Redis } from '@hocuspocus/extension-redis'
import { Logger } from '@hocuspocus/extension-logger'
import { config } from '../config/env.js'
import { persistence } from './persistence.js'
import { authenticate, type AuthContext } from './authenticate.js'
import { connectionRegistry } from '../permission/connectionRegistry.js'
import { recheckCurrentRoleCached } from '../permission/recheck.js'
import { roleAtLeast } from '../permission/role.js'
import { handleAfterStore, handleBeforeUnload } from './autoSnapshot.js'
import { parseDocumentName } from '../permission/documentName.js'
import { attachWhiteboardRepair, coldRepairLiveDoc } from '../whiteboard/repair.js'

/**
 * Per-node epoch watermark (§4.5 step 4): beforeHandleMessage reads this local
 * in-memory value, NOT Redis/DB per write. Refreshed by the epoch invalidation
 * subscriber (wired in index.ts). Keyed by documentName.
 */
const epochWatermark = new Map<string, number>()

/**
 * Per-document disposer for the whiteboard repair observer (§4.1), keyed by
 * documentName. Set in afterLoadDocument for whiteboard keys, called in
 * beforeUnloadDocument so the observer is torn down with the document.
 */
const repairDisposers = new Map<string, () => void>()

export function setEpochWatermark(documentName: string, epoch: number): void {
  const cur = epochWatermark.get(documentName) ?? 0
  if (epoch > cur) epochWatermark.set(documentName, epoch)
}

const COLOR_RE = /^#[0-9a-fA-F]{6}$/

/**
 * Reasonable cap for a relayed avatar reference — enough for a small raster
 * data: thumbnail, short enough to keep awareness frames light. Longer values
 * are treated as unsafe and stripped.
 */
const AVATAR_MAX_LEN = 2048
/** Raster image data: URIs only — never svg/text, which can carry script. */
const DATA_IMAGE_RE = /^data:image\/(png|jpe?g|gif|webp);/i

/**
 * True if `v` is a safe avatar reference to RELAY to peers (§8.3.1 / P2).
 *
 * `avatar` is an optional, cosmetic field the v1 whiteboard binding publishes
 * alongside `{ id, name }`. It is echoed to every other peer and rendered there,
 * so an attacker-controlled value must never carry a script vector. Accept only:
 *   - http(s) URLs,
 *   - `data:image/{png,jpeg,gif,webp}` raster data URIs, and
 *   - scheme-less values that are unambiguously a relative / root-relative PATH
 *     (`/…`, `./…`, `../…`) — a path can't execute.
 * Everything else is rejected FAIL-CLOSED (XIN-604 P1): `javascript:` /
 * `vbscript:` / other schemes, a scheme smuggled behind percent-encoding
 * (`javascript%3Aalert(1)`), a protocol-relative URL (`//host/x` — a
 * cross-origin fetch vector, not a path), a value that only looks scheme-less
 * because its scheme lacks a leading letter (`1javascript:alert(1)`),
 * `data:text/*`, `data:image/svg+xml` (SVG can embed script), any value
 * containing markup or control characters, oversize strings, and non-strings.
 * Never throws.
 */
export function isSafeAvatar(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > AVATAR_MAX_LEN) return false
  // Positive allowlist of URL / data-URI-safe characters: this excludes control
  // chars, whitespace, quotes and angle brackets outright, so no raw markup or
  // smuggled control byte can slip through to a rendering peer.
  if (!/^[A-Za-z0-9\-._~:/?#@!$&*+,;=%()]+$/.test(v)) return false

  const schemeOf = (s: string): string | null => {
    const m = /^([a-z][a-z0-9+.-]*):/i.exec(s)
    return m ? (m[1] ?? '').toLowerCase() : null
  }
  const rawScheme = schemeOf(v)

  // Fail-closed against percent-encoded scheme smuggling: the allowlist permits
  // `%`, so `javascript%3Aalert(1)` carries NO bare colon and would otherwise
  // reach the scheme-less path. If percent-decoding introduces a scheme the raw
  // value did not have, a downstream sink that decodes before use would
  // resurrect it — reject. A malformed percent sequence (decode throws) is
  // itself unsafe → reject.
  if (v.includes('%')) {
    let decoded: string
    try {
      decoded = decodeURIComponent(v)
    } catch {
      return false
    }
    if (rawScheme === null && schemeOf(decoded) !== null) return false
  }

  if (rawScheme === null) {
    // Scheme-less: accept ONLY an unambiguous relative / root-relative path,
    // which carries neither an executable scheme nor a cross-origin host. A
    // leading `//` is a protocol-relative URL (cross-origin fetch vector), NOT a
    // path — reject it. Bare `host/x`-style values and everything else are
    // rejected fail-closed.
    if (v.startsWith('//')) return false
    return v.startsWith('/') || v.startsWith('./') || v.startsWith('../')
  }

  if (rawScheme === 'http' || rawScheme === 'https') return true
  if (rawScheme === 'data') return DATA_IMAGE_RE.test(v) // raster data URIs only
  return false // javascript:, vbscript:, file:, data:text/*, data:image/svg+xml, …
}

/**
 * §8.3.1 presence identity + field validation — source-scoped and NON-FATAL.
 *
 * `beforeHandleAwareness` hands us the awareness states decoded from THIS
 * source connection's inbound frame, keyed by Yjs clientId, as a MUTABLE map
 * (not the full broadcast set). So every entry here is something this very
 * connection is adding/updating; we validate only those and never touch other
 * peers' pre-existing presence — which is why legitimate multi-user cursors
 * flow through untouched.
 *
 * Two tiers, by design:
 *
 *  1. IMPERSONATION is the only security-relevant rejection: a frame whose
 *     `user.id` is not this connection's own uid is dropping the whole state
 *     (a client must never publish presence claiming to be someone else).
 *
 *  2. `color` and `name` are OPTIONAL, cosmetic fields. They must never cause
 *     the WHOLE presence state to be dropped — doing so silently kills the
 *     user's entire presence broadcast for that frame, and because Hocuspocus
 *     re-encodes the awareness update from only the surviving states, a dropped
 *     state is never applied to the document awareness and therefore never
 *     relayed (neither the local broadcast nor the Redis cross-node publish
 *     fires). The v1 whiteboard binding publishes `{ id, name, avatar }` with
 *     NO color at all, so the old whole-state drop on a missing/invalid color
 *     meant the receiving peer got ZERO awareness frames (presence A->B = 0)
 *     even though doc (type0) sync relayed fine. We instead SANITIZE the
 *     offending field in place (strip an invalid/unsafe color so no CSS
 *     injection value propagates; strip an oversized/non-string name) and let
 *     the rest of the presence broadcast — standard Hocuspocus relay behavior.
 *
 * We MUST NOT throw: a malformed or impostor awareness frame must never crash
 * the process or break other users' live collaboration (an earlier
 * implementation iterated the full broadcast set and threw, which crashed the
 * whole backend the moment a second user joined — a remotely triggerable DoS).
 */
export function validateAwarenessStates(
  states: Map<number, Record<string, unknown>>,
  ctx: AuthContext | undefined,
): void {
  if (!ctx) return // server-internal awareness (DirectConnection) carries no client ctx
  for (const [clientId, state] of states) {
    // Shape guard first: a malformed frame may carry a null / non-object state,
    // and reading `.user` off it would throw — violating the MUST-NOT-throw
    // contract below (a remotely triggerable crash). Skip it as non-presence.
    if (!state || typeof state !== 'object') continue
    const user = (state as {
      user?: { id?: unknown; name?: unknown; color?: unknown; avatar?: unknown }
    }).user
    if (!user) continue // non-presence awareness data — nothing to validate

    // (1) Identity binding: a connection may only publish presence under its OWN
    // uid. A frame claiming a different id is impersonation -> drop the whole
    // state. This is the single hard, security-relevant rejection.
    if (user.id !== ctx.user.id) {
      states.delete(clientId)
      continue
    }

    // (2) Cosmetic fields are sanitized, never fatal to the state. color is
    // optional; only strip it when it is PRESENT and not a safe #RRGGBB hex (no
    // CSS injection). A missing color is legitimate (whiteboard presence).
    if ('color' in user && !(typeof user.color === 'string' && COLOR_RE.test(user.color))) {
      delete (user as { color?: unknown }).color
    }
    // name is optional; strip it when present and not a string <= 64 chars.
    if ('name' in user && !(typeof user.name === 'string' && user.name.length <= 64)) {
      delete (user as { name?: unknown }).name
    }
    // avatar is optional (the v1 whiteboard binding publishes { id, name,
    // avatar }); strip it when present and not a safe image reference so no
    // script vector (javascript: URL, raw HTML, svg/text data URI) is relayed to
    // peers that render it (P2). Sanitize-in-place, never fatal — same tier as
    // color/name.
    if ('avatar' in user && !isSafeAvatar(user.avatar)) {
      delete (user as { avatar?: unknown }).avatar
    }
  }
}

export function createServer() {
  const server = new Server({
    name: `octo-docs-${config.hostname}`,
    port: config.hocuspocusPort,

    // connection limits & timeouts (§2.1)
    timeout: 30_000,
    maxDebounce: 10_000,
    debounce: 2_000,
    unloadImmediately: false, // single-writer affinity prereq (§5.2)

    extensions: [
      new Logger(),
      new Database({
        fetch: ({ documentName }) => persistence.fetch(documentName),
        // v4: pass lastContext through so store can write doc_meta.updated_by (P2-A).
        store: ({ documentName, state, lastContext }) =>
          persistence.store(documentName, state, lastContext as { user?: { id?: string } }),
      }),
      new Redis({
        host: config.redis.host,
        port: config.redis.port,
        prefix: config.redis.prefix, // multi-product key isolation (§2.1)
      }),
    ],

    // §4.1 onAuthenticate
    async onAuthenticate(data) {
      const ctx = await authenticate({
        token: data.token,
        documentName: data.documentName,
        connectionConfig: data.connectionConfig,
      })
      return ctx
    },

    // register the connection in the cross-node registry (§4.5 step 2)
    async connected(data) {
      const ctx = data.context as AuthContext
      setEpochWatermark(data.documentName, ctx.permission_epoch)
      await connectionRegistry.register({
        documentName: data.documentName,
        uid: ctx.user.id,
        node: config.hostname,
        connectionId: data.connection.socketId ?? data.socketId,
        role: ctx.role,
        permission_epoch: ctx.permission_epoch,
      })
    },

    async onDisconnect(data) {
      const ctx = data.context as AuthContext | undefined
      if (ctx) {
        await connectionRegistry.unregister(data.documentName, data.socketId)
      }
    },

    // §4.5 step 4: per-principal write recheck against the LOCAL epoch watermark.
    // Pure in-memory compare on the hot path; only stale connections hit recheck.
    async beforeHandleMessage(data) {
      const ctx = data.context as AuthContext | undefined
      if (!ctx) return // server-internal writes (DirectConnection) carry no client ctx

      const watermark = epochWatermark.get(data.documentName) ?? ctx.permission_epoch
      if (ctx.permission_epoch >= watermark) return // not stale => allow (no IO)

      // Stale: recheck this uid's CURRENT role (singleflight + short-TTL cache).
      const role = await recheckCurrentRoleCached(data.documentName, ctx.user.id)
      if (role === 'none' || !roleAtLeast(role, 'writer')) {
        // role actually dropped / revoked => reject this write & flip the conn.
        data.connection.readOnly = true
        throw new Error('Forbidden')
      }
      // Role not lowered (epoch advanced only due to someone else's change):
      // refresh the connection's epoch view in place and allow (P1-B).
      ctx.permission_epoch = watermark
    },

    // §8.3.1 awareness identity + field validation (MUST-level).
    // We use beforeHandleAwareness (not onAwarenessUpdate): its `states` map is
    // the source connection's OWN inbound frame (keyed by clientId) and is
    // mutable, so dropping an entry rejects just that part of the frame and the
    // broadcast reflects it — clean source-scoped, reject-the-frame semantics
    // with no way to crash the process. See validateAwarenessStates above.
    async beforeHandleAwareness(data) {
      validateAwarenessStates(data.states, data.context as AuthContext | undefined)
    },

    // M2 (§4.1): for whiteboard keys, attach the server-authoritative repair
    // observer to the freshly loaded live Y.Doc, then run one cold-start pass to
    // converge any persisted illegal state. The observer scopes work to changed
    // ids and skips its own REPAIR_ORIGIN writes (anti-self-excitation gates).
    async afterLoadDocument(data) {
      let kind: string
      try {
        kind = parseDocumentName(data.documentName).kind
      } catch {
        return // malformed key: nothing to repair (auth already rejected it)
      }
      if (kind !== 'whiteboard') return
      const dispose = attachWhiteboardRepair(data.document)
      repairDisposers.set(data.documentName, dispose)
      // Converge persisted state on load through the fixed-clientID
      // materialization so two nodes cold-repairing the same blob on failover
      // emit byte-identical structs (BE-M11); a plain repairLiveDoc here would
      // attribute the corrective writes to this node's RANDOM clientID and
      // diverge on failover.
      coldRepairLiveDoc(data.document)
    },

    // A4 (§5.2): backend-autonomous KIND_AUTO snapshots. afterStoreDocument
    // fires after the authoritative state is persisted; the auto-snapshot
    // module owns the idle timer / min-interval fallback / Redis dedup. Gated
    // behind AUTO_SNAPSHOT_ENABLED (default off) inside the module.
    async afterStoreDocument(data) {
      await handleAfterStore(
        data.documentName,
        data.lastContext as AuthContext | undefined,
        data.document,
      )
    },

    // A4 (§5.2): flush the last editing burst + clear the per-doc idle timer
    // when the document unloads. Also tear down the whiteboard repair observer.
    async beforeUnloadDocument(data) {
      const dispose = repairDisposers.get(data.documentName)
      if (dispose) {
        dispose()
        repairDisposers.delete(data.documentName)
      }
      await handleBeforeUnload(data.documentName, data.document)
    },
  })

  collabServer = server
  return server
}

/**
 * Process-local handle to the running Hocuspocus server, set by createServer().
 * Server-side write paths (e.g. REST version restore) need it to call
 * openDirectConnection and reach the LIVE in-memory document of connected
 * clients. Single-process scaffold; under multi-node owner routing (§5.2 / §9.1)
 * the restore must run on the document's owner node, same as agent writes (§7.3).
 */
let collabServer: Server | null = null

export function getCollabServer(): Server {
  if (!collabServer) throw new Error('collab server not initialized')
  return collabServer
}
