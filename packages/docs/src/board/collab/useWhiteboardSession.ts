// React binding for the collaborative whiteboard session (board counterpart of useCollabEditor).
//
// A board-level registry keyed by `${uid}::${documentName}` makes account / board switches isolate
// naturally and survives StrictMode's double-invoked effects (idempotent create + refcount), the
// same shape useCollabEditor uses for the doc editor. The board does not gate editability on a
// pre-connect role (BoardShell resolves the caller's role separately via getDoc, and Excalidraw is
// view-mode-toggled from that), but it DOES await the collab-token exchange before building the
// provider — the WS origin is delivered at runtime in that response (`collabWsUrl`, backend
// XIN-211) and resolved via resolveCollabWsUrl, mirroring CollabEditor.create. The eager fetch
// primes the token cache the provider's own getter reads on connect, so there is no extra round-trip.
//
// Token contract: the board reuses the doc editor's collab-token flow — POST /docs/collab-token
// with the whiteboard documentName `octo:{space}:{folder}:wb:{board}`. The backend's unified WS
// router already recognises the 5-segment `:wb:` key (see @octo/whiteboard-schema name codec), so
// the same endpoint issues a token for a board. No board-specific endpoint is introduced here.

import { useEffect, useState } from 'react'
import { createWhiteboardSession, type WhiteboardSession } from './connect.ts'
import { buildWhiteboardName } from './schema.ts'
import { resolveCollabWsUrl } from '../../config.ts'
import { getCollabToken, getCollabTokenEntry } from '../../auth/collabToken.ts'

export interface UseWhiteboardSessionOptions {
  uid: string
  space: string
  folder: string
  board: string
  /** Disable the local IndexedDB cache for high-confidentiality boards (mirrors the editor). */
  disableOfflineCache?: boolean
}

interface RegistryEntry {
  refCount: number
  session: WhiteboardSession
}

const registry = new Map<string, RegistryEntry>()

function acquire(key: string, create: () => WhiteboardSession): RegistryEntry {
  let entry = registry.get(key)
  if (!entry) {
    entry = { refCount: 0, session: create() }
    registry.set(key, entry)
  }
  entry.refCount++
  return entry
}

function release(key: string): void {
  const entry = registry.get(key)
  if (!entry) return
  entry.refCount--
  if (entry.refCount <= 0) {
    registry.delete(key)
    // Only destroy if no one re-acquired under the same key meanwhile.
    if (!registry.has(key)) entry.session.destroy()
  }
}

/**
 * Acquire a live whiteboard collaboration session for the given board, refcounted by
 * `${uid}::${documentName}`. Returns the session once the effect has run (null on the first render
 * and after teardown). The caller passes the session to `<BoardShell collabSession={...}>`; this
 * hook owns its create/destroy lifecycle.
 */
export function useWhiteboardSession(opts: UseWhiteboardSessionOptions): WhiteboardSession | null {
  const { uid, space, folder, board, disableOfflineCache } = opts
  const documentName = buildWhiteboardName(space, folder, board)
  const key = `${uid}::${documentName}`

  const [session, setSession] = useState<WhiteboardSession | null>(null)

  useEffect(() => {
    let active = true
    let acquiredKey: string | null = null

    // Resolve the WS origin from the collab-token response before building the provider: prefer
    // the backend-issued `collabWsUrl`, falling back to the legacy build-time env when absent
    // (resolveCollabWsUrl). This is the same runtime contract the doc editor uses; the eager token
    // fetch is cached, so the provider's own getter reuses it on connect.
    getCollabTokenEntry(documentName)
      .then((entry) => {
        if (!active) return
        const url = resolveCollabWsUrl(entry.collabWsUrl)
        const acquired = acquire(key, () =>
          createWhiteboardSession({
            space,
            folder,
            board,
            url,
            token: () => getCollabToken(documentName),
            disableOfflineCache,
          }),
        )
        acquiredKey = key
        setSession(acquired.session)
      })
      .catch(() => {
        // Token issuance failed (not_found / network): leave the session null so BoardShell
        // surfaces the failure instead of connecting to an unresolved endpoint.
      })

    return () => {
      active = false
      setSession(null)
      if (acquiredKey) release(acquiredKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]) // ⚠️ keyed by uid + whiteboard documentName — switching either rebuilds.

  return session
}
