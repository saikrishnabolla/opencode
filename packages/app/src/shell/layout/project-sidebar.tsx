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
import { createDraftComposerState } from "@/composer/state"
import { useTabs } from "@/shell/tabs/tabs"
import { useLayout } from "@/shell/state/layout"
import { createHomeController } from "@/home/model"
import { useSettingsDialog } from "@/settings/command"
import { buildHomeSessionRecords } from "@/home/sessions/records"
import { loadHomeSessionIndex, mergeHomeSessionIndex } from "@/home/sessions/index"
import { useSessionTabAvatarState } from "./project-avatar-state"
import type { SessionInfo } from "@opencode/client/promise"
import type { DraftTab } from "@/shell/tabs/tabs"
import type { LocalProject } from "@/shell/state/layout"
import { addManagedExperiment, loadManagedProjects, ManagedExperimentError } from "@/runtime/server/managed"
import type { ManagedProjectCatalog } from "@/runtime/server/managed"
import { catalogProjectForDirectory, groupSidebarEntries, sidebarCatalog, sidebarDrafts, sidebarDraftVisible, sidebarProjects } from "./project-sidebar-catalog"
import { useDirectoryPicker } from "@/workspaces/selection/picker"
import "./project-sidebar.css"

export function ProjectSidebar(props: { onNavigate?: () => void }) {
  const language = useLanguage()
  const servers = useServers()
  const navigate = useNavigate()
  const settings = useSettingsDialog()
  const pickDirectory = useDirectoryPicker()
  const home = createHomeController()
  const layout = useLayout()
  const global = useGlobal()
  const tabs = useTabs()

  function newSession() {
    const route = layout.route()

    if (route.type === "session") {
      const context = global.serverCtx(route.server)
      const session = context?.data.session.get(route.sessionId)

      if (session) { void tabs.newDraft({ server: route.server, directory: session.location.directory }); props.onNavigate?.();

 return }
    }

    if (route.type === "draft") {
      const draft = tabs.draft(route.draftID)
      void tabs.newDraft({ server: draft.server, directory: draft.directory })
      props.onNavigate?.()

      return
    }

    home.project.openNewSession()
    props.onNavigate?.()
  }

  const catalog = useQuery(() => ({
    queryKey: ["desk-projects", window.location.origin],
    enabled: servers.list.some((connection) => connection.http.url.startsWith(`${window.location.origin}/_desk/server/`)),
    queryFn: async () => (await loadManagedProjects(window.location.origin)) ?? null,
    select: (value: ManagedProjectCatalog | null) => () => value ?? undefined,
    staleTime: 60_000,
    retry: false,
  }))

  const [state, setState] = createStore<{ query: string; collapsed: Record<string, boolean>; adding: boolean; saving: boolean; error: string }>({ query: "", collapsed: {}, adding: false, saving: false, error: "" })
  const sources = mapArray(() => servers.visible, (conn) => createServerProjects({ conn, get query() { return state.query }, get catalog() { return catalog.data?.() }, onNavigate: props.onNavigate }))

  const projects = createMemo(() => groupSidebarEntries(sources().flatMap((source) => source.groups().map((group) => ({
    key: `${ServerConnection.key(source.conn)}:${group.project.worktree}`,
    name: displayName(group.project),
    collection: group.collection,
    source,
    group,
  }))).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }) || a.key.localeCompare(b.key))))

  function addFolder(source: ReturnType<typeof sources>[number]) {
    setState({ adding: false, error: "" })
    pickDirectory({
      server: source.conn,
      title: language.t("sidebar.projects.add.title", { server: source.label() }),
      onSelect: (result) => {
        const directory = Array.isArray(result) ? result[0] : result

        if (!directory) return
        setState("saving", true)
        void addManagedExperiment(window.location.origin, source.conn.http.url, directory)
          .then(() => catalog.refetch())
          .then(() => { setState("collapsed", "group:Experiments", false) })
          .catch((error: Error) => setState("error", language.t(`sidebar.projects.add.error.${error instanceof ManagedExperimentError ? error.reason : "request"}`)))
          .finally(() => setState("saving", false))
      },
    })
  }

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
        <For each={projects()}>{(section) => <Show when={section.grouped} fallback={section.entries.map(({ source, group }) => source.render(group))}>
          <section class="project-sidebar-group">
            <div class="project-sidebar-project">
              <button type="button" class="project-sidebar-project-toggle" aria-expanded={state.query.length > 0 || !state.collapsed[section.key]} onClick={() => setState("collapsed", section.key, !state.collapsed[section.key])}>
                <span class="project-sidebar-folder"><Icon name="folder" /></span>
                <span class="project-sidebar-name">{section.name}</span>
              </button>
              <Show when={section.name === "Experiments"}>
                <button type="button" class="project-sidebar-icon" aria-label={language.t("sidebar.projects.add.experiments")} title={language.t("sidebar.projects.add.folder")} aria-expanded={state.adding} disabled={state.saving} onClick={() => { setState("adding", !state.adding); setState("error", ""); setState("collapsed", section.key, false) }}>
                  <Show when={state.saving} fallback={<Icon name="folder-add-left" />}><Spinner /></Show>
                </button>
              </Show>
            </div>
            <Show when={section.name === "Experiments" && state.adding}>
              <div class="project-sidebar-repositories" aria-label={language.t("sidebar.projects.add.server")}>
                <div class="project-sidebar-notice">{language.t("sidebar.projects.add.from")}</div>
                <For each={sources().filter((source) => sidebarCatalog(catalog.data?.(), source.conn.http.url, window.location.origin))}>{(source) =>
                  <button type="button" class="project-sidebar-action" aria-label={language.t("sidebar.projects.add.choose", { server: source.label() })} disabled={source.health()?.healthy === false} onClick={() => addFolder(source)}><Icon name="folder" />{source.label()}</button>
                }</For>
              </div>
            </Show>
            <Show when={section.name === "Experiments" && state.error}><div class="project-sidebar-notice" role="alert">{state.error}</div></Show>
            <Show when={state.query.length > 0 || !state.collapsed[section.key]}>
              <div class="project-sidebar-repositories"><For each={section.entries}>{({ source, group }) => source.render(group)}</For></div>
            </Show>
          </section>
        </Show>}</For>
      </div>
      <button type="button" class="project-sidebar-action project-sidebar-footer" onClick={() => { navigate("/"); props.onNavigate?.() }}>
        <Icon name="folder-add-left" />{language.t("sidebar.projects.manage")}
      </button>
    </nav>
  )
}

