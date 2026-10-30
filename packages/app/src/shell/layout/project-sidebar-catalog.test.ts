import { expect, test } from "bun:test"
import { catalogProjectForDirectory, sidebarCatalog, sidebarProjects } from "./project-sidebar-catalog"

const catalog = {
  projects: [{ server: "mini" as const, name: "AskNomi", directory: "/workspace", members: ["/workspace/app", "/workspace/api", "/workspace/landing"] }],
  excluded: [{ server: "mini" as const, directory: "/home" }],
}
const scoped = sidebarCatalog(catalog, "https://desk.example/_desk/server/mini", "https://desk.example")

test("the shared list determines membership independently of browser close history", () => {
  expect(sidebarProjects(scoped, [
    { worktree: "/home", expanded: true },
    { worktree: "/workspace/api", expanded: true },
    { worktree: "/other", expanded: true },
  ], ["/workspace"])).toEqual([
    { worktree: "/workspace", name: "AskNomi", expanded: true },
  ])
})

test("removed projects do not reappear from cached projects, sessions or drafts", () => {
  const empty = { ...scoped!, projects: [] }
  const cached = [{ worktree: "/workspace", expanded: true }, { worktree: "/workspace/api", expanded: true }]
  expect(sidebarProjects(empty, cached, [])).toEqual([])
  expect(sidebarProjects(sidebarCatalog({ ...catalog, projects: [] }, "https://desk.example/_desk/server/mini", "https://desk.example"), cached, [])).toEqual([])
})

test("member sessions group under one project with directory boundaries", () => {
  for (const directory of ["/workspace", "/workspace/app", "/workspace/api/src", "/workspace/landing"]) {
    expect(catalogProjectForDirectory(scoped, directory)?.name).toBe("AskNomi")
  }
  for (const directory of ["/workspace/api-other", "/workspace/unrelated", "/workspace-other"]) {
    expect(catalogProjectForDirectory(scoped, directory)).toBeUndefined()
  }
})

test("catalog applies only to the matching managed server and origin", () => {
  expect(sidebarCatalog(catalog, "https://other.example/_desk/server/mini", "https://desk.example")).toBeUndefined()
  expect(sidebarCatalog(catalog, "https://desk.example/ordinary", "https://desk.example")).toBeUndefined()
  expect(sidebarCatalog(catalog, "https://desk.example/_desk/server/oracle", "https://desk.example")?.projects).toEqual([])
  expect(sidebarProjects(undefined, [{ worktree: "/home", expanded: false }, { worktree: "/closed", expanded: true }], ["/closed"])).toEqual([{ worktree: "/home", expanded: false }])
})








test("an added experiment inside an existing project keeps its own sessions", () => {
  const nested = sidebarCatalog({ projects: [
    { server: "oracle", name: "General", directory: "/personal" },
    { server: "oracle", name: "Hackathon", directory: "/personal/hackathon", group: "Experiments" },
  ], excluded: [] }, "https://desk.example/_desk/server/oracle", "https://desk.example")
  expect(catalogProjectForDirectory(nested, "/personal/hackathon")?.name).toBe("Hackathon")
  expect(catalogProjectForDirectory(nested, "/personal/hackathon/src")?.name).toBe("Hackathon")
  expect(catalogProjectForDirectory(nested, "/personal/other")?.name).toBe("General")
})
