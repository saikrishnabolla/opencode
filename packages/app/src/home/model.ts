import { useGlobal, useServerCtx } from "@/runtime/server/runtime"
import { type HomeProjectSelection, type LocalProject, useLayout } from "@/shell/state/layout"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { useTabs } from "@/shell/tabs/tabs"
import { toggleHomeProjectSelection } from "@/shell/layout/helpers"
import { createEffect, createMemo, startTransition } from "solid-js"
import type { SessionInfo } from "@opencode/client/promise"
import { pathKey } from "@/workspaces/path-key"
import { changeManagedProject, managedServerId, useManagedProjects } from "@/runtime/server/managed"
import { useLanguage } from "@/runtime/i18n/language"
import { showToast } from "@/shell/notifications/toast"
import { addProjects } from "./projects/add"

export function createHomeController() {
  const language = useLanguage()
  const layout = useLayout()
  const global = useGlobal()
  const servers = useServers()
  const tabs = useTabs()
  const shared = useManagedProjects(() => servers.list.some((connection) => !!managedServerId(window.location.origin, connection.http.url)))
  const forServer = (conn: ServerConnection.Any): LocalProject[] => {
    const id = managedServerId(window.location.origin, conn.http.url)
    if (!id) return global.ensureServerCtx(conn).projects.list()
    return (shared.data?.()?.projects.filter((project) => project.server === id) ?? [])
      .map((project) => ({
        ...global.ensureServerCtx(conn).sync.data.project.find((value) => value.worktree === project.directory),
        ...global.ensureServerCtx(conn).projects.list().find((value) => value.worktree === project.directory),
        worktree: project.directory, name: project.name, expanded: true,
      }))
  }
  const selection = layout.home.selection

  const focusedServer = createMemo<ServerConnection.Any | undefined>(
    () => servers.visible.find((conn) => ServerConnection.key(conn) === selection().server) ?? servers.visible[0],
  )

  const focusedServerCtx = useServerCtx(focusedServer)
  const focusedSync = () => focusedServerCtx()?.sync
  const projects = createMemo(() => { const conn = focusedServer(); return conn ? forServer(conn) : [] })
  const recentlyClosed = createMemo(() => focusedServer() && managedServerId(window.location.origin, focusedServer()!.http.url) ? [] : focusedServerCtx()?.projects.recentlyClosed() ?? [])
  const homedir = createMemo(() => focusedSync()?.data.path.home ?? "")
  const selectedProject = createMemo(() => projects().find((project) => project.worktree === selection().directory))

  const newSessionProject = createMemo(
    () =>
      selectedProject() ??
      projects().find((project) => project.worktree === focusedServerCtx()?.projects.last()) ??
      projects()[0],
  )

  createEffect(() => {
    const list = servers.visible

    if (list.some((conn) => ServerConnection.key(conn) === selection().server)) return
    const conn = list[0]

    if (conn) setSelection({ server: ServerConnection.key(conn) })
  })
  createEffect(() => {
    const ctx = focusedServerCtx()
    const id = selectedProject()?.id

    if (!ctx || !id || ctx.sdk.connection.status() !== "connected") return
    // Selecting a project is the demand for its worktree inventory: the session filter spans its worktrees.
    void ctx.sync.worktrees.list(id).then(() => ctx.sync.worktrees.refresh(id))
  })
  createEffect(() => {
    // The project list is empty until the server store hydrates; clearing the restored
    // selection against it would persist the loss.
    if (!servers.hydrated()) return
    const current = selection()
    const directory = current.directory

    if (!directory) return
    const conn = servers.visible.find((conn) => ServerConnection.key(conn) === current.server)

    if (!conn) return
    if (managedServerId(window.location.origin, conn.http.url) && !shared.data?.()) return

    if (
      forServer(conn).some((project) => pathKey(project.worktree) === pathKey(directory))
    )
      return
    setSelection({ server: current.server })
  })

  function setSelection(next: HomeProjectSelection) {
    layout.home.setSelection(next)
  }

  function openProjectNewSession(conn: ServerConnection.Any, directory: string) {
    const ctx = global.ensureServerCtx(conn)
    ctx.projects.open(directory)
    ctx.projects.touch(directory)
    void tabs.newDraft({ server: ServerConnection.key(conn), directory })
  }

  function openProjectSession(conn: ServerConnection.Any, directory: string, session: SessionInfo) {
    const ctx = global.ensureServerCtx(conn)
    void ctx.data.session.message.sync(session.id).catch(() => undefined)
    void startTransition(() => {
      const tab = tabs.addSessionTab({ server: ServerConnection.key(conn), sessionId: session.id })
      tabs.select(tab)
      ctx.data.session.remember(session)
      ctx.projects.open(directory)
      ctx.projects.touch(directory)
    })
  }

  return {
    selection: {
      value: selection,
      set: setSelection,
      focusServer: (conn: ServerConnection.Any) => setSelection({ server: ServerConnection.key(conn) }),
    },
    server: {
      list: () => servers.visible,
      health: (conn: ServerConnection.Any) => global.servers.health[ServerConnection.key(conn)],
      context: (conn: ServerConnection.Any) => global.ensureServerCtx(conn),
      focused: focusedServer,
      focusedContext: focusedServerCtx,
      focusedSync,
    },
    project: {
      list: projects,
      recentlyClosed,
      homedir,
      selected: selectedProject,
      newSession: newSessionProject,
      forServer,
      select: (conn: ServerConnection.Any, directory: string) => {
        const key = ServerConnection.key(conn)

        if (global.servers.health[key]?.healthy === false) return

        if (
          !forServer(conn).some((project) => project.worktree === directory)
        )
          return
        global.ensureServerCtx(conn).projects.open(directory)
        setSelection(toggleHomeProjectSelection(selection(), key, directory))
      },
      add: (conn: ServerConnection.Any, directories: string[]) => {
        const add = () => {
          const directory = addProjects(global.ensureServerCtx(conn), directories)
          if (directory) setSelection({ server: ServerConnection.key(conn), directory })
        }
        if (!managedServerId(window.location.origin, conn.http.url)) return add()
        void Promise.all(directories.map((directory) => changeManagedProject(window.location.origin, conn.http.url, directory, "POST")))
          .then(add)
          .catch(() => showToast({ title: language.t("sidebar.projects.updateError"), variant: "error" }))
      },
      openNewSession: () => {
        const conn = focusedServer()
        const project = newSessionProject()

        if (!conn || !project) return
        openProjectNewSession(conn, project.worktree)
      },
      openProjectNewSession,
      openProjectSession,
    },
  }
}

export type HomeController = ReturnType<typeof createHomeController>
