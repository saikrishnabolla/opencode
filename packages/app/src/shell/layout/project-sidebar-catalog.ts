import type { ManagedProjectCatalog } from "@/runtime/server/managed"
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
  if (catalog) return catalog.projects.map((project) => ({ worktree: project.directory, name: project.name, expanded: true }))
  return [...new Map(projects.filter((project) => project.worktree && !closed.some((directory) => pathKey(directory) === pathKey(project.worktree)))
    .map((project) => [pathKey(project.worktree), project])).values()]
}
