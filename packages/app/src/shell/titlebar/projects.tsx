import { For, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { displayName } from "@opencode/ui/project-avatar"
import { useGlobal } from "@/runtime/server/runtime"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { useLanguage } from "@/runtime/i18n/language"
import { useLayout } from "@/shell/state/layout"

export function SidebarProjects() {
  const global = useGlobal()
  const servers = useServers()
  const language = useLanguage()
  const layout = useLayout()
  const navigate = useNavigate()

  return (
    <nav aria-label={language.t("home.projects")} data-scrollable class="min-h-0 max-h-[40%] shrink overflow-y-auto py-2">
      <For each={servers.visible}>
        {(server) => {
          const context = global.ensureServerCtx(server)
          const key = ServerConnection.key(server)

          return (
            <Show when={context.projects.unique().length > 0}>
              <div role="group" aria-label={servers.label(server)} class="mb-2">
                <div class="px-2 py-1 text-11-regular text-v2-text-text-muted">{servers.label(server)}</div>
                <For each={context.projects.unique()}>
                  {(project) => (
                    <button
                      type="button"
                      title={project.worktree}
                      aria-current={
                        layout.route().type === "home" &&
                        layout.home.selection().server === key &&
                        layout.home.selection().directory === project.worktree
                          ? "page"
                          : undefined
                      }
                      disabled={global.servers.health[key]?.healthy === false}
                      class="block w-full truncate rounded-[6px] px-2 py-1.5 text-start text-13-regular text-v2-text-text-base hover:bg-v2-background-bg-layer-01 aria-[current=page]:bg-v2-background-bg-layer-01 disabled:opacity-50"
                      onClick={() => {
                        context.projects.touch(project.worktree)
                        layout.home.setSelection({ server: key, directory: project.worktree })
                        navigate("/")
                      }}
                    >
                      {displayName(project)}
                    </button>
                  )}
                </For>
              </div>
            </Show>
          )
        }}
      </For>
    </nav>
  )
}
