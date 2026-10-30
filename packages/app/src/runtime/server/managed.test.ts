import { expect, test } from "bun:test"
import { createServer } from "node:http"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import { loadManagedServers } from "./managed"

async function fixture(body: string, status = 200, contentType = "application/json") {
  const server = createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "http://localhost:3000")
    res.setHeader("Access-Control-Allow-Credentials", "true")
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", req.headers["access-control-request-headers"] ?? "")
    if (req.method === "OPTIONS") {
      res.writeHead(204)
      res.end()
      return
    }
    res.writeHead(status, { "Content-Type": contentType })
    res.end(body)
  }).listen(0, "127.0.0.1")
  await once(server, "listening")
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

test("loads central server connections without browser credentials", async () => {
  const { server, origin } = await fixture(
    JSON.stringify({
      servers: [
        { id: "oracle", name: "Oracle" },
        { id: "studio", name: "Studio" },
        { id: "mini", name: "Mac Mini" },
      ],
    }),
  )
  try {
    expect(await loadManagedServers(origin)).toEqual([
      { type: "http", displayName: "Oracle", http: { url: `${origin}/_desk/server/oracle` } },
      { type: "http", displayName: "Studio", http: { url: `${origin}/_desk/server/studio` } },
      { type: "http", displayName: "Mac Mini", http: { url: `${origin}/_desk/server/mini` } },
    ])
  } finally {
    server.closeAllConnections()
    server.close()
  }
})

test("keeps normal OpenCode startup when central discovery is absent or invalid", async () => {
  for (const [body, status, contentType] of [
    ["not found", 404, "text/plain"],
    ["<html></html>", 200, "text/html"],
    [JSON.stringify({ servers: [{ id: "unexpected", name: "Invalid" }] }), 200, "application/json"],
    ["{", 200, "application/json"],
  ] as const) {
    const { server, origin } = await fixture(body, status, contentType)
    try {
      expect(await loadManagedServers(origin)).toBeUndefined()
    } finally {
      server.closeAllConnections()
      server.close()
    }
  }
})