function createServerProjects(props: { conn: ServerConnection.Any; query: string; catalog?: ManagedProjectCatalog; onNavigate?: () => void }) {
  const global = useGlobal()
  const tabs = useTabs()
  const language = useLanguage()
  const layout = useLayout()
  const draftStates = mapArray(
    () => tabs.store.filter((tab): tab is DraftTab => tab.type === "draft" && tab.server === ServerConnection.key(props.conn)),
    (tab) => ({ tab, composer: tabs.state(tab, "prompt", () => createDraftComposerState(tab.draftID)) }),
  )
  const visibleDrafts = createMemo(() => {
    const route = layout.route()

    return draftStates().filter(({ tab, composer }) =>
      sidebarDraftVisible(route.type === "draft" && route.draftID === tab.draftID, composer),
    ).map(({ tab }) => tab)
  })
  const key = () => ServerConnection.key(props.conn)
  const ctx = () => global.serverCtx(key())
  const health = () => global.servers.health[key()]
  const catalog = () => sidebarCatalog(props.catalog, props.conn.http.url, window.location.origin)
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
    resolveProject: (session) => catalogProjectForDirectory(catalog(), session.location.directory) ?? ctx()?.projects.forSession(session),
  }))

  const projects = createMemo(() => {
    const context = ctx()

    const list: LocalProject[] = [
      ...visibleDrafts().map((tab) => ({ worktree: tab.directory, expanded: true })),
      ...(context?.projects.list() ?? []),
      ...(context?.sync.data.project.filter((project) => project.id !== "global").map((project) => ({ ...project, expanded: true })) ?? []),
      ...records().map((record) => record.project),
    ]

    return sidebarProjects(catalog(), list, context?.projects.closed() ?? [])
  })

  const groups = createMemo(() => projects().map((project) => ({
    project,
    collection: catalog()?.projects.find((entry) => entry.directory === project.worktree)?.group,
    sessions: records().filter((record) => record.project.worktree === project.worktree),
    drafts: sidebarDrafts(visibleDrafts(), key(), project, catalog()),
  })).filter((group) => !props.query || (group.collection ?? "").toLowerCase().includes(props.query.toLowerCase()) || displayName(group.project).toLowerCase().includes(props.query.toLowerCase()) || group.sessions.some((record) => (record.session.title ?? "").toLowerCase().includes(props.query.toLowerCase())) || (group.drafts.length > 0 && language.t("command.session.new").toLowerCase().includes(props.query.toLowerCase()))))

  const label = () => ServerConnection.local(props.conn) ? language.t("titlebar.channel.local") : props.conn.displayName ?? new URL(props.conn.http.url).hostname.split(".")[0]

  function open(project: LocalProject, session?: SessionInfo) {
    const context = ctx()

    if (!context || health()?.healthy === false) return
    context.projects.open(project.worktree)
    context.projects.touch(project.worktree)

    if (!session) {
      setState("collapsed", project.worktree, false)
      context.projects.expand(project.worktree)
      void tabs.newDraft({ server: key(), directory: project.worktree })
      props.onNavigate?.()

      return
    }

    context.data.session.remember(session)
    void startTransition(() => { tabs.select(tabs.addSessionTab({ server: key(), sessionId: session.id })); props.onNavigate?.() })
  }

  return {
    conn: props.conn,
    groups,
    health,
    label,
    open,
    renderSessions,
    notices: () => (<>

      <Show when={health()?.healthy === false}>
        <div class="project-sidebar-notice" role="status">{serverName(props.conn)} · {language.t("sidebar.projects.offline")}</div>
      </Show>
      <Show when={load.isFetching && groups().length === 0}><div class="project-sidebar-notice" role="status"><Spinner />{label()}</div></Show>
      <Show when={load.isError && health()?.healthy !== false}><button type="button" class="project-sidebar-action" onClick={() => void load.refetch()}>{language.t("common.retry")}</button></Show>
    </>),
    render: (group: ReturnType<typeof groups>[number]) => {
        const expanded = () => props.query.length > 0 || !(state.collapsed[group.project.worktree] ?? (ctx()?.projects.list().find((item) => item.worktree === group.project.worktree)?.expanded === false))

        return (
          <section class="project-sidebar-group">
            <div class="project-sidebar-project">
              <button type="button" class="project-sidebar-project-toggle" aria-expanded={expanded()} title={group.project.worktree} onClick={() => { const closing = expanded(); setState("collapsed", group.project.worktree, closing); const context = ctx(); context?.projects.open(group.project.worktree);

 if (closing) context?.projects.collapse(group.project.worktree); else context?.projects.expand(group.project.worktree) }}>
                <span class="project-sidebar-folder"><Icon name="folder" /></span>
                <span class="project-sidebar-name">{displayName(group.project)}</span>
                <span class="project-sidebar-server" title={props.conn.http.url}>{label()}</span>
                <span class="project-sidebar-health" classList={{ "is-offline": health()?.healthy === false }} aria-hidden="true" />
              </button>
              <button type="button" class="project-sidebar-new" aria-label={language.t("sidebar.projects.new", { project: displayName(group.project) })} disabled={health()?.healthy === false} onClick={() => open(group.project)}>+</button>
            </div>
            <Show when={expanded()}>
              {renderSessions(group)}
            </Show>
          </section>
        )

    },
  }

  function renderSessions(group: ReturnType<typeof groups>[number]) {
    const sessions = () => props.query && !(group.collection ?? "").toLowerCase().includes(props.query.toLowerCase()) && !displayName(group.project).toLowerCase().includes(props.query.toLowerCase()) ? group.sessions.filter((record) => (record.session.title ?? "").toLowerCase().includes(props.query.toLowerCase())) : group.sessions
    const drafts = () => props.query && !(group.collection ?? "").toLowerCase().includes(props.query.toLowerCase()) && !displayName(group.project).toLowerCase().includes(props.query.toLowerCase()) && !language.t("command.session.new").toLowerCase().includes(props.query.toLowerCase()) ? [] : group.drafts

    return <>
      <For each={drafts()}>{(draft, index) => <SidebarDraft draft={draft} number={group.drafts.length - index()} onOpen={() => { tabs.select(draft); props.onNavigate?.() }} onClose={() => tabs.closeTab(tabs.store.indexOf(draft))} />}</For>
      <For each={sessions().slice(0, state.limits[group.project.worktree] ?? 10)}>{(record) => <SidebarSession server={key()} session={record.session} onOpen={() => open(group.project, record.session)} />}</For>
      <Show when={sessions().length > (state.limits[group.project.worktree] ?? 10)}><button type="button" class="project-sidebar-session project-sidebar-empty" onClick={() => setState("limits", group.project.worktree, (state.limits[group.project.worktree] ?? 10) + 20)}>{language.t("sidebar.projects.more")}</button></Show>
      <Show when={sessions().length === 0 && drafts().length === 0 && !load.isFetching}><button type="button" class="project-sidebar-session project-sidebar-empty" title={group.project.worktree} aria-label={language.t("sidebar.projects.new", { project: displayName(group.project) })} disabled={health()?.healthy === false} onClick={() => open(group.project)}>
        {language.t("command.session.new")}
      </button></Show>
    </>
  }
}

