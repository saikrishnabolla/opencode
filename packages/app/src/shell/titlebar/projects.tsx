import { createMemo, For, Show } from "solid-js"
import { displayName } from "@opencode/ui/project-avatar"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { useGlobal } from "@/runtime/server/runtime"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { useLanguage } from "@/runtime/i18n/language"
import { useLayout } from "@/shell/state/layout"
import { draftHref, type DraftTab, useTabs } from "@/shell/tabs/tabs"
import { createSessionInbox, inboxArchived } from "./inbox-model"
import { sessionTabTitle } from "./tab-title"
import { DraftTabItem } from "./tab-nav"

export function SidebarProjects() {
  const global = useGlobal()
  const servers = useServers()
  const language = useLanguage()
  const layout = useLayout()
  const tabs = useTabs()
  const inbox = createSessionInbox()
  const projects = createMemo(
    () =>
      new Map(
        servers.visible
          .flatMap((server) => {
            const context = global.ensureServerCtx(server)
            return context.projects.unique().map((project) => ({ server, context, project }))
          })
          .sort((a, b) => displayName(a.project).localeCompare(displayName(b.project)))
          .map((group) => [`${ServerConnection.key(group.server)}\0${group.project.worktree}`, group] as const),
      ),
  )

  function selectedDraft(draftID: string) {
    const route = layout.route()
    return route.type === "draft" && route.draftID === draftID
  }

  return (
    <nav aria-label={language.t("home.projects")} data-scrollable class="min-h-0 flex-1 overflow-y-auto py-2">
      <For each={[...projects().keys()]}>
        {(projectKey) => (
          <Show when={projects().get(projectKey)}>
            {(group) => {
              const serverKey = ServerConnection.key(group().server)
              const sessions = createMemo(() =>
                inbox
                  .entries()
                  .filter(
                    (entry) =>
                      entry.server === serverKey &&
                      !inboxArchived(entry) &&
                      group().context.projects.forSession(entry.session)?.worktree === group().project.worktree,
                  ),
              )
              const drafts = createMemo(() =>
                tabs.store.filter(
                  (tab): tab is DraftTab =>
                    tab.type === "draft" &&
                    tab.server === serverKey &&
                    group().context.projects.forDirectory(tab.worktree ?? tab.directory)?.worktree ===
                      group().project.worktree,
                ),
              )

              return (
                <details open aria-label={displayName(group().project)} class="group mb-1">
                  <summary
                    title={group().project.worktree}
                    class="flex cursor-pointer list-none items-center gap-1 rounded-[6px] px-1 py-1.5 text-13-regular text-v2-text-text-base hover:bg-v2-background-bg-layer-01 [&::-webkit-details-marker]:hidden"
                  >
                    <Icon name="chevron-right" size="small" class="shrink-0 group-open:rotate-90" />
                    <span class="min-w-0 flex-1 truncate">{displayName(group().project)}</span>
                    <span class="shrink-0 text-11-regular text-v2-text-text-muted">
                      {servers.label(group().server)}
                    </span>
                    <IconButton
                      icon={<Icon name="plus" />}
                      size="small"
                      variant="ghost-muted"
                      aria-label={language.t("command.session.new")}
                      disabled={global.servers.health[serverKey]?.healthy === false}
                      onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        event.currentTarget.closest("details")?.setAttribute("open", "")
                        void tabs.newDraft({ server: serverKey, directory: group().project.worktree })
                      }}
                    />
                  </summary>
                  <For each={drafts()}>
                    {(draft) => (
                      <DraftTabItem
                        href={draftHref(draft.draftID)}
                        title={language.t("session.tab.session")}
                        orientation="vertical"
                        active={selectedDraft(draft.draftID)}
                        onNavigate={() => tabs.select(draft)}
                        onClose={() => {
                          const index = tabs.store.indexOf(draft)
                          if (index !== -1) void tabs.closeTab(index)
                        }}
                      />
                    )}
                  </For>
                  <For each={sessions().map((entry) => entry.key)}>
                    {(key) => (
                      <Show when={inbox.byKey().get(key)}>
                        {(entry) => (
                          <button
                            type="button"
                            aria-current={inbox.selected(entry()) ? "page" : undefined}
                            class="block w-full truncate rounded-[6px] py-1.5 ps-6 pe-2 text-start text-13-regular text-v2-text-text-muted hover:bg-v2-background-bg-layer-01 aria-[current=page]:bg-v2-background-bg-layer-01"
                            disabled={global.servers.health[serverKey]?.healthy === false}
                            onClick={() => inbox.open(entry())}
                          >
                            {sessionTabTitle(entry().session.title, language.t("session.tab.session"))}
                          </button>
                        )}
                      </Show>
                    )}
                  </For>
                </details>
              )
            }}
          </Show>
        )}
      </For>
    </nav>
  )
}
