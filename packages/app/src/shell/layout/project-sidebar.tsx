import { For, Show, createMemo, mapArray, startTransition } from "solid-js"
import { createStore } from "solid-js/store"
import { skipToken, useQuery } from "@tanstack/solid-query"
import { useNavigate } from "@solidjs/router"
import { Icon } from "@opencode/ui/icon"
import { Spinner } from "@opencode/ui/spinner"
import { displayName } from "@opencode/ui/project-avatar"
import { useGlobal } from "@/runtime/server/runtime"
import { ServerConnection, serverName, useServers } from "@/runtime/server/registry"
import { useLanguage } from "@/runtime/i18n/language"
import { useTabs } from "@/shell/tabs/tabs"
import { useLayout } from "@/shell/state/layout"
import { createHomeController } from "@/home/model"
import { pathKey } from "@/workspaces/path-key"
import { useSettingsDialog } from "@/settings/command"
import { buildHomeSessionRecords } from "@/home/sessions/records"
import { loadHomeSessionIndex, mergeHomeSessionIndex } from "@/home/sessions/index"
import { useSessionTabAvatarState } from "./project-avatar-state"
import type { SessionInfo } from "@opencode/client/promise"
import type { LocalProject } from "@/shell/state/layout"
import "./project-sidebar.css"

export function ProjectSidebar(props: { onNavigate?: () => void }) {
  const language = useLanguage()
  const servers = useServers()
  const navigate = useNavigate()
  const settings = useSettingsDialog()
  const home = createHomeController()
  const layout = useLayout()
  const global = useGlobal()
  const tabs = useTabs()
  function newSession() {
    const route = layout.route()
    if (route.type === "session") {
      const context = global.serverCtx(route.server)
      const session = context?.data.session.get(route.sessionId)
      if (session) { void tabs.newDraft({ server: route.server, directory: session.location.directory }); props.onNavigate?.(); return }
    }
    home.project.openNewSession()
    props.onNavigate?.()
  }
  const [state, setState] = createStore({ query: "" })
  const sources = mapArray(() => servers.visible, (conn) => createServerProjects({ conn, get query() { return state.query }, onNavigate: props.onNavigate }))
  const projects = createMemo(() => sources().flatMap((source) => source.groups().map((group) => ({ source, group }))).sort((a, b) =>
    displayName(a.group.project).localeCompare(displayName(b.group.project), undefined, { sensitivity: "base", numeric: true }) ||
    ServerConnection.key(a.source.conn).localeCompare(ServerConnection.key(b.source.conn)) ||
    a.group.project.worktree.localeCompare(b.group.project.worktree),
  ))

  return (
    <nav class="project-sidebar" aria-label={language.t("settings.projects.title")}>
      <div class="project-sidebar-heading">
        <button type="button" onClick={() => { navigate("/"); props.onNavigate?.() }} class="project-sidebar-brand">OpenCode</button>
        <button type="button" class="project-sidebar-icon" aria-label={language.t("sidebar.settings")} onClick={settings}><Icon name="settings-gear" /></button>
      </div>
      <button type="button" class="project-sidebar-action" onClick={newSession}>
        <Icon name="edit" />{language.t("command.session.new")}
      </button>
      <input class="project-sidebar-search" type="search" value={state.query} onInput={(event) => setState("query", event.currentTarget.value)} aria-label={language.t("sidebar.projects.search")} placeholder={language.t("sidebar.projects.search")} />
      <div class="project-sidebar-label">{language.t("settings.projects.title")}</div>
      <div class="project-sidebar-list">
        <For each={sources()}>{(source) => source.notices()}</For>
        <For each={projects()}>{({ source, group }) => source.render(group)}</For>
      </div>
      <button type="button" class="project-sidebar-action project-sidebar-footer" onClick={() => { navigate("/"); props.onNavigate?.() }}>
        <Icon name="folder-add-left" />{language.t("sidebar.projects.manage")}
      </button>
    </nav>
  )
}

