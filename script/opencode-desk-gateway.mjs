import http from 'node:http'
import https from 'node:https'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const origin = 'https://desk.saibolla.com'
const prefix = '/_desk/server/'
const names = { oracle: 'Oracle', studio: 'Studio', mini: 'Mac Mini' }
const stripped = new Set(['authorization', 'cookie', 'proxy-authorization', 'forwarded', 'origin', 'host', 'connection', 'transfer-encoding', 'upgrade'])

export function createGateway(connections, web = 'http://127.0.0.1:49375') {
  const targets = Object.fromEntries(Object.keys(names).map(id => {
    const value = connections[id]
    if (!value?.password || !URL.canParse(value.url)) throw new Error(`Missing connection: ${id}`)
    const url = new URL(value.url)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(`Invalid connection: ${id}`)
    return [id, { url, authorization: `Basic ${Buffer.from(`opencode:${value.password}`).toString('base64')}` }]
  }))

  function select(req, upgrade = false) {
    if (!['desk.saibolla.com', 'desk.saibolla.com:443'].includes(req.headers.host)) return { status: 404 }
    if (!req.url.startsWith('/') || req.url.startsWith('//')) return { status: 400 }
    let pathname
    try { pathname = decodeURIComponent(req.url.split('?')[0]) } catch { return { status: 400 } }
    if (pathname.includes('\\') || pathname.split('/').some(part => part === '.' || part === '..')) return { status: 400 }
    const protectedRoute = pathname.startsWith('/_desk/')
    if (req.headers.origin && req.headers.origin !== origin) return { status: 403 }
    if (protectedRoute && req.headers['sec-fetch-site'] === 'cross-site') return { status: 403 }
    if ((upgrade || !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) && req.headers.origin !== origin) return { status: 403 }
    if (req.url.startsWith(prefix)) {
      const match = /^\/_desk\/server\/(oracle|studio|mini)(\/api(?:[/?].*)?)$/.exec(req.url)
      if (!match) return { status: 404 }
      return { target: targets[match[1]], path: match[2] }
    }
    if (protectedRoute || upgrade) return { status: 404 }
    // The web server's API proxy must never bypass the managed connection routes.
    if (/^\/(api|auth)(?:\/|$)/.test(pathname)) return { status: 404 }
    return { target: { url: new URL(web) }, path: req.url }
  }

  function request(req, route, upgrade) {
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !stripped.has(name) && !name.startsWith('x-forwarded-')))
    headers.host = route.target.url.host
    if (route.target.authorization) headers.authorization = route.target.authorization
    if (upgrade) { headers.connection = 'Upgrade'; headers.upgrade = 'websocket' }
    const upstream = route.target.url
    return (upstream.protocol === 'https:' ? https : http).request({
      protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port || undefined,
      path: upstream.pathname.replace(/\/$/, '') + route.path, method: req.method, headers,
    })
  }

  const server = http.createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'Cache-Control': 'no-store' })
      res.end()
    })
  })
  async function handle(req, res) {
    const route = select(req)
    const fail = status => { res.writeHead(status, { 'Cache-Control': 'no-store' }); res.end() }
    if (route.status) return fail(route.status)
    // Always load the current frontend instead of a previously cached app shell.
    if (req.url === '/sw.js' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' })
      res.end("self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',event=>event.waitUntil(self.registration.unregister()));")
      return
    }
    const upstream = request(req, route)
    upstream.on('response', response => {
      if (route.target.authorization && response.statusCode >= 300 && response.statusCode < 400) {
        response.resume(); fail(502); return
      }
      const headers = { ...response.headers }
      delete headers['set-cookie']
      delete headers['access-control-allow-origin']
      delete headers['access-control-allow-credentials']
      if (route.target.authorization) headers['cache-control'] = 'no-store'
      res.writeHead(response.statusCode, headers)
      response.pipe(res)
    })
    upstream.on('error', () => { if (!res.headersSent) fail(502); else res.destroy() })
    upstream.setTimeout(60 * 60 * 1000, () => upstream.destroy())
    req.on('aborted', () => upstream.destroy())
    res.on('close', () => upstream.destroy())
    req.pipe(upstream)
  }

  server.on('upgrade', (req, socket, head) => {
    const route = select(req, true)
    if (route.status) { socket.end(`HTTP/1.1 ${route.status} Rejected\r\nConnection: close\r\n\r\n`); return }
    const upstream = request(req, route, true)
    upstream.on('upgrade', (response, remote, incoming) => {
      const headers = Object.entries(response.headers).filter(([name]) => !['set-cookie', 'authorization'].includes(name))
      socket.write('HTTP/1.1 101 Switching Protocols\r\n' + headers.map(([key, value]) => `${key}: ${value}`).join('\r\n') + '\r\n\r\n')
      if (head.length) remote.write(head)
      if (incoming.length) socket.write(incoming)
      remote.pipe(socket); socket.pipe(remote)
      socket.on('error', () => remote.destroy()); remote.on('error', () => socket.destroy())
      socket.on('close', () => remote.destroy()); remote.on('close', () => socket.destroy())
    })
    upstream.on('response', response => { response.resume(); socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n') })
    upstream.on('error', () => socket.destroy())
    socket.on('close', () => upstream.destroy())
    upstream.end()
  })
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(await readFile(process.env.DESK_CONNECTIONS_FILE, 'utf8'))
  if (process.env.DESK_AUTH_MODE !== 'tailscale') throw new Error('Private Tailscale deployment required')
  createGateway(config).listen(49377, '127.0.0.1', () => console.log('Private OpenCode gateway ready'))
}
