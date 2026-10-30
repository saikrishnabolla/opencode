import { Option, Schema } from "effect"
import type { ServerConnection } from "./registry"

const ManagedServers = Schema.Struct({
  servers: Schema.Array(
    Schema.Struct({
      id: Schema.Literals(["oracle", "studio", "mini"]),
      name: Schema.NonEmptyString,
    }),
  ),
})

export async function loadManagedServers(origin: string): Promise<ServerConnection.Http[] | undefined> {
  const response = await fetch(new URL("/_desk/servers", origin), {
    cache: "no-store",
    credentials: "same-origin",
    signal: AbortSignal.timeout(3_000),
  }).catch(() => undefined)
  if (!response?.ok || !response.headers.get("content-type")?.includes("application/json")) return
  const data = Option.getOrUndefined(
    Schema.decodeUnknownOption(ManagedServers)(await response.json().catch(() => undefined)),
  )
  if (!data || data.servers.length === 0) return
  return data.servers.map((server) => ({
    type: "http",
    displayName: server.name,
    http: { url: new URL(`/_desk/server/${server.id}`, origin).href },
  }))
}
