import { createSimpleContext } from "@opencode/ui/context"
import { batch, createEffect, createMemo, onCleanup } from "solid-js"
import { type SetStoreFunction, type Store } from "solid-js/store"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { pathKey } from "@/workspaces/path-key"
import { useLanguage } from "@/runtime/i18n/language"
import { showToast } from "@/shell/notifications/toast"
import { createProjectVisibilitySync, loadProjectVisibility, managedServerId, saveProjectVisibility } from "./managed-visibility"
import { ServerScope } from "@/runtime/server/scope"
import type { ServerEntry } from "@opencode/gui-extensions/sdk"
import { ServerHttp, ServerHttpBase, ServerKey, serverState } from "./persistence"

type ServerState = ReturnType<typeof serverState>["current"]["Type"]

// Retain closed paths until reopened so settings can exclude them from the server inventory.
// The Home page independently limits the visible recently closed entries.
export const RECENTLY_CLOSED_DISPLAY_LIMIT = 5

export function normalizeServerUrl(input: string) {
  const trimmed = input.trim()

  if (!trimmed) return
  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`

  return withProtocol.replace(/\/+$/, "")
}

export function serverName(conn?: ServerConnection.Any, ignoreDisplayName = false) {
  if (!conn) return ""

  if (conn.displayName && !ignoreDisplayName) return conn.displayName

  return conn.http.url.replace(/^https?:\/\//, "").replace(/\/+$/, "")
}

function isLocalHost(url: string) {
  const host = url.replace(/^https?:\/\//, "").split(":")[0]

  if (host === "localhost" || host === "127.0.0.1") return "local"
}

export function createServerProjects(input: {
  scope: () => ServerScope
  store: Store<ServerState>
  setStore: SetStoreFunction<ServerState>
  visibility?: (directory: string, closed: boolean) => void
}) {
  const setStore = input.setStore
  const current = () => input.store.projects[input.scope()] ?? []
  const currentClosed = () => input.store.recentlyClosed?.[input.scope()] ?? []

  const remove = (directory: string) => {
    setStore(
      "projects",
      input.scope(),
      current().filter((project) => project.worktree !== directory),
    )
  }

  return {
    list: current,
    closed: currentClosed,
    recentlyClosed: currentClosed,
    remove,
    open(directory: string) {
      const scope = input.scope()
      const key = pathKey(directory)
      const closed = currentClosed()

      if (closed.some((worktree) => pathKey(worktree) === key)) {
        setStore(
          "recentlyClosed",
          scope,
          closed.filter((worktree) => pathKey(worktree) !== key),
        )
      }

      if (current().some((project) => project.worktree === directory)) {
        if (closed.some((worktree) => pathKey(worktree) === key)) input.visibility?.(directory, false)
        return
      }
      setStore("projects", scope, [{ worktree: directory, expanded: true }, ...current()])
      input.visibility?.(directory, false)
    },
    // User-initiated close: removes the project and records it in recently closed.
    // Internal, non-user removals (e.g. sandbox/worktree normalization) should use remove().
    close(directory: string) {
      remove(directory)
      const key = pathKey(directory)
      const closed = [directory, ...currentClosed().filter((worktree) => pathKey(worktree) !== key)]
      setStore("recentlyClosed", input.scope(), closed)
      input.visibility?.(directory, true)
    },
    expand(directory: string) {
      const index = current().findIndex((project) => project.worktree === directory)

      if (index !== -1) setStore("projects", input.scope(), index, "expanded", true)
    },
    collapse(directory: string) {
      const index = current().findIndex((project) => project.worktree === directory)

      if (index !== -1) setStore("projects", input.scope(), index, "expanded", false)
    },
    move(directory: string, toIndex: number) {
      const fromIndex = current().findIndex((project) => project.worktree === directory)

      if (fromIndex === -1 || fromIndex === toIndex) return
      const next = [...current()]
      const [item] = next.splice(fromIndex, 1)
      next.splice(toIndex, 0, item)
      setStore("projects", input.scope(), next)
    },
    last() {
      return input.store.lastProject[input.scope()]
    },
    touch(directory: string) {
      setStore("lastProject", input.scope(), directory)
    },
  }
}

export function resolveServerList(input: {
  props?: Array<ServerConnection.Any>
  stored: ServerConnection.Http[]
}): Array<ServerConnection.Any> {
  const deduped = new Map<ServerConnection.Key, ServerConnection.Any>(
    input.props?.map((v) => [ServerConnection.key(v), v]) ?? [],
  )

  for (const conn of input.stored) {
    const key = ServerConnection.key(conn)

    const existing = deduped.get(key)

    if (existing)
      deduped.set(key, {
        ...existing,
        ...conn,
        http: { ...existing.http, ...conn.http },
      })
    else deduped.set(key, conn)
  }

  return [...deduped.values()]
}

export function canRemoveServer(input: {
  key: ServerConnection.Key
  provided?: Array<ServerConnection.Any>
  stored: ServerConnection.Http[]
}) {
  if (input.provided?.some((server) => ServerConnection.key(server) === input.key)) return false

  return input.stored.some((server) => server.http.url === input.key)
}

export namespace ServerConnection {
  type Base = { displayName?: string; label?: string }

  export type HttpBase = typeof ServerHttpBase.Type

  // Regular web connections
  export type Http = typeof ServerHttp.Type

  // Regular desktop server
  export type Sidecar = {
    type: "sidecar"
    variant: "base"
    http: HttpBase
    reconnect?: (signal: AbortSignal) => Promise<HttpBase>
  } & Base

  // A server a GUI extension contributes (e.g. SSH or WSL), keyed `${extension}:${id}`
  export type Extension = {
    type: "extension"
    key: string
    extension: string
    state: ServerEntry["state"]
    connecting: boolean
    authenticationRequired: boolean
    /** The extension re-resolves the endpoint (e.g. a tunnel), so the connection can drop and come back. */
    managed: boolean
    http: HttpBase
    reconnect?: (signal: AbortSignal) => Promise<HttpBase>
    /** Called before opening a server that is not ready. Resolves true once it is. */
    connect?: () => Promise<boolean>
  } & Base

  export type Any =
    | Http
    // All these are desktop-only
    | (Sidecar | Extension)

  export const key = (conn: Any): Key => {
    switch (conn.type) {
      case "http":
        return Key.make(conn.http.url)
      case "sidecar":
        return Key.make("sidecar")
      case "extension":
        return Key.make(conn.key)
    }
  }

  export const Key = ServerKey
  export type Key = typeof Key.Type

  export const builtin = (conn: Any) => conn.type === "sidecar" && conn.variant === "base"
  /** Starts sign-in for a server that asks for it; false when it does not. */
  export const authenticate = (conn: Any, onConnected?: () => void) => {
    if (conn.type !== "extension" || !conn.authenticationRequired || !conn.connect) return false
    void conn.connect().then((ready) => {
      if (ready) onConnected?.()
    })

    return true
  }

  export const local = (conn?: Any) =>
    !!conn && (builtin(conn) || (conn.type === "http" && isLocalHost(conn.http.url) === "local"))
}

export const { use: useServers, provider: ServersProvider } = createSimpleContext({
  name: "Server",
  gate: true,
  init: (props: { canonicalLocalServer?: ServerConnection.Key; servers?: Array<ServerConnection.Any> }) => {
    const [store, setStore, _, hydrated] = persisted(
      {
        ...Persist.global("server"),
        sync: true,
        previousKey: "server.v3",
      },
      serverState(() => props.canonicalLocalServer),
      { list: [], hidden: {}, projects: {}, lastProject: {}, recentlyClosed: {} },
    )

    const allServers = createMemo((): Array<ServerConnection.Any> => {
      return resolveServerList({ stored: store.list, props: props.servers })
    })

    const visibleServers = createMemo(() => allServers().filter((conn) => !store.hidden[ServerConnection.key(conn)]))

    function add(input: ServerConnection.Http) {
      const url_ = normalizeServerUrl(input.http.url)

      if (!url_) return
      const conn: ServerConnection.Http = { ...input, authToken: undefined, http: { ...input.http, url: url_ } }

      return batch(() => {
        const existing = store.list.findIndex((x) => x.http.url === url_)

        if (existing !== -1) {
          setStore("list", existing, conn)
        } else {
          setStore("list", store.list.length, conn)
        }

        return conn
      })
    }

    function remove(key: ServerConnection.Key) {
      const list = store.list.filter((x) => x.http.url !== key)
      batch(() => {
        setStore("list", list)
      })
    }

    function canRemove(key: ServerConnection.Key) {
      return canRemoveServer({ key, provided: props.servers, stored: store.list })
    }

    const scope = (key: ServerConnection.Key) => ServerScope.fromServerKey(key, props.canonicalLocalServer)
    const language = useLanguage()
    const sharing = createProjectVisibilitySync({
      load: () => loadProjectVisibility(window.location.origin),
      save: (change) => saveProjectVisibility(window.location.origin, change),
      publish: (closed) => batch(() => {
        for (const server of allServers()) {
          const id = managedServerId(window.location.origin, server.http.url)
          if (!id) continue
          const serverScope = scope(ServerConnection.key(server))
          const paths = closed.filter((entry) => entry.server === id).map((entry) => entry.directory)
          const projects = store.projects[serverScope] ?? []
          const reopened = (store.recentlyClosed[serverScope] ?? []).filter((directory) =>
            !paths.some((closed) => pathKey(closed) === pathKey(directory)) &&
            !projects.some((project) => pathKey(project.worktree) === pathKey(directory)),
          )
          setStore("recentlyClosed", serverScope, paths)
          setStore("projects", serverScope, [
            ...reopened.map((worktree) => ({ worktree, expanded: true })),
            ...projects.filter((project) => !paths.some((directory) => pathKey(directory) === pathKey(project.worktree))),
          ])
        }
      }),
      error: () => showToast({
        variant: "error", title: language.t("project.visibility.syncError"),
        description: language.t("project.visibility.syncRetry"),
      }),
    })
    createEffect(() => {
      if (!hydrated() || !allServers().some((server) => managedServerId(window.location.origin, server.http.url))) return
      void sharing.refresh()
      const timer = setInterval(() => void sharing.refresh(), 5_000)
      const refresh = () => void sharing.refresh()
      window.addEventListener("focus", refresh)
      onCleanup(() => {
        clearInterval(timer)
        window.removeEventListener("focus", refresh)
      })
    })
    onCleanup(() => sharing.dispose())
    const projectStores = new Map<ServerConnection.Key, ReturnType<typeof createServerProjects>>()

    const projectsForServer = (key: ServerConnection.Key) => {
      const existing = projectStores.get(key)

      if (existing) return existing
      const next = createServerProjects({
        scope: () => scope(key), store, setStore,
        visibility: (directory, closed) => {
          const connection = allServers().find((server) => ServerConnection.key(server) === key)
          const server = connection && managedServerId(window.location.origin, connection.http.url)
          if (server) void sharing.change({ server, directory, closed })
        },
      })
      projectStores.set(key, next)

      return next
    }

    return {
      get list() {
        return allServers()
      },
      get visible() {
        return visibleServers()
      },
      // Named to avoid the context `ready` gate: consumers that derive from persisted project
      // state wait on this, but the provider must not block first render on storage.
      hydrated,
      isHidden(key: ServerConnection.Key) {
        return store.hidden[key] ?? false
      },
      setHidden(key: ServerConnection.Key, hidden: boolean) {
        setStore("hidden", key, hidden)
      },
      add,
      remove,
      canRemove,
      scope,
      projects: {
        forServer: projectsForServer,
      },
    }
  },
})
