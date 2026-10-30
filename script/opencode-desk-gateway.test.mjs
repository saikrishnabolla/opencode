import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { createGateway } from './opencode-desk-gateway.mjs'

let upstreamRequests = 0
const upstream = http.createServer((req, res) => {
  upstreamRequests++
  if (req.url === '/api/redirect') { res.writeHead(302, { Location: 'https://example.com' }); res.end(); return }
  if (req.url === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders()
    res.write('data: first\n\n'); setTimeout(() => res.end('data: second\n\n'), 100); return
  }
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ path: req.url, headers: req.headers }))
})
upstream.on('upgrade', (req, socket) => {
  assert.equal(req.headers.authorization, 'Basic '+Buffer.from('opencode:test-only').toString('base64'))
  socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
  socket.on('data', bytes => socket.write(bytes))
})
upstream.listen(0,'127.0.0.1'); await once(upstream,'listening')
const url = `http://127.0.0.1:${upstream.address().port}`
const gateway = createGateway(Object.fromEntries(['oracle','studio','mini'].map(id=>[id,{url,password:'test-only'}])),url)
gateway.listen(0,'127.0.0.1'); await once(gateway,'listening')
const port = gateway.address().port
const sockets = new Set()
for (const server of [upstream,gateway]) server.on('connection',socket=> {sockets.add(socket);socket.on('close',()=>sockets.delete(socket))})
const origin = 'https://desk.saibolla.com'
const call = (path, headers={}, method='GET', body, targetPort=port) => new Promise((resolve,reject)=> {
 const req=http.request({host:'127.0.0.1',port:targetPort,path,method,headers:{host:'desk.saibolla.com',...(body === undefined ? {} : {'content-length':Buffer.byteLength(body)}),...headers}},res=> {
  let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}))
 });req.on('error',reject);req.end(body)
})

test('retires the offline worker without causing a page reload loop',async()=> {
 const res=await call('/sw.js');assert.equal(res.status,200)
 assert.match(res.body,/registration.unregister/)
 assert.doesNotMatch(res.body,/client.navigate|clients.matchAll/)
 assert.equal(res.headers['cache-control'],'no-store')
})
test('rejects retired catalog and metadata routes without touching backends',async()=> {
 const before=upstreamRequests
 for(const path of ['/_desk/servers','/_desk/servers?legacy=true','/_desk/projects','/_desk/projects?legacy=true','/_desk/projects/visibility','/_desk/projects/experiments']) {
  for(const method of ['GET','POST','DELETE']) {
   const res=await call(path,{origin,'content-type':'application/json'},method)
   assert.equal(res.status,404)
   assert.equal(res.headers['cache-control'],'no-store')
  }
 }
 assert.equal(upstreamRequests,before)
})
test('injects server auth and strips caller credentials, cookies and forwarded headers',async()=> {
 const res=await call('/_desk/server/mini/api/info',{origin,authorization:'Basic attacker',cookie:'secret',forwarded:'x','x-forwarded-host':'evil'})
 assert.equal(res.status,200)
 const data=JSON.parse(res.body);assert.equal(data.path,'/api/info')
 assert.equal(data.headers.authorization,'Basic '+Buffer.from('opencode:test-only').toString('base64'))
 for(const key of ['cookie','forwarded','x-forwarded-host','origin']) assert.equal(data.headers[key],undefined)
})
test('rejects cross-site requests, unknown upstreams, traversal and direct API bypass',async()=> {
 const cases=[['/_desk/servers',{host:'evil'},'GET',404],['/_desk/servers',{origin:'https://evil.test'},'GET',403],['/_desk/servers',{'sec-fetch-site':'cross-site'},'GET',403],['/_desk/server/mini/api/session',{},'POST',403],['/_desk/server/other/api/info',{},'GET',404],['/_desk/server/mini/%2e%2e/api/info',{},'GET',400],['/_desk/server/mini/api/%5csecret',{},'GET',400],['http://evil.test/api/info',{},'GET',400],['/_desk/login',{},'GET',404],['/_desk/setup/retired',{},'GET',404],['/api/info',{},'GET',404],['/%61pi/info',{},'GET',404],['/%61uth/connect',{},'GET',404]]
 for(const [path,headers,method,status] of cases) assert.equal((await call(path,headers,method)).status,status,path)
})
test('does not redirect authenticated requests to an external target',async()=> {
 const res=await call('/_desk/server/oracle/api/redirect');assert.equal(res.status,502);assert.equal(res.headers.location,undefined)
})
test('streams events before the upstream finishes',async()=> {
 await new Promise((resolve,reject)=>http.get({host:'127.0.0.1',port,path:'/_desk/server/oracle/api/events',headers:{host:'desk.saibolla.com'}},res=> {
  let first=true;res.on('data',chunk=>{if(first){assert.equal(chunk.toString(),'data: first\n\n');first=false}});res.on('end',resolve)
 }).on('error',reject))
})
test('upgrades WebSockets only for the exact trusted origin',async()=> {
 await new Promise((resolve,reject)=> {
  const req=http.request({host:'127.0.0.1',port,path:'/_desk/server/studio/api/pty/test/connect',headers:{host:'desk.saibolla.com',origin,connection:'Upgrade',upgrade:'websocket'}})
  req.on('upgrade',(res,socket)=>{socket.write('echo');socket.once('data',chunk=>{assert.equal(chunk.toString(),'echo');socket.destroy();resolve()})});req.on('error',reject);req.end()
 })
 const status=await new Promise((resolve,reject)=> {
  const req=http.request({host:'127.0.0.1',port,path:'/_desk/server/studio/api/pty/test/connect',headers:{host:'desk.saibolla.com',origin:'https://evil.test',connection:'Upgrade',upgrade:'websocket'}})
  req.on('response',res=>{res.resume();resolve(res.statusCode)});req.on('error',reject);req.end()
 });assert.equal(status,403)
})
test.after(()=> {for(const socket of sockets) socket.destroy();gateway.closeAllConnections();gateway.close();upstream.closeAllConnections();upstream.close()})
