import { ServerConnection } from "@/runtime/server/registry"
import { expect, test } from "bun:test"
import { catalogProjectForDirectory, groupSidebarEntries, sidebarCatalog, sidebarDrafts, sidebarProjects } from "./project-sidebar-catalog"

const oracle = ServerConnection.key({ type: "http", http: { url: "https://oracle.test" } })

const studio = ServerConnection.key({ type: "http", http: { url: "https://studio.test" } })

const mini = ServerConnection.key({ type: "http", http: { url: "https://mini.test" } })

const catalog = {
  projects: [{ server: "mini" as const, name: "AskNomi", directory: "/workspace", members: ["/workspace/app", "/workspace/api", "/workspace/landing"] }],
  excluded: [{ server: "mini" as const, directory: "/home" }],
}

const scoped = sidebarCatalog(catalog, "https://desk.example/_desk/server/mini", "https://desk.example")

test("shared defaults survive browser closure while exclusions and unrelated projects keep their meaning", () => {
  expect(sidebarProjects(scoped, [
    { worktree: "/home", expanded: true },
    { worktree: "/workspace/api", expanded: true },
    { worktree: "/other", expanded: true },
    { worktree: "/closed", expanded: true },
  ], ["/workspace", "/closed"])).toEqual([
    { worktree: "/other", expanded: true },
    { worktree: "/workspace", name: "AskNomi", expanded: true },
  ])
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


test("collections combine repositories across servers without changing their targets", () => {
  const cue = { key: "studio:/cue", name: "Cue", collection: "Experiments" }
  const hermes = { key: "studio:/hermes", name: "Hermes", collection: "Experiments" }
  const opencode = { key: "oracle:/opencode", name: "OpenCode", collection: "Experiments" }
  const general = { key: "oracle:/personal", name: "General" }
  const sections = groupSidebarEntries([general, cue, hermes, opencode])
  expect(sections.map((section) => section.name)).toEqual(["Experiments", "General"])
  expect(sections[0].entries).toEqual([cue, hermes, opencode])
  expect(sections[0].entries[0]).toBe(cue)
  expect(sections[0].grouped).toBe(true)
  expect(sections[1].grouped).toBe(false)
})


test("repositories stay alphabetical inside a collection regardless of server order", () => {
  const entries = [
    { key: "oracle:/opencode", name: "OpenCode", collection: "Experiments" },
    { key: "studio:/hermes", name: "Hermes", collection: "Experiments" },
    { key: "studio:/cue", name: "Cue", collection: "Experiments" },
  ]

  expect(groupSidebarEntries(entries)[0].entries.map((entry) => entry.name)).toEqual(["Cue", "Hermes", "OpenCode"])
})

test("new drafts remain selectable under their repository, newest first, on the correct server", () => {
  const first = { type: "draft" as const, draftID: "first", server: oracle, directory: "/repo" }
  const second = { ...first, draftID: "second" }
  const elsewhere = { ...first, draftID: "elsewhere", directory: "/repo-other" }
  const remote = { ...first, draftID: "remote", server: studio }
  const sent = { type: "session" as const, server: oracle, sessionId: "sent" }
  expect(sidebarDrafts([first, elsewhere, remote, sent, second], oracle, { worktree: "/repo", expanded: true }, undefined)).toEqual([second, first])
})

test("member-directory drafts follow the same catalog project as sent sessions", () => {
  const draft = { type: "draft" as const, draftID: "mobile", server: mini, directory: "/workspace/app" }
  expect(sidebarDrafts([draft], mini, { worktree: "/workspace", expanded: true }, scoped)).toEqual([draft])
  expect(sidebarDrafts([draft], mini, { worktree: "/workspace/api", expanded: true }, scoped)).toEqual([])
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
