import { expect, test } from "bun:test"
import { createServer } from "node:http"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import { addManagedExperiment, loadManagedProjects, loadManagedServers } from "./managed"

async function fixture(body: string, status = 200, contentType = "application/json") {
  const server = createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "http://localhost:3000")
    res.setHeader("Access-Control-Allow-Credentials", "true")
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", req.headers["access-control-request-headers"] ?? "")

    if (req.method === "OPTIONS") { res.writeHead(204); res.end();

 return }

    res.writeHead(status, { "Content-Type": contentType })
    res.end(body)
  }).listen(0, "127.0.0.1")

  await once(server, "listening")

  // SAFETY: The listening server is explicitly bound to an IPv4 address, so address() returns AddressInfo.
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


test("adds an experiment to the selected managed server without browser credentials", async () => {
  type ReceivedRequest = { path?: string; method?: string; body?: unknown; authorization?: string }

  const received: ReceivedRequest = {}

  const server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "http://localhost:3000")
    res.setHeader("Access-Control-Allow-Credentials", "true")
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "content-type")

    if (req.method === "OPTIONS") { res.writeHead(204); res.end();

 return }

    received.path = req.url
    received.method = req.method
    received.authorization = req.headers.authorization
    const chunks = []

    for await (const chunk of req) chunks.push(chunk)
    received.body = JSON.parse(Buffer.concat(chunks).toString())
    res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}")
  }).listen(0, "127.0.0.1")

  await once(server, "listening")
  // SAFETY: The listening server is explicitly bound to an IPv4 address, so address() returns AddressInfo.
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  try {
    await addManagedExperiment(origin, `${origin}/_desk/server/studio`, "/projects/hackathon")
    expect(received).toEqual({ path: "/_desk/projects/experiments", method: "POST", body: { server: "studio", directory: "/projects/hackathon" }, authorization: undefined })
    await expect(addManagedExperiment(origin, "https://other.example/_desk/server/studio", "/projects/hackathon")).rejects.toThrow("server")
  } finally { server.closeAllConnections(); server.close() }
})

test("keeps a catalog conflict visible instead of treating the folder as added", async () => {
  const { server, origin } = await fixture("{}", 409)

  try { await expect(addManagedExperiment(origin, `${origin}/_desk/server/oracle`, "/projects/existing")).rejects.toThrow("conflict") }
  finally { server.closeAllConnections(); server.close() }
})