function SidebarSession(props: { server: ServerConnection.Key; session: SessionInfo; onOpen: () => void }) {
  const layout = useLayout()
  const language = useLanguage()
  const status = useSessionTabAvatarState(() => props.server, () => props.session.id, () => true, () => props.session)

  const selected = () => { const route = layout.route();

 return route.type === "session" && route.server === props.server && route.sessionId === props.session.id }

  return <button type="button" class="project-sidebar-session" aria-current={selected() ? "page" : undefined} onClick={props.onOpen} title={props.session.title}>
    <span class="project-sidebar-name">{props.session.title || language.t("command.session.new")}</span>
    <Show when={status.loading()} fallback={<Show when={status.unread()}><span class="project-sidebar-unread" aria-label={language.t("sidebar.projects.unread")} /></Show>}><Spinner /></Show>
  </button>
}

function SidebarDraft(props: { draft: DraftTab; number: number; onOpen: () => void; onClose: () => void }) {
  const layout = useLayout()
  const language = useLanguage()

  const selected = () => { const route = layout.route();

 return route.type === "draft" && route.draftID === props.draft.draftID }

  return <div class="project-sidebar-draft">
    <button type="button" class="project-sidebar-session" aria-current={selected() ? "page" : undefined} onClick={props.onOpen} title={props.draft.directory}>
      <Icon name="edit" /><span class="project-sidebar-name">{language.t("command.session.new")} {props.number}</span>
    </button>
    <button type="button" class="project-sidebar-draft-close" aria-label={`${language.t("common.closeTab")}: ${language.t("command.session.new")} ${props.number}`} onClick={props.onClose}><Icon name="close" /></button>
  </div>
}