function createServerProjects(props: { conn: ServerConnection.Any; query: string; onNavigate?: () => void }) {
  const global = useGlobal()
  const tabs = useTabs()
  const language = useLanguage()
  const key = () => ServerConnection.key(props.conn)
  const ctx = () => global.serverCtx(key())
  const health = () => global.servers.health[key()]
  const [state, setState] = createStore<{ collapsed: Record<string, boolean>; limits: Record<string, number> }>({ collapsed: {}, limits: {} })
  const load = useQuery(() => {
    const context = ctx()
    return {
      queryKey: ["home-sessions", props.conn] as const,
      enabled: !!context && context.sdk.connection.status() === "connected",
      queryFn: context ? ({ signal }) => loadHomeSessionIndex((input, options) => context.sdk.api.session.list(input, options), signal) : skipToken,
      retry: false,
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      select: (sessions: SessionInfo[]) => () => sessions,
    }
  })
  const records = createMemo(() => buildHomeSessionRecords({
    sessions: () => ctx()?.data.session.apply(mergeHomeSessionIndex(load.data?.() ?? [], ctx()?.data.session.list() ?? [])) ?? [],
    projectDirectories: () => undefined,
    projects: () => ctx()?.projects.list() ?? [],
    resolveProject: (session) => ctx()?.projects.forSession(session),
  }))
  const projects = createMemo(() => {
    const context = ctx()
    const list: LocalProject[] = [
      ...(context?.projects.list() ?? []),
      ...(context?.sync.data.project.filter((project) => project.id !== "global").map((project) => ({ ...project, expanded: true })) ?? []),
      ...records().map((record) => record.project),
    ]
    return [...new Map(list.filter((project) => project.worktree && !context?.projects.closed().some((directory) => pathKey(directory) === pathKey(project.worktree))).map((project) => [project.worktree, project])).values()]
  })
  const groups = createMemo(() => projects().map((project) => ({
    project,
    sessions: records().filter((record) => record.project.worktree === project.worktree),
  })).filter((group) => !props.query || displayName(group.project).toLowerCase().includes(props.query.toLowerCase()) || group.sessions.some((record) => (record.session.title ?? "").toLowerCase().includes(props.query.toLowerCase()))))
  const label = () => ServerConnection.local(props.conn) ? language.t("titlebar.channel.local") : props.conn.displayName ?? new URL(props.conn.http.url).hostname.split(".")[0]

  function open(project: LocalProject, session?: SessionInfo) {
    const context = ctx()
    if (!context || health()?.healthy === false) return
    if (!session) { void tabs.newDraft({ server: key(), directory: project.worktree }); props.onNavigate?.(); return }
    context.projects.open(project.worktree)
    context.projects.touch(project.worktree)
    context.data.session.remember(session)
    void startTransition(() => { tabs.select(tabs.addSessionTab({ server: key(), sessionId: session.id })); props.onNavigate?.() })
  }

  return {
    conn: props.conn,
    groups,
    notices: () => (<>

      <Show when={health()?.healthy === false}>
        <div class="project-sidebar-notice" role="status">{serverName(props.conn)} · {language.t("sidebar.projects.offline")}</div>
      </Show>
      <Show when={load.isFetching && groups().length === 0}><div class="project-sidebar-notice" role="status"><Spinner />{label()}</div></Show>
      <Show when={load.isError && health()?.healthy !== false}><button type="button" class="project-sidebar-action" onClick={() => void load.refetch()}>{language.t("common.retry")}</button></Show>
    </>),
    render: (group: ReturnType<typeof groups>[number]) => {
        const expanded = () => props.query.length > 0 || !(state.collapsed[group.project.worktree] ?? (ctx()?.projects.list().find((item) => item.worktree === group.project.worktree)?.expanded === false))
        const sessions = () => props.query && !displayName(group.project).toLowerCase().includes(props.query.toLowerCase()) ? group.sessions.filter((record) => (record.session.title ?? "").toLowerCase().includes(props.query.toLowerCase())) : group.sessions
        return (
          <section class="project-sidebar-group">
            <div class="project-sidebar-project">
              <button type="button" class="project-sidebar-project-toggle" aria-expanded={expanded()} title={group.project.worktree} onClick={() => { const closing = expanded(); setState("collapsed", group.project.worktree, closing); const context = ctx(); context?.projects.open(group.project.worktree); if (closing) context?.projects.collapse(group.project.worktree); else context?.projects.expand(group.project.worktree) }}>
                <span class="project-sidebar-folder"><Icon name="folder" /></span>
                <span class="project-sidebar-name">{displayName(group.project)}</span>
                <span class="project-sidebar-server" title={props.conn.http.url}>{label()}</span>
                <span class="project-sidebar-health" classList={{ "is-offline": health()?.healthy === false }} aria-hidden="true" />
              </button>
              <button type="button" class="project-sidebar-new" aria-label={language.t("sidebar.projects.new", { project: displayName(group.project) })} disabled={health()?.healthy === false} onClick={() => open(group.project)}>+</button>
            </div>
            <Show when={expanded()}>
              <For each={sessions().slice(0, state.limits[group.project.worktree] ?? 10)}>{(record) => <SidebarSession server={key()} session={record.session} onOpen={() => open(group.project, record.session)} />}</For>
              <Show when={sessions().length > (state.limits[group.project.worktree] ?? 10)}><button type="button" class="project-sidebar-session project-sidebar-empty" onClick={() => setState("limits", group.project.worktree, (state.limits[group.project.worktree] ?? 10) + 20)}>{language.t("sidebar.projects.more")}</button></Show>
              <Show when={sessions().length === 0 && !load.isFetching}><button type="button" class="project-sidebar-session project-sidebar-empty" disabled={health()?.healthy === false} onClick={() => open(group.project)}>{language.t("command.session.new")}</button></Show>
            </Show>
          </section>
        )

    },
  }
}

function SidebarSession(props: { server: ServerConnection.Key; session: SessionInfo; onOpen: () => void }) {
  const layout = useLayout()
  const language = useLanguage()
  const status = useSessionTabAvatarState(() => props.server, () => props.session.id, () => true, () => props.session)
  const selected = () => { const route = layout.route(); return route.type === "session" && route.server === props.server && route.sessionId === props.session.id }
  return <button type="button" class="project-sidebar-session" aria-current={selected() ? "page" : undefined} onClick={props.onOpen} title={props.session.title}>
    <span class="project-sidebar-name">{props.session.title || language.t("command.session.new")}</span>
    <Show when={status.loading()} fallback={<Show when={status.unread()}><span class="project-sidebar-unread" aria-label={language.t("sidebar.projects.unread")} /></Show>}><Spinner /></Show>
  </button>
}
