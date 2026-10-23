import { Show, Suspense, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { createMediaQuery } from "@solid-primitives/media"
import { ResizeHandle } from "@opencode/ui/resize-handle"
import { Titlebar } from "@/shell/titlebar/titlebar"
import { usePlatform } from "@/runtime/platform/platform"
import { ToastRegion } from "@/shell/notifications/toast"
import { UploadToastHost } from "@/composer/attachments/uploads"
import { TitlebarRightProvider } from "@/shell/titlebar/right-slot"
import { useSettingsSurface } from "@/settings/surface"
import { useSettings } from "@/settings/model"
import { ExtensionServerCover } from "@/runtime/extension/server-shell"
import { useLanguage } from "@/runtime/i18n/language"
import { ProjectSidebar } from "@/shell/layout/project-sidebar"
import { ExtensionSlot } from "@/runtime/extension/render"

export default function Layout(props: ParentProps) {
  const language = useLanguage()
  const platform = usePlatform()
  const settings = useSettingsSurface()
  const preferences = useSettings()
  const mobile = createMediaQuery("(max-width: 767px)")

  const [state, setState] = createStore<{ tabsWidth: number; projectsOpen: boolean }>({
    tabsWidth: 300,
    projectsOpen: false,
  })

  const verticalTabs = () => preferences.appearance.tabLayout() === "vertical"
  const showProjects = () => verticalTabs() && (!mobile() || state.projectsOpen)
  const bottomTitlebar = () => mobile() && preferences.general.mobileTitlebarPosition() === "bottom"

  return (
    <TitlebarRightProvider>
      <div
        class="relative bg-v2-background-bg-deep flex-1 min-h-0 min-w-0 flex flex-col select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"
        style={{
          // Mobile panels only need clearance for their outer border.
          "--shell-inline-inset": mobile() ? "1px" : "8px",
          // A bottom mobile titlebar leaves main's top edge to the safe area. Native Windows chrome supplies the gap;
          // retain outer-outline clearance.
          "--shell-top-inset": bottomTitlebar()
            ? "0px"
            : platform.platform === "desktop" && platform.os === "windows"
              ? "1px"
              : "8px",
          "--shell-bottom-inset": bottomTitlebar()
            ? "8px"
            : "max(0px, calc(8px - var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))))",
        }}
      >
        <Titlebar verticalTabs={verticalTabs() && !mobile() ? {} : undefined} />
        <Show when={mobile() && verticalTabs()}><button type="button" class="project-sidebar-mobile-toggle" aria-expanded={state.projectsOpen} onClick={() => setState("projectsOpen", !state.projectsOpen)}>{language.t("settings.projects.title")}</button></Show>
        <div class="relative flex flex-1 min-h-0 min-w-0 flex-row">
          <Show when={showProjects()}>
            <aside
              classList={{ "project-sidebar-mobile": mobile() }}
              data-slot="vertical-tabs-sidebar"
              class="relative flex h-full min-h-0 shrink-0 flex-col bg-v2-background-bg-deep pe-0.5 ps-2.5 pb-[var(--shell-bottom-inset,8px)] pt-[var(--shell-top-inset,8px)]"
              style={{
                width: `${state.tabsWidth}px`,
                "padding-bottom": "max(10px, var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))",
              }}
            >
              <ProjectSidebar onNavigate={() => setState("projectsOpen", false)} />
              <Show when={!mobile()}><ResizeHandle
                class="-end-2"
                direction="horizontal"
                size={state.tabsWidth}
                min={240}
                max={520}
                onResize={(width) => setState("tabsWidth", width)}
              /></Show>
            </aside>
          </Show>
          {/* Size containment collapses percentage-height descendants in WebKit. */}
          <main
            class="flex-1 min-h-0 min-w-0 overflow-x-hidden flex flex-col items-start contain-content"
            style={{
              "padding-top": bottomTitlebar() ? "env(safe-area-inset-top, 0px)" : "0px",
              "padding-bottom":
                bottomTitlebar() || settings.active()
                  ? "0px"
                  : "var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))",
              "--settings-bottom-inset": bottomTitlebar()
                ? "40px"
                : "var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))",
            }}
          >
            <ExtensionServerCover>
              <Suspense>{props.children}</Suspense>
            </ExtensionServerCover>
          </main>
        </div>
        <ExtensionSlot at="window.bottom" input={{}} />
        <ToastRegion />
        <UploadToastHost />
      </div>
    </TitlebarRightProvider>
  )
}
