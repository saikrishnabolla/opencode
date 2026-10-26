import http from 'node:http'
import https from 'node:https'
import { readFile, mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { createDeskAuth } from './opencode-desk-auth.mjs'

const origin = 'https://desk.saibolla.com'
const prefix = '/_desk/server/'
const names = { oracle: 'Oracle', studio: 'Studio', mini: 'Mac Mini' }
const projectCatalog = {
  projects: [
    { server: 'oracle', name: 'Ask Nomi', directory: '/home/ubuntu/Documents/GitHub/asknomi', members: ['asknomi', 'asknomi-api', 'asknomi-landing'].map(name => '/home/ubuntu/Documents/GitHub/' + name) },
    { server: 'oracle', name: 'Beyond Visual', directory: '/home/ubuntu/Documents/GitHub/beyondvisual' },
    { server: 'oracle', name: 'General', directory: '/home/ubuntu/Documents/GitHub/personal' },
    { server: 'studio', name: 'Cue', group: 'Experiments', directory: '/Users/saikrishnabolla/Documents/GitHub/cue' },
    { server: 'studio', name: 'Hermes', group: 'Experiments', directory: '/Users/saikrishnabolla/Documents/GitHub/hermes' },
    { server: 'oracle', name: 'OpenCode', group: 'Experiments', directory: '/home/ubuntu/Documents/GitHub/opencode-web' },
  ],
  excluded: [
    { server: 'mini', directory: '/Users/asknomi' },
    { server: 'studio', directory: '/Users/saikrishnabolla' },
    { server: 'oracle', directory: '/home/ubuntu' },
    { server: 'oracle', directory: '/tmp/opencode-connection-check' },
  ],
}
const stripped = new Set(['authorization', 'cookie', 'proxy-authorization', 'forwarded', 'origin', 'host', 'connection', 'transfer-encoding', 'upgrade'])

function projectError(status) { return Object.assign(new Error('Invalid project request'), { status }) }

function experiment(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.server !== 'string' || !Object.hasOwn(names, input.server) || typeof input.directory !== 'string') throw projectError(400)
  const directory = input.directory
  if (directory.length > 4096 || !directory.startsWith('/') || /[\u0000-\u001f\u007f\\]/.test(directory)) throw projectError(400)
  const normalized = posix.normalize(directory).replace(/\/$/, '')
  if (!normalized || normalized === '/') throw projectError(400)
  const name = input.name === undefined ? posix.basename(normalized) : input.name
  if (typeof name !== 'string' || !name.trim() || name.length > 128 || /[\u0000-\u001f\u007f]/.test(name)) throw projectError(400)
  return { server: input.server, name: name.trim(), directory: normalized, group: 'Experiments' }
}

function projectStore(initial = [], save = async () => {}) {
  let entries = []
  let queue = Promise.resolve()
  const existing = entry => [...projectCatalog.projects, ...entries].find(project => project.server === entry.server && project.directory === entry.directory)
  for (const input of initial) {
    const entry = experiment(input)
    const found = existing(entry)
    if (found && found.group !== 'Experiments') throw projectError(409)
    if (!found) entries.push(entry)
  }
  return {
    catalog() { return { ...projectCatalog, projects: [...projectCatalog.projects, ...entries] } },
    add(input) {
      const operation = queue.then(async () => {
        const entry = experiment(input)
        const found = existing(entry)
        if (found) {
          if (found.group !== 'Experiments') throw projectError(409)
          return found
        }
        const next = [...entries, entry]
        await save(next)
        entries = next
        return entry
      })
      queue = operation.catch(() => {})
      return operation
    },
  }
}

export async function createExperimentStore(path) {
  let entries = []
  try { entries = JSON.parse(await readFile(path, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!Array.isArray(entries)) throw new Error('Invalid experiments catalog')
  return projectStore(entries, async next => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = path + '.' + randomUUID() + '.tmp'
    try {
      const file = await open(temporary, 'wx', 0o600)
      try { await file.writeFile(JSON.stringify(next) + '\n'); await file.sync() } finally { await file.close() }
      await rename(temporary, path)
    } finally { await rm(temporary, { force: true }) }
  })
}

function visibilityEntry(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.closed !== 'boolean') throw projectError(400)
  const { server, directory } = experiment({ ...input, name: 'project' })
  return { server, directory }
}

