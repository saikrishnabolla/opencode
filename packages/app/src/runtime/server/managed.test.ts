import { expect, test } from "bun:test"
import { createServer } from "node:http"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import { changeManagedProject, loadManagedProjects, loadManagedServers } from "./managed"

async function fixture(body: string, status = 200, contentType = "application/json") {
  const server = createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "http://localhost:3000")
    res.setHeader("Access-Control-Allow-Credentials", "true")
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", req.headers["access-control-request-headers"] ?? "")
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return }
    res.writeHead(status, { "Content-Type": contentType })
    res.end(body)
  }).listen(0, "127.0.0.1")
  await once(server, "listening")
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

test("loads central server connections without browser credentials", async () => {
  const { server, origin } = await fixture(JSON.stringify({ servers: [
    { id: "oracle", name: "Oracle" },
    { id: "studio", name: "Studio" },
    { id: "mini", name: "Mac Mini" },
  ] }))
  try {
    expect(await loadManagedServers(origin)).toEqual([
      { type: "http", displayName: "Oracle", http: { url: `${origin}/_desk/server/oracle` } },
      { type: "http", displayName: "Studio", http: { url: `${origin}/_desk/server/studio` } },
      { type: "http", displayName: "Mac Mini", http: { url: `${origin}/_desk/server/mini` } },
    ])
  } finally { server.closeAllConnections(); server.close() }
})

test("keeps normal OpenCode startup when central discovery is absent or invalid", async () => {
  for (const [body, status, contentType] of [
    ["not found", 404, "text/plain"],
    ["<html></html>", 200, "text/html"],
    [JSON.stringify({ servers: [{ id: "unexpected", name: "Invalid" }] }), 200, "application/json"],
    ["{", 200, "application/json"],
  ] as const) {
    const { server, origin } = await fixture(body, status, contentType)
    try { expect(await loadManagedServers(origin)).toBeUndefined() }
    finally { server.closeAllConnections(); server.close() }
  }
})


test("loads a shared project catalog and rejects invalid server identities", async () => {
  const catalog = { projects: [{ server: "mini", name: "AskNomi", directory: "/workspace", group: "Experiments", members: ["/workspace/app"] }], excluded: [{ server: "mini", directory: "/home" }] } as const
  for (const [body, expected] of [[catalog, catalog], [{ ...catalog, projects: [{ ...catalog.projects[0], server: "unknown" }] }, undefined]] as const) {
    const { server, origin } = await fixture(JSON.stringify(body))
    try { expect(await loadManagedProjects(origin)).toEqual(expected) }
    finally { server.closeAllConnections(); server.close() }
  }
})

test("keeps the normal sidebar when the shared project endpoint is absent", async () => {
  const { server, origin } = await fixture("not found", 404, "text/plain")
  try { expect(await loadManagedProjects(origin)).toBeUndefined() }
  finally { server.closeAllConnections(); server.close() }
})


test("adds and removes shared projects without browser credentials", async () => {
  const received: { path?: string; method?: string; body?: unknown; authorization?: string } = {}
  const server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "http://localhost:3000")
    res.setHeader("Access-Control-Allow-Credentials", "true")
    res.setHeader("Access-Control-Allow-Methods", "POST, DELETE, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "content-type")
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return }
    received.path = req.url
    received.method = req.method
    received.authorization = req.headers.authorization
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    received.body = JSON.parse(Buffer.concat(chunks).toString())
    res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}")
  }).listen(0, "127.0.0.1")
  await once(server, "listening")
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    for (const method of ["POST", "DELETE"] as const) {
      await changeManagedProject(origin, `${origin}/_desk/server/studio`, "/projects/hackathon", method)
      expect(received).toEqual({ path: "/_desk/projects", method, body: { server: "studio", directory: "/projects/hackathon" }, authorization: undefined })
    }
    await expect(changeManagedProject(origin, "https://other.example/_desk/server/studio", "/projects/hackathon", "DELETE")).rejects.toThrow("Choose a connected Desk server.")
  } finally { server.closeAllConnections(); server.close() }
})

test("reports a failed shared-list update instead of treating it as saved", async () => {
  const { server, origin } = await fixture("{}", 503)
  try { await expect(changeManagedProject(origin, `${origin}/_desk/server/oracle`, "/projects/existing", "DELETE")).rejects.toThrow("Could not update") }
  finally { server.closeAllConnections(); server.close() }
})
