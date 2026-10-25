import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { readFile, writeFile, rename } from 'node:fs/promises'

const cookieName = '__Host-desk'
const lifetime = 30 * 24 * 60 * 60
const equal = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
const headers = {
  'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
}

export async function createDeskAuth(path) {
  const state = JSON.parse(await readFile(path, 'utf8'))
  if (!state.key || (!state.setup && !state.hash)) throw new Error('Desk sign-in is not configured')
  const failures = []
  let settingUp = false
  const sign = value => createHmac('sha256', state.key).update(value).digest('base64url')
  const session = () => {
    const value = `${Math.floor(Date.now() / 1000)}.${randomBytes(24).toString('base64url')}`
    return `${cookieName}=${value}.${sign(value)}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${lifetime}`
  }
  const authenticated = req => {
    const token = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1)
    if (!token || !state.hash) return false
    const [time, nonce, signature, ...extra] = token.split('.')
    if (extra.length || !nonce || !signature) return false
    const age = Math.floor(Date.now() / 1000) - Number(time)
    return Number.isFinite(age) && age >= 0 && age < lifetime && equal(signature, sign(`${time}.${nonce}`))
  }
  const page = (res, setup, action, failed = false, status = 200) => {
    res.writeHead(status, headers)
    res.end(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Desk</title><style>body{margin:0;background:#101011;color:#eee;font:16px system-ui;display:grid;min-height:100dvh;place-items:center}main{width:min(340px,85vw)}h1{font-size:26px}p{color:#aaa;line-height:1.5}label{display:block;margin:20px 0 8px}input,button{box-sizing:border-box;width:100%;padding:13px;border:1px solid #444;border-radius:10px;font:inherit}input{background:#202023;color:#fff}button{margin-top:24px;background:#eee;color:#111;cursor:pointer}.error{color:#ffb4b4}</style><main><h1>${setup ? 'Set your Desk password' : 'Sign in to Desk'}</h1><p>${setup ? 'Choose one password for this private website. Your three servers will connect automatically.' : 'Your servers are ready. Enter your Desk password to continue.'}</p>${failed ? '<p class="error">'+(setup ? 'Use matching passwords with at least 12 characters.' : 'Could not sign in. Check your password or try again in a minute.')+'</p>' : ''}<form method="post" action="${action}"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" ${setup ? 'minlength="12"' : ''} required autofocus>${setup ? '<label for="confirm">Confirm password</label><input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="12" required>' : ''}<button>${setup ? 'Save password and continue' : 'Sign in'}</button></form></main></html>`)
  }
  return {
    authenticated,
    challenge(req, res) {
      if (req.url.startsWith('/_desk/server/') || req.url === '/_desk/servers') {
        res.writeHead(401, { 'Cache-Control': 'no-store' }); res.end(); return
      }
      page(res, false, '/_desk/login')
    },
    async handle(req, res) {
      const setup = !!state.setup && req.url === '/_desk/setup/' + state.setup
      if (!setup && req.url !== '/_desk/login') return false
      if (req.method === 'GET') { page(res, setup, setup ? '/_desk/setup/' + state.setup : '/_desk/login'); return true }
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return true }
      while (failures.length && failures[0] < Date.now() - 60_000) failures.shift()
      if (failures.length >= 10) { page(res, setup, req.url, true, 429); return true }
      if (!req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) { res.writeHead(415); res.end(); return true }
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > 4096) { res.writeHead(413); res.end(); return true }
        chunks.push(chunk)
      }
      const values = new URLSearchParams(Buffer.concat(chunks).toString())
      const password = values.get('password') ?? ''
      const validSetup = setup && !settingUp && password.length >= 12 && password === values.get('confirm')
      const validLogin = !setup && state.hash && equal(scryptSync(password, state.salt, 32).toString('hex'), state.hash)
      if (!validSetup && !validLogin) { failures.push(Date.now()); page(res, setup, req.url, true, 401); return true }
      if (validSetup) {
        settingUp = true
        const next = { key: state.key, salt: randomBytes(16).toString('hex') }
        next.hash = scryptSync(password, next.salt, 32).toString('hex')
        await writeFile(path + '.tmp', JSON.stringify(next) + '\n', { mode: 0o600 })
        await rename(path + '.tmp', path)
        Object.assign(state, next); delete state.setup
        settingUp = false
      }
      failures.length = 0
      res.writeHead(303, { Location: '/', 'Set-Cookie': session(), 'Cache-Control': 'no-store' }); res.end()
      return true
    },
  }
}
