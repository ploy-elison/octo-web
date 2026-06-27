import { useEffect, useState, useCallback, useRef } from 'react'
import { getWKApp, getRouteRight, t } from '../octoweb/index.ts'
import { EditorShell } from '../editor/EditorShell.tsx'
import { BoardShell } from '../board/BoardShell.tsx'
import { isBoardDoc, isBoardIdLocally, rememberBoard } from '../board/boardStore.ts'
import '../editor/styles.css'
import { DEFAULT_DOC_SPACE, DEFAULT_DOC_FOLDER, DEFAULT_DOC_ID } from '../config.ts'
import { listDocs, createDoc, type DocListItem } from './docsApi.ts'
import { useMemberNames } from '../members/useMemberNames.ts'
import { formatRelative, formatAbsolute } from '../versions/format.ts'

export interface DocTarget {
  space: string
  folder: string
  doc: string
  docId: string
  /** `'board'` opens the whiteboard shell; anything else (incl. absent) opens the rich-text editor. */
  docType?: string
}

/**
 * sessionStorage key holding the doc the user is currently viewing.
 *
 * Why this exists: the octo host's self-built RouteManager (dmworkbase Service/Route.tsx)
 * handles `pageshow`/`popstate` by re-pushing `window.location.pathname` ONLY — it drops the
 * query string. So immediately after we navigate to `/docs?…&doc=<id>` the host re-pushes
 * `/docs` and the browser URL collapses to `/docs?sid=…`, wiping `?doc=`. That re-push fires
 * repeatedly, each time re-rendering DocsHome with an empty query. We cannot patch the host
 * (shared infra), so we mirror the target here: a deep-link or an in-app open writes it, and
 * resolveDocTarget falls back to it whenever the query no longer carries a doc. It is cleared
 * only when the user explicitly returns to the list, so the editor stays mounted across the
 * host's pathname-only re-renders instead of flipping back to the list.
 */
const TARGET_STORAGE_KEY = 'octo.docs.target'

/** Mirror the active doc target to sessionStorage so it survives the host's query-wiping. */
function persistDocTarget(target: { space: string; folder: string; doc: string; docType?: string }): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(
      TARGET_STORAGE_KEY,
      JSON.stringify({ space: target.space, folder: target.folder, doc: target.doc, docType: target.docType }),
    )
  } catch {
    // sessionStorage unavailable (private mode / disabled): the deep-link still opens on
    // first paint via the query; we just can't survive the host's later query-wiping re-push.
  }
}

/** Forget the persisted target — called when the user explicitly goes back to the list. */
export function clearDocTarget(): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.removeItem(TARGET_STORAGE_KEY)
  } catch {
    // ignore — nothing to clear if storage is unavailable.
  }
}

/** Read the persisted target, validating the shape. Returns null when absent/malformed. */
function readDocTarget(): DocTarget | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.sessionStorage.getItem(TARGET_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<DocTarget> | null
    if (!parsed || typeof parsed.doc !== 'string' || !parsed.doc) return null
    return {
      space: typeof parsed.space === 'string' && parsed.space ? parsed.space : DEFAULT_DOC_SPACE,
      folder:
        typeof parsed.folder === 'string' && parsed.folder ? parsed.folder : DEFAULT_DOC_FOLDER,
      doc: parsed.doc,
      docId: parsed.doc,
      // Trust a stored docType; otherwise fall back to the local board registry so a refresh
      // re-opens a board as a board even if the mirror predates the docType field.
      docType:
        typeof parsed.docType === 'string' && parsed.docType
          ? parsed.docType
          : isBoardIdLocally(parsed.doc)
            ? 'board'
            : undefined,
    }
  } catch {
    return null
  }
}