function visibilityStore(initial = [], save = async () => {}) {
  let entries = []
  let queue = Promise.resolve()
  for (const input of initial) {
    const entry = visibilityEntry({ ...input, closed: true })
    if (!entries.some(value => value.server === entry.server && value.directory === entry.directory)) entries.push(entry)
  }
  const read = () => ({ closed: entries })
  return {
    read,
    set(input) {
      const operation = queue.then(async () => {
        const entry = visibilityEntry(input)
        const matches = value => value.server === entry.server && value.directory === entry.directory
        const found = entries.some(matches)
        if (found === input.closed) return read()
        const next = input.closed ? [...entries, entry] : entries.filter(value => !matches(value))
        await save(next)
        entries = next
        return read()
      })
      queue = operation.catch(() => {})
      return operation
    },
  }
}

export async function createProjectVisibilityStore(path) {
  let entries = []
  try { entries = JSON.parse(await readFile(path, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!Array.isArray(entries)) throw new Error('Invalid project visibility state')
  return visibilityStore(entries, async next => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = path + '.' + randomUUID() + '.tmp'
    try {
      const file = await open(temporary, 'wx', 0o600)
      try { await file.writeFile(JSON.stringify(next) + '\n'); await file.sync() } finally { await file.close() }
      await rename(temporary, path)
    } finally { await rm(temporary, { force: true }) }
  })
}

async function readProject(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw projectError(415)
  const chunks = []
  let size = 0
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > 8192) { req.resume(); throw projectError(413) }
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw projectError(400) }
}

export function createGateway(connections, web = 'http://127.0.0.1:49375', auth, projects = projectStore(), visibility = visibilityStore()) {
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
    const authRoute = pathname === '/_desk/login' || /^\/_desk\/setup\/[A-Za-z0-9_-]+$/.test(pathname)
    if (req.headers.origin && req.headers.origin !== origin) return { status: 403 }
    if (protectedRoute && !(authRoute && req.method === 'GET') && req.headers['sec-fetch-site'] === 'cross-site') return { status: 403 }
    if ((upgrade || !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) && req.headers.origin !== origin) return { status: 403 }
    if (authRoute && !upgrade) return { authRoute: true }
    if (pathname === '/_desk/servers' && req.url.split('?')[0] === pathname && !upgrade && req.method === 'GET') return { metadata: true }
    if (pathname === '/_desk/projects' && req.url === pathname && !upgrade && req.method === 'GET') return { projects: true }
    if (pathname === '/_desk/projects/experiments' && req.url === pathname && !upgrade && req.method === 'POST') return { addExperiment: true }
    if (pathname === '/_desk/projects/visibility' && req.url === pathname && !upgrade && req.method === 'GET') return { visibility: true }
    if (pathname === '/_desk/projects/visibility' && req.url === pathname && !upgrade && req.method === 'POST') return { setVisibility: true }
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
    // Desk authentication needs network navigation rather than an offline app shell.
    if (req.url === '/sw.js' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' })
      res.end("self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',event=>event.waitUntil(self.registration.unregister()));")
      return
    }
    if (auth && await auth.handle(req, res)) return
    if (auth && !auth.authenticated(req)) {
      if (route.projects || route.addExperiment || route.visibility || route.setVisibility) return fail(401)
      return auth.challenge(req, res)
    }
    if (route.authRoute) {
      if (!auth && req.method === 'GET') { res.writeHead(303, { Location: '/', 'Cache-Control': 'no-store' }); res.end(); return }
      return fail(404)
    }
    if (route.metadata || route.projects) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
      res.end(JSON.stringify(route.projects ? projects.catalog() : { servers: Object.entries(names).map(([id, name]) => ({ id, name })) }))
      return
    }
    if (route.visibility || route.setVisibility) {
      try {
        const state = route.setVisibility ? await visibility.set(await readProject(req)) : visibility.read()
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
        res.end(JSON.stringify(state))
      } catch (error) { fail(error.status || 500) }
      return
    }
    if (route.addExperiment) {
      try {
        const project = await projects.add(await readProject(req))
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
        res.end(JSON.stringify(project))
      } catch (error) { fail(error.status || 500) }
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
    if (auth && !auth.authenticated(req)) route.status = 401
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
  const auth = process.env.DESK_AUTH_MODE === 'tailscale' ? undefined : await createDeskAuth(process.env.DESK_AUTH_FILE)
  const projects = await createExperimentStore(join(dirname(process.env.DESK_CONNECTIONS_FILE), 'experiments.json'))
  const visibility = await createProjectVisibilityStore(join(dirname(process.env.DESK_CONNECTIONS_FILE), 'project-visibility.json'))
  createGateway(config, undefined, auth, projects, visibility).listen(49377, '127.0.0.1', () => console.log('Private OpenCode gateway ready'))
}
