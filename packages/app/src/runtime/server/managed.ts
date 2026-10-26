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

export async function addManagedExperiment(origin: string, serverUrl: string, directory: string): Promise<void> {
  const url = new URL(serverUrl)
  const match = url.origin === origin && /^\/_desk\/server\/(oracle|studio|mini)\/?$/.exec(url.pathname)
  if (!match) throw new Error("Choose a connected Desk server.")
  const response = await fetch(new URL("/_desk/projects/experiments", origin), {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ server: match[1], directory }),
    signal: AbortSignal.timeout(10_000),
  })
  if (response.status === 409) throw new Error("This folder already belongs to another project.")
  if (!response.ok) throw new Error("Could not add the folder. Try again.")
}