/**
 * Resolve which document `/docs` should open.
 * Addressing: `/docs?space=<space>&folder=<folder>&doc=<docId>`.
 *
 * Resolution order:
 *   1. URL query (`?doc=`/`?docId=`) — a real deep-link. We persist it (see TARGET_STORAGE_KEY)
 *      so it survives the host re-pushing pathname-only and stripping the query.
 *   2. The persisted sessionStorage target — an in-app open (New / open existing), or a
 *      deep-link whose query the host has already wiped on a `pageshow`/`popstate` re-push.
 *   3. The deployment-configured default doc (VITE_DOCS_DEFAULT_DOC), if any.
 *
 * When none of these yields a doc this returns null and DocsHome renders the document list
 * instead (the backend exposes GET/POST /api/v1/docs for list/create).
 */
export function resolveDocTarget(search: string): DocTarget | null {
  let space = DEFAULT_DOC_SPACE
  let folder = DEFAULT_DOC_FOLDER
  let queryDoc = ''
  try {
    const q = new URLSearchParams(search)
    space = q.get('space') || space
    folder = q.get('folder') || folder
    queryDoc = q.get('doc') || q.get('docId') || ''
  } catch {
    // Non-browser / malformed search — fall back to persisted target / configured defaults.
  }

  // 1. Deep-link via query. Persist it so the editor stays addressable after the host's
  //    pathname-only re-push wipes `?doc=` (the second-blocker root cause). Addressing stays a
  //    single `?doc=` param (three-party-fixed), so the kind is resolved from the local board
  //    registry rather than a separate query param.
  if (queryDoc) {
    const docType = isBoardIdLocally(queryDoc) ? 'board' : undefined
    const target: DocTarget = { space, folder, doc: queryDoc, docId: queryDoc, docType }
    persistDocTarget(target)
    return target
  }

  // 2. The host already wiped the query (or we navigated in-app): fall back to the mirror.
  const persisted = readDocTarget()
  if (persisted) return persisted

  // 3. Deployment-configured default doc, if any.
  if (DEFAULT_DOC_ID) {
    return { space, folder, doc: DEFAULT_DOC_ID, docId: DEFAULT_DOC_ID }
  }

  return null
}

/**
 * Mirror the active doc to the URL (`?doc=<id>`) WITHOUT a full navigation.
 *
 * Split-pane note: opening a doc is now an in-pane state change (setSelectedDoc), not a
 * `window.location.assign`. We still reflect the selection into the URL via
 * history.replaceState so the link is shareable/refreshable — but replaceState does NOT
 * trigger the host RouteManager's pathname-only re-push (that fires on assign/pushState),
 * so `?doc=` is no longer wiped. sessionStorage remains the durable mirror for the
 * deep-link/refresh path. This is what neutralizes the `?doc=` strip should-fix.
 */
function mirrorDocToUrl(docId: string, space: string, folder: string): void {
  if (typeof window === 'undefined') return
  try {
    const q = new URLSearchParams(window.location.search)
    q.set('space', space)
    q.set('folder', folder)
    q.set('doc', docId)
    window.history.replaceState(window.history.state, '', `/docs?${q.toString()}`)
  } catch {
    // history unavailable: selection still works via state; just not URL-reflected.
  }
}

/** Reflect "back to list" into the URL (drop doc addressing) without a full navigation. */
function mirrorListToUrl(): void {
  if (typeof window === 'undefined') return
  try {
    const q = new URLSearchParams(window.location.search)
    q.delete('doc')
    q.delete('docId')
    q.delete('space')
    q.delete('folder')
    const qs = q.toString()
    window.history.replaceState(window.history.state, '', qs ? `/docs?${qs}` : '/docs')
  } catch {
    // ignore
  }
}

/** Document row glyph (sheet of paper with lines) — the existing Docs list icon. */
function DocRowIcon(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4 1.5h5L12.5 5v9a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5Z"
        stroke="currentColor"
        strokeWidth="1"
        fill="none"
      />
      <path d="M9 1.5V5h3.5" stroke="currentColor" strokeWidth="1" fill="none" />
    </svg>
  )
}

/** Board row glyph — an Excalidraw-style sketch (overlapping square + circle) to mark whiteboards. */
function BoardRowIcon(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="3" width="8" height="7" rx="1" stroke="currentColor" strokeWidth="1" fill="none" />
      <circle cx="10.5" cy="9.5" r="3" stroke="currentColor" strokeWidth="1" fill="none" />
    </svg>
  )
}

