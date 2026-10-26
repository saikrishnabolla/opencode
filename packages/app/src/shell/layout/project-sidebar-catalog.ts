import type { ComposerState } from "@/composer/state"
import type { ManagedProjectCatalog } from "@/runtime/server/managed"
import type { Tab, DraftTab } from "@/shell/tabs/tabs"
import type { ServerConnection } from "@/runtime/server/registry"
import type { LocalProject } from "@/shell/state/layout"
import { pathKey } from "@/workspaces/path-key"

export function sidebarCatalog(catalog: ManagedProjectCatalog | undefined, serverUrl: string, origin: string) {
  const url = new URL(serverUrl)
  const match = url.origin === origin && /^\/_desk\/server\/(oracle|studio|mini)\/?$/.exec(url.pathname)
  if (!catalog || !match) return
  return {
    projects: catalog.projects.filter((project) => project.server === match[1]),
    excluded: catalog.excluded.filter((project) => project.server === match[1]),
  }
}

type Catalog = ReturnType<typeof sidebarCatalog>

export function catalogProjectForDirectory(catalog: Catalog, directory: string): LocalProject | undefined {
  const key = pathKey(directory)
  const project = catalog?.projects.find((project) => pathKey(project.directory) === key) ?? catalog?.projects.flatMap((project) =>
    (project.members ?? [project.directory]).map((root) => ({ project, root: pathKey(root) })),
  ).filter(({ root }) => key === root || key.startsWith(`${root}/`))
    .sort((a, b) => b.root.length - a.root.length)[0]?.project
  if (project) return { worktree: project.directory, name: project.name, expanded: true }
}

export function sidebarProjects(catalog: Catalog, projects: LocalProject[], closed: string[]): LocalProject[] {
  const isClosed = (directory: string) => closed.some((value) => pathKey(value) === pathKey(directory))
  const defaults = catalog?.projects.filter((project) => !isClosed(project.directory))
    .map((project) => ({ worktree: project.directory, name: project.name, expanded: true })) ?? []
  const ordinary = projects.filter((project) =>
    project.worktree &&
    !catalog?.excluded.some((excluded) => pathKey(excluded.directory) === pathKey(project.worktree)) &&
    !catalogProjectForDirectory(catalog, project.worktree) &&
    !isClosed(project.worktree),
  )
  return [...new Map([...ordinary, ...defaults].map((project) => [pathKey(project.worktree), project])).values()]
}

export function groupSidebarEntries<T extends { key: string; name: string; collection?: string }>(entries: T[]) {
  const groups = new Map<string, { key: string; name: string; grouped: boolean; entries: T[] }>()
  for (const entry of entries) {
    const key = entry.collection ? `group:${entry.collection}` : `project:${entry.key}`
    const group = groups.get(key)
    if (group) { group.entries.push(entry); continue }
    groups.set(key, { key, name: entry.collection ?? entry.name, grouped: !!entry.collection, entries: [entry] })
  }
  for (const group of groups.values()) group.entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }) || a.key.localeCompare(b.key))
  return [...groups.values()].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }) || a.key.localeCompare(b.key),
  )
}

export function sidebarDrafts(tabs: readonly Tab[], server: ServerConnection.Key, project: LocalProject, catalog: Catalog): DraftTab[] {
  return tabs.filter((tab): tab is DraftTab => tab.type === "draft" && tab.server === server &&
    pathKey(catalogProjectForDirectory(catalog, tab.directory)?.worktree ?? tab.directory) === pathKey(project.worktree),
  ).toReversed()
}

export function sidebarDraftVisible(active: boolean, composer: ComposerState) {
  return active || (composer.ready() && (
    composer.current().some((part) => part.type !== "text" || part.content.trim().length > 0) ||
    composer.context.items().length > 0
  ))
}
