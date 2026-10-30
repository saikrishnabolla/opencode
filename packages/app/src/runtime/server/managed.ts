import { useQuery } from "@tanstack/solid-query"
import { onCleanup } from "solid-js"
import { Option, Schema } from "effect"
import type { ServerConnection } from "./registry"

const ManagedServers = Schema.Struct({
  servers: Schema.Array(Schema.Struct({
    id: Schema.Literals(["oracle", "studio", "mini"]),
    name: Schema.NonEmptyString,
  })),
})

export async function loadManagedServers(origin: string): Promise<ServerConnection.Http[] | undefined> {
  const response = await fetch(new URL("/_desk/servers", origin), {
    cache: "no-store",
    credentials: "same-origin",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined)
  if (!response?.ok || !response.headers.get("content-type")?.includes("application/json")) return
  const data = Option.getOrUndefined(Schema.decodeUnknownOption(ManagedServers)(await response.json().catch(() => undefined)))
  if (!data || data.servers.length === 0) return
  return data.servers.map((server) => ({
    type: "http",
    displayName: server.name,
    http: { url: new URL(`/_desk/server/${server.id}`, origin).href },
  }))
}

const ManagedProjects = Schema.Struct({
  projects: Schema.Array(Schema.Struct({
    server: Schema.Literals(["oracle", "studio", "mini"]),
    name: Schema.NonEmptyString,
    directory: Schema.NonEmptyString,
    group: Schema.optional(Schema.NonEmptyString),
    members: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  })),
  excluded: Schema.Array(Schema.Struct({
    server: Schema.Literals(["oracle", "studio", "mini"]),
    directory: Schema.NonEmptyString,
  })),
})

export type ManagedProjectCatalog = typeof ManagedProjects.Type

export async function loadManagedProjects(origin: string): Promise<ManagedProjectCatalog | undefined> {
  const response = await fetch(new URL("/_desk/projects", origin), {
    cache: "no-store",
    credentials: "same-origin",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined)
  if (!response?.ok || !response.headers.get("content-type")?.includes("application/json")) return
  return Option.getOrUndefined(Schema.decodeUnknownOption(ManagedProjects)(await response.json().catch(() => undefined)))
}

export function managedServerId(origin: string, serverUrl: string) {
  const url = new URL(serverUrl)
  if (url.origin !== origin) return
  return /^\/_desk\/server\/(oracle|studio|mini)\/?$/.exec(url.pathname)?.[1]
}

export const MANAGED_PROJECTS_CHANGED = "desk-projects-changed"

export async function changeManagedProject(origin: string, serverUrl: string, directory: string, method: "POST" | "DELETE") {
  const server = managedServerId(origin, serverUrl)
  if (!server) throw new Error("Choose a connected Desk server.")
  const response = await fetch(new URL("/_desk/projects", origin), {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ server, directory }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error("Could not update the project list. Try again.")
  window.dispatchEvent(new Event(MANAGED_PROJECTS_CHANGED))
}

export function useManagedProjects(enabled: () => boolean) {
  const query = useQuery(() => ({
    queryKey: ["desk-projects", window.location.origin],
    enabled: enabled(),
    queryFn: async () => {
      const catalog = await loadManagedProjects(window.location.origin)
      if (!catalog) throw new Error("Could not load the project list.")
      return catalog
    },
    select: (catalog: ManagedProjectCatalog) => () => catalog,
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    retry: false,
  }))
  const refresh = () => { if (enabled()) void query.refetch() }
  window.addEventListener(MANAGED_PROJECTS_CHANGED, refresh)
  onCleanup(() => window.removeEventListener(MANAGED_PROJECTS_CHANGED, refresh))
  return query
}