/** Caret for the split "new" button. */
function CaretIcon(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M3 4.5 6 7.5 9 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * "New" entry as a split / dropdown button (frontend-design §4.1): the primary action creates a
 * document; the caret opens a small menu to choose Document or Board. A disabled "Sheet" row holds
 * the reserved slot for the future table type. Dependency-free dropdown (click-away + Esc to
 * close), matching the lightweight popups elsewhere in docs.
 */
function NewDocMenu({
  creating,
  onCreate,
}: {
  creating: boolean
  onCreate: (docType: 'doc' | 'board') => void
}): React.ReactElement {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDocMouseDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const choose = (docType: 'doc' | 'board') => {
    setOpen(false)
    onCreate(docType)
  }

  return (
    <div className="octo-docs-new-split" ref={wrapRef}>
      <button
        type="button"
        className="octo-docs-list-new octo-docs-new-primary"
        onClick={() => choose('doc')}
        disabled={creating}
      >
        <span className="octo-docs-list-new-icon" aria-hidden="true">+</span>
        {t('docs.list.new')}
      </button>
      <button
        type="button"
        className="octo-docs-list-new octo-docs-new-caret"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('docs.list.newMenu')}
        disabled={creating}
        onClick={() => setOpen((v) => !v)}
      >
        <CaretIcon />
      </button>
      {open && (
        <div className="octo-docs-new-menu" role="menu">
          <button type="button" role="menuitem" className="octo-docs-new-menu-item" onClick={() => choose('doc')}>
            <span className="octo-docs-new-menu-icon" aria-hidden="true"><DocRowIcon /></span>
            {t('docs.list.newDocument')}
          </button>
          <button type="button" role="menuitem" className="octo-docs-new-menu-item" onClick={() => choose('board')}>
            <span className="octo-docs-new-menu-icon" aria-hidden="true"><BoardRowIcon /></span>
            {t('docs.list.newBoard')}
          </button>
          <button type="button" role="menuitem" className="octo-docs-new-menu-item" disabled aria-disabled="true">
            <span className="octo-docs-new-menu-icon" aria-hidden="true">▦</span>
            {t('docs.list.newSheet')}
            <span className="octo-docs-new-menu-soon">{t('docs.list.comingSoon')}</span>
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * Document list landing — shown when `/docs` is opened without a specific doc addressed.
 * Lists documents the caller owns or is a member of (GET /api/v1/docs) and offers a
 * "new document" action (POST /api/v1/docs). Selecting/creating navigates to the editor.
 */
function DocsList({
  space,
  folder,
  selectedDocId,
  onSelect,
  reloadToken,
}: {
  space: string
  folder: string
  selectedDocId: string | null
  onSelect: (docId: string, docType?: string) => void
  reloadToken?: number
}): React.ReactElement {
  const [items, setItems] = useState<DocListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const reload = useCallback(() => {
    setLoading(true)
    setError(null)
    listDocs({ spaceId: space || undefined, folderId: folder || undefined, sort: 'updatedAt:desc' })
      .then((res) => setItems(res?.items ?? []))
      .catch((err) => {
        // Don't swallow the failure: surface it so a first-load error is diagnosable
        // (and offer a retry below) instead of a silently sticky error state.
        console.error('[docs] list failed', err)
        setError(t('docs.state.error'))
      })
      .finally(() => setLoading(false))
  }, [space, folder])

  useEffect(reload, [reload])

  // Refresh the list when the parent bumps reloadToken (e.g. after a rename) so titles update.
  const firstReloadRef = useRef(true)
  useEffect(() => {
    if (firstReloadRef.current) {
      firstReloadRef.current = false
      return // initial load already handled by the mount effect above
    }
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken])

  const onCreate = async (docType: 'doc' | 'board') => {
    if (creating) return
    setCreating(true)
    try {
      const created = await createDoc({
        title: t('docs.state.untitled'),
        spaceId: space || undefined,
        folderId: folder || undefined,
        // Pass the kind through the docType seam; the backend stamps the new doc accordingly and
        // the creator becomes admin (AC3). For boards, also record the id locally so a refresh /
        // deep-link re-opens the whiteboard even if the list response omits docType.
        docType,
      })
      if (docType === 'board') rememberBoard(created.docId)
      // New docs land in the list; select it inline (right pane opens, list stays).
      onSelect(created.docId, created.docType || docType)
      reload()
      setCreating(false)
    } catch {
      setError(t('docs.state.error'))
      setCreating(false)
    }
  }

  return (
    <div className="octo-docs-list">
      <div className="octo-docs-list-header">
        <h2 className="octo-docs-list-title">{t('docs.menu.title')}</h2>
        <NewDocMenu creating={creating} onCreate={onCreate} />
      </div>
      {loading && <p className="octo-docs-list-state">{t('docs.state.loading')}</p>}
      {error && !loading && (
        <p className="octo-docs-list-state octo-error">
          {error}
          <button type="button" className="octo-docs-list-retry" onClick={reload}>
            {t('docs.state.retry')}
          </button>
        </p>
      )}
      {!loading && !error && items.length === 0 && (
        <p className="octo-docs-list-state octo-docs-list-empty">{t('docs.state.empty')}</p>
      )}
      {!loading && !error && items.length > 0 && (
        <ul className="octo-docs-list-items">
          {items.map((d) => {
            const active = d.docId === selectedDocId
            const hasTitle = !!d.title && d.title.trim().length > 0
            const label = hasTitle ? d.title : t('docs.state.untitled')
            const board = isBoardDoc(d)
            return (
              <li
                key={d.docId}
                className={
                  active ? 'octo-docs-list-item octo-docs-list-item-active' : 'octo-docs-list-item'
                }
              >
                <button
                  type="button"
                  className="octo-docs-list-row"
                  onClick={() => onSelect(d.docId, board ? 'board' : 'doc')}
                  aria-current={active ? 'true' : undefined}
                >
                  <span
                    className="octo-docs-list-row-icon"
                    aria-label={board ? t('docs.list.kindBoard') : t('docs.list.kindDoc')}
                    title={board ? t('docs.list.kindBoard') : t('docs.list.kindDoc')}
                  >
                    {board ? <BoardRowIcon /> : <DocRowIcon />}
                  </span>
                  <span className="octo-docs-list-row-text">
                    <span
                      className={
                        hasTitle
                          ? 'octo-docs-list-row-title'
                          : 'octo-docs-list-row-title octo-docs-list-row-title-untitled'
                      }
                    >
                      {label}
                    </span>
                    {d.updatedAt && (
                      <span
                        className="octo-docs-list-row-sub"
                        title={formatAbsolute(d.updatedAt)}
                      >
                        {t('docs.list.updatedAt')} {formatRelative(d.updatedAt)}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/**
 * Docs landing route (`/docs`). uid/identity come from WKApp.loginInfo (octo session).
 * If the URL addresses a specific doc -> open the editor; otherwise render the document
 * list (open existing / create new). The editor's awareness frame is built from user.id
 * (= collab-token uid) + a palette colour via colorFromId (6-hex) in extensions.ts, so it
 * satisfies the backend validateAwarenessStates check — remote carets work once mounted.
 */
/**
 * Docs landing route (`/docs`) — split-pane layout (left list always resident, right editor).
 *
 * Selecting a list item opens the editor INLINE in the right pane via state (selectedDocId),
 * NOT a full navigation — so the left list never disappears, matching the
 * octo-smart-summary / matter list+detail layout. The selection is mirrored to `?doc=` +
 * sessionStorage (mirrorDocToUrl + persistDocTarget) for shareable/deep-link/refresh, using
 * history.replaceState (no host re-push) so `?doc=` is no longer wiped.
 */
export function DocsHome() {
  const wk = getWKApp()
  // Guard the session reads: a render throw here would only trade the silent hang for an
  // error-boundary screen, so default to '' and let the editor/list resolve identity from
  // the collab-token round-trip instead of crashing first paint.
  const uid = wk.loginInfo?.uid ?? ''
  const space = wk.shared?.currentSpaceId || DEFAULT_DOC_SPACE
  const folder = DEFAULT_DOC_FOLDER

  // Initial selection from URL deep-link / persisted target (so a shared `/docs?doc=` or a
  // refresh opens that doc in the right pane on first paint).
  const initialTarget = useRef(
    resolveDocTarget(typeof window !== 'undefined' ? window.location.search : ''),
  )
  const [selectedDocId, setSelectedDocId] = useState<string | null>(
    () => initialTarget.current?.docId ?? null,
  )
  // The kind of the open doc (`'board'` → whiteboard shell, else rich-text editor). Tracked
  // alongside the id so the right pane renders the correct shell across deep-link / refresh.
  const [selectedDocType, setSelectedDocType] = useState<string | undefined>(
    () => initialTarget.current?.docType,
  )

  // The host's right (main) route pane. When present (production), the editor is pushed there
  // so it fills the main content area while the list stays in the left route slot — the same
  // full-width list+detail layout Matter/Summary use. When absent (tests / standalone), we
  // fall back to rendering the editor inline in a CSS split pane.
  const routeRight = getRouteRight()

  // Bumped after a successful rename so the resident list refreshes its titles.
  const [listReloadToken, setListReloadToken] = useState(0)
  const onTitleSaved = useCallback(() => {
    setListReloadToken((n) => n + 1)
  }, [])

  // uid → display name for the space (feature #8): used to set the awareness user.name so the
  // presence avatar initial and the collaboration caret show a real name, not the raw uid.
  // Resilient: empty until resolved (or on fetch failure) → falls back to uid.
  const names = useMemberNames(space)

  // Docs-owned empty state for the right pane. CRITICAL: the host renders its default
  // contentRight (<EmptyStateIllustration/> = the chat "select a conversation" placeholder)
  // as the ALWAYS-PRESENT base layer of the right viewqueue (WKViewQueue renders
  // `{this.props.children}` beneath the imperative `queues` stack). If docs leaves the
  // routeRight queue EMPTY (e.g. on first entry with no doc selected, or after popToRoot),
  // that chat placeholder shows through — the non-deterministic "editor vs chat placeholder"
  // race. Fix: docs ALWAYS occupies routeRight (this empty state when no doc, the editor when
  // one is selected) so the queue is never empty and the chat placeholder never surfaces.
  const buildEmptyState = useCallback(
    () => (
      <div className="octo-doc octo-doc--editor octo-theme octo-docs-right-empty">
        <p>{t('docs.state.empty')}</p>
      </div>
    ),
    [],
  )

  const backToList = useCallback(() => {
    setSelectedDocId(null)
    setSelectedDocType(undefined)
    clearDocTarget()
    mirrorListToUrl()
    if (routeRight) {
      try {
        // Replace with the docs empty state (NOT popToRoot) — popToRoot would empty the queue
        // and let the host chat placeholder show through. Keep docs owning the right pane.
        routeRight.replaceToRoot(buildEmptyState() as unknown)
      } catch {
        // ignore — right pane already cleared / unavailable
      }
    }
  }, [routeRight, buildEmptyState])

  // Called after a successful delete (now from the editor detail page, Problem 4). If the deleted
  // doc is the one open in the right pane, return to the empty/list state (which also resets the
  // editor's drawer, #5 C4); always bump the reload token so the resident list refreshes.
  const onDocDeleted = useCallback(
    (docId: string) => {
      if (docId === selectedDocId) backToList()
      setListReloadToken((n) => n + 1)
    },
    [selectedDocId, backToList],
  )

  // Build the editor element. `onBack` (header "← back" control) is passed ONLY on the inline
  // standalone/test path; in the routeRight production path the left list is always resident, so
  // the header back button is redundant and omitted (#2). `onExit` (= backToList) is ALWAYS
  // wired so the editor can return to the empty/list state on an in-flight deletion (#1 / 4403).
  // `onDeleted` (= onDocDeleted) returns to the list + refreshes it after the editor delete entry.
  const buildEditor = useCallback(
    (docId: string, onBack?: () => void) => (
      <EditorShell
        key={docId}
        docId={docId}
        title={t('docs.state.untitled')}
        uid={uid}
        space={space}
        folder={folder}
        doc={docId}
        user={{ id: uid, name: names.get(uid) || uid }}
        onBack={onBack}
        onExit={backToList}
        onTitleSaved={onTitleSaved}
        onDeleted={onDocDeleted}
      />
    ),
    [uid, space, folder, names, onTitleSaved, backToList, onDocDeleted],
  )

  // Whiteboard counterpart of buildEditor — same lifecycle wiring (exit / rename / delete), but
  // renders the Excalidraw shell. Used when the selected doc's kind is `'board'`.
  const buildBoard = useCallback(
    (docId: string, onBack?: () => void) => (
      <BoardShell
        key={docId}
        docId={docId}
        title={t('docs.state.untitled')}
        space={space}
        onBack={onBack}
        onExit={backToList}
        onTitleSaved={onTitleSaved}
        onDeleted={onDocDeleted}
      />
    ),
    [space, onTitleSaved, backToList, onDocDeleted],
  )

  // Pick the right shell for a doc by kind. Boards open the whiteboard; everything else (incl.
  // unknown/absent kind) opens the rich-text editor — the safe default for legacy docs.
  const buildContent = useCallback(
    (docId: string, docType?: string, onBack?: () => void) =>
      docType === 'board' ? buildBoard(docId, onBack) : buildEditor(docId, onBack),
    [buildBoard, buildEditor],
  )

  const openDoc = useCallback(
    (docId: string, docType?: string) => {
      setSelectedDocId(docId)
      setSelectedDocType(docType)
      // Durable mirror (survives the host's query-wiping re-push) + shareable URL (replaceState,
      // no host re-push) — together neutralizing the `?doc=` strip should-fix.
      persistDocTarget({ space, folder, doc: docId, docType })
      mirrorDocToUrl(docId, space, folder)
      // Full-width path: push the editor/board into the host's main (right) pane, list stays left.
      // No header back button here (#2) — the resident list is the way back.
      if (routeRight) {
        try {
          routeRight.replaceToRoot(buildContent(docId, docType) as unknown)
        } catch {
          // ignore — fall back to inline render below if the host pane rejects.
        }
      }
    },
    [space, folder, routeRight, buildContent],
  )

  // On mount, ALWAYS occupy the right pane so the host chat placeholder never shows through
  // (the contentRight race). If a doc is pre-selected (deep-link / persisted target) push the
  // editor/board; otherwise push the docs empty state. Either way the routeRight queue is
  // non-empty from first paint, so entering /docs is deterministically full-width docs — never
  // the intermittent chat-placeholder regression.
  useEffect(() => {
    if (!routeRight) return
    try {
      if (selectedDocId) {
        routeRight.replaceToRoot(buildContent(selectedDocId, selectedDocType) as unknown)
      } else {
        routeRight.replaceToRoot(buildEmptyState() as unknown)
      }
    } catch {
      // ignore
    }
    // Only on mount: subsequent selections are pushed by openDoc / backToList.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Production (routeRight present): the editor lives in the host's main pane; this route
  // slot renders ONLY the resident list (left). Tests / standalone (no routeRight): render
  // the inline CSS split-pane (left list + right editor) so the layout still works.
  if (routeRight) {
    return (
      <div className="octo-doc octo-docs-list-only">
        <DocsList
          space={space}
          folder={folder}
          selectedDocId={selectedDocId}
          onSelect={openDoc}
          reloadToken={listReloadToken}
        />
      </div>
    )
  }

  return (
    <div className="octo-doc octo-docs-split">
      <aside className="octo-docs-split-left">
        <DocsList
          space={space}
          folder={folder}
          selectedDocId={selectedDocId}
          onSelect={openDoc}
          reloadToken={listReloadToken}
        />
      </aside>
      <section className="octo-docs-split-right">
        {selectedDocId ? (
          buildContent(selectedDocId, selectedDocType, backToList)
        ) : (
          <div className="octo-docs-split-empty">
            <p>{t('docs.state.empty')}</p>
          </div>
        )}
      </section>
    </div>
  )
}
