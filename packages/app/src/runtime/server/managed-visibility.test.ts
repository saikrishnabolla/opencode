import { expect, test } from "bun:test"
import { createProjectVisibilitySync, managedServerId, type ClosedProject } from "./managed-visibility"

const hermes = { server: "studio" as const, directory: "/projects/hermes" }
const oracle = { server: "oracle" as const, directory: "/projects/other" }
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

test("close and reopen synchronize between independent clients while preserving other projects", async () => {
  let saved: readonly ClosedProject[] = [oracle]
  const published: ClosedProject[][] = [[], []]
  const clients = [0, 1].map((index) => createProjectVisibilitySync({
    load: async () => [...saved],
    save: async (change) => {
      saved = saved.filter((item) => item.server !== change.server || item.directory !== change.directory)
      if (change.closed) saved = [...saved, { server: change.server, directory: change.directory }]
      return saved
    },
    publish: (state) => { published[index] = state },
    error: (error) => { throw error },
  }))
  await clients[0]!.refresh()
  await clients[0]!.change({ ...hermes, closed: true })
  await clients[1]!.refresh()
  expect(published[1]).toEqual([oracle, hermes])
  await clients[1]!.change({ ...hermes, closed: false })
  await clients[0]!.refresh()
  expect(published).toEqual([[oracle], [oracle]])
})

test("a refresh begun before a close cannot restore a project from stale state", async () => {
  const old = deferred<readonly ClosedProject[]>()
  let published: ClosedProject[] = []
  const client = createProjectVisibilitySync({
    load: () => old.promise,
    save: async () => [hermes],
    publish: (state) => { published = state },
    error: (error) => { throw error },
  })
  const refresh = client.refresh()
  await client.change({ ...hermes, closed: true })
  old.resolve([])
  await refresh
  expect(published).toEqual([hermes])
})

test("a slower older poll cannot replace a newer poll result", async () => {
  const old = deferred<readonly ClosedProject[]>()
  let calls = 0
  let published: ClosedProject[] = []
  const client = createProjectVisibilitySync({
    load: () => ++calls === 1 ? old.promise : Promise.resolve([hermes]),
    save: async () => [],
    publish: (state) => { published = state },
    error: (error) => { throw error },
  })
  const refresh = client.refresh()
  await client.refresh()
  old.resolve([])
  await refresh
  expect(published).toEqual([hermes])
})

test("rapid close then reopen stays open while serialized saves finish", async () => {
  const firstSave = deferred<readonly ClosedProject[]>()
  let saves = 0
  const seen: ClosedProject[][] = []
  const client = createProjectVisibilitySync({
    load: async () => [],
    save: () => ++saves === 1 ? firstSave.promise : Promise.resolve([]),
    publish: (state) => { seen.push(state) },
    error: (error) => { throw error },
  })
  await client.refresh()
  const closing = client.change({ ...hermes, closed: true })
  const opening = client.change({ ...hermes, closed: false })
  const afterOpen = seen.length
  firstSave.resolve([hermes])
  await Promise.all([closing, opening])
  expect(seen.slice(afterOpen).every((state) => state.length === 0)).toBe(true)
  expect(saves).toBe(2)
})

test("failed writes roll back to shared state and report the failure", async () => {
  const errors: unknown[] = []
  let published: ClosedProject[] = []
  const error = new Error("offline")
  const client = createProjectVisibilitySync({
    load: async () => [],
    save: async () => { throw error },
    publish: (state) => { published = state },
    error: (value) => { errors.push(value) },
  })
  await client.refresh()
  await client.change({ ...hermes, closed: true })
  expect(published).toEqual([])
  expect(errors).toEqual([error])
})

test("ordinary connections do not acquire Desk visibility synchronization", () => {
  expect(managedServerId("https://desk.example", "https://desk.example/_desk/server/studio")).toBe("studio")
  expect(managedServerId("https://desk.example", "https://other.example/_desk/server/studio")).toBeUndefined()
  expect(managedServerId("https://desk.example", "https://desk.example/ordinary")).toBeUndefined()
})


test("a poll started during a write cannot undo the completed write", async () => {
  const save = deferred<readonly ClosedProject[]>()
  const poll = deferred<readonly ClosedProject[]>()
  let loads = 0
  let published: ClosedProject[] = []
  const client = createProjectVisibilitySync({
    load: () => ++loads === 1 ? Promise.resolve([]) : poll.promise,
    save: () => save.promise,
    publish: (state) => { published = state },
    error: (error) => { throw error },
  })
  await client.refresh()
  const closing = client.change({ ...hermes, closed: true })
  const refresh = client.refresh()
  save.resolve([hermes])
  await closing
  expect(published).toEqual([hermes])
  poll.resolve([])
  await refresh
  expect(published).toEqual([hermes])
})
