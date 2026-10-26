import { Option, Schema } from "effect"
import { pathKey } from "@/workspaces/path-key"

const Entry = Schema.Struct({
  server: Schema.Literals(["oracle", "studio", "mini"]),
  directory: Schema.NonEmptyString,
})
const State = Schema.Struct({ closed: Schema.Array(Entry) })
export type ClosedProject = typeof Entry.Type
export type VisibilityChange = ClosedProject & { closed: boolean }

export function managedServerId(origin: string, url: string) {
  const server = new URL(url)
  if (server.origin !== origin) return
  return /^\/_desk\/server\/(oracle|studio|mini)\/?$/.exec(server.pathname)?.[1] as ClosedProject["server"] | undefined
}

async function responseState(response: Response) {
  if (!response.ok) throw new Error("Could not sync project visibility. Try again.")
  const value = Option.getOrUndefined(Schema.decodeUnknownOption(State)(await response.json()))
  if (!value) throw new Error("Invalid shared project visibility.")
  return value.closed
}

export async function loadProjectVisibility(origin: string) {
  const response = await fetch(new URL("/_desk/projects/visibility", origin), {
    cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(10_000),
  })
  if (response.status === 404) return
  return responseState(response)
}

export async function saveProjectVisibility(origin: string, change: VisibilityChange) {
  return responseState(await fetch(new URL("/_desk/projects/visibility", origin), {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(change), signal: AbortSignal.timeout(10_000),
  }))
}

export function createProjectVisibilitySync(input: {
  load: () => Promise<readonly ClosedProject[] | undefined>
  save: (change: VisibilityChange) => Promise<readonly ClosedProject[]>
  publish: (closed: ClosedProject[]) => void
  error: (error: unknown) => void
}) {
  let current: readonly ClosedProject[] | undefined
  let version = 0
  let request = 0
  let disposed = false
  let queue = Promise.resolve()
  const pending = new Map<string, VisibilityChange & { version: number }>()
  const key = (value: ClosedProject) => `${value.server}:${pathKey(value.directory)}`
  const publish = () => {
    if (!current || disposed) return
    const closed = new Map(current.map((value) => [key(value), value]))
    for (const value of pending.values()) {
      if (value.closed) closed.set(key(value), { server: value.server, directory: value.directory })
      else closed.delete(key(value))
    }
    input.publish([...closed.values()])
  }
  return {
    async refresh() {
      const started = version
      const latest = ++request
      try {
        const loaded = await input.load()
        if (disposed || latest !== request || started !== version || loaded === undefined) return
        current = loaded
        publish()
      } catch { /* Retain the last shared state during a connection outage. */ }
    },
    change(change: VisibilityChange) {
      const next = { ...change, version: ++version }
      pending.set(key(change), next)
      publish()
      const operation = queue.then(async () => {
        try {
          current = await input.save(change)
        } catch (error) {
          if (!disposed) input.error(error)
        } finally {
          version++
          if (pending.get(key(change))?.version === next.version) pending.delete(key(change))
          publish()
        }
      })
      queue = operation
      return operation
    },
    dispose() { disposed = true },
  }
}
