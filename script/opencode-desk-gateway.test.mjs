import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeskAuth } from './opencode-desk-auth.mjs'
import { createGateway, createExperimentStore } from './opencode-desk-gateway.mjs'

const upstream = http.createServer((req, res) => {
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
 const req=http.request({host:'127.0.0.1',port:targetPort,path,method,headers:{host:'desk.saibolla.com',...headers}},res=> {
  let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}))
 });req.on('error',reject);req.end(body)
})

test('metadata contains only fixed server identities, never credentials',async()=> {
 const res=await call('/_desk/servers'); assert.equal(res.status,200)
 assert.deepEqual(JSON.parse(res.body).servers.map(s=>s.id),['oracle','studio','mini'])
 assert.equal(res.body.includes('test-only'),false);assert.equal(res.headers['cache-control'],'no-store')
})
test('shares default projects and experiment repositories without backend credentials',async()=> {
 const res=await call('/_desk/projects');assert.equal(res.status,200)
 const catalog=JSON.parse(res.body)
 assert.deepEqual(catalog.projects.map(p=>[p.name,p.server]),[['Ask Nomi','mini'],['Beyond Visual','oracle'],['General','oracle'],['Cue','studio'],['Hermes','studio'],['OpenCode','oracle']])
 assert.deepEqual(catalog.projects.filter(p=>p.group==='Experiments').map(p=>[p.name,p.server,p.directory]), [
  ['Cue','studio','/Users/saikrishnabolla/Documents/GitHub/cue'],
  ['Hermes','studio','/Users/saikrishnabolla/Documents/GitHub/hermes'],
  ['OpenCode','oracle','/home/ubuntu/Documents/GitHub/opencode-web'],
 ])
 assert.equal(catalog.projects[0].members.length,3)
 assert.equal(catalog.excluded.length,4)
 assert.equal(res.body.includes('test-only'),false)
 assert.equal(res.headers['cache-control'],'no-store')
})
test('retires the offline worker without causing a page reload loop',async()=> {
 const res=await call('/sw.js');assert.equal(res.status,200)
 assert.match(res.body,/registration.unregister/)
 assert.doesNotMatch(res.body,/client.navigate|clients.matchAll/)
 assert.equal(res.headers['cache-control'],'no-store')
})
test('adds shared experiments persistently, keeps additions idempotent and serializes concurrent saves',async()=> {
 const directory=await mkdtemp(join(tmpdir(),'desk-projects-'))
 const path=join(directory,'private','experiments.json')
 const store=await createExperimentStore(path)
 const projectGateway=createGateway(Object.fromEntries(['oracle','studio','mini'].map(id=>[id,{url,password:'test-only'}])),url,undefined,store)
 projectGateway.listen(0,'127.0.0.1');await once(projectGateway,'listening')
 const request=(path,headers={},method='GET',body)=>call(path,headers,method,body,projectGateway.address().port)
 const add=(input,headers={origin,'content-type':'application/json'})=>request('/_desk/projects/experiments',headers,'POST',JSON.stringify(input))
 try {
  const input={server:'studio',directory:'/Users/test/hackathons/',name:'Hackathons'}
  const first=await add(input);assert.equal(first.status,200)
  assert.deepEqual(JSON.parse(first.body),{server:'studio',directory:'/Users/test/hackathons',name:'Hackathons',group:'Experiments'})
  assert.equal((await add(input)).status,200)
  const concurrent=await Promise.all(['One','Two'].map(name=>add({server:'oracle',directory:'/work/'+name})))
  assert.deepEqual(concurrent.map(result=>result.status),[200,200])
  const catalog=JSON.parse((await request('/_desk/projects')).body)
  assert.equal(catalog.projects.length,9)
  assert.equal(catalog.projects.filter(project=>project.name==='Hackathons').length,1)
  const reloaded=await createExperimentStore(path)
  assert.deepEqual(reloaded.catalog(),catalog)
  assert.equal((await stat(path)).mode & 0o777,0o600)
  assert.equal((await add({server:'oracle',directory:'/home/ubuntu/Documents/GitHub/personal'})).status,409)
  assert.equal((await add({server:'mini',directory:'/Users/asknomi/Documents/GitHub'})).status,409)
  assert.equal((await add({server:'studio',directory:'/Users/saikrishnabolla/Documents/GitHub/cue'})).status,200)
  assert.equal((await reloaded.add({server:'oracle',directory:'/work/After reload'})).name,'After reload')
 } finally {projectGateway.closeAllConnections();projectGateway.close();await rm(directory,{recursive:true,force:true})}
})
test('validates experiment writes and rejects cross-site or oversized requests before changing the catalog',async()=> {
 const endpoint='/_desk/projects/experiments'
 const headers={origin,'content-type':'application/json'}
 for(const input of [null,[],{}, {server:'unknown',directory:'/work/hack'}, {server:'__proto__',directory:'/work/hack'}, {server:'studio',directory:'relative'}, {server:'studio',directory:'/'}, {server:'studio',directory:'/foo/..'}, {server:'studio',directory:'/work/\u0000bad'}, {server:'studio',directory:'/work/\nbad'}, {server:'studio',directory:'/work/\\bad'}]) {
  assert.equal((await call(endpoint,headers,'POST',JSON.stringify(input))).status,400)
 }
 const body=JSON.stringify({server:'studio',directory:'/work/Hackathon'})
 for(const requestHeaders of [{...headers,origin:'https://evil.test'}, {'content-type':'application/json'}, {...headers,'sec-fetch-site':'cross-site'}]) {
  assert.equal((await call(endpoint,requestHeaders,'POST',body)).status,403)
 }
 assert.equal((await call(endpoint,{...headers,host:'evil.test'},'POST',body)).status,404)
 assert.equal((await call(endpoint,{origin,'content-type':'text/plain'},'POST',body)).status,415)
 assert.equal((await call(endpoint,headers,'POST','{')).status,400)
 assert.equal((await call(endpoint,headers,'POST',JSON.stringify({server:'studio',directory:'/'+ 'a'.repeat(9000)}))).status,413)
 assert.equal(JSON.parse((await call('/_desk/projects')).body).projects.length,6)
})
test('injects server auth and strips caller credentials, cookies and forwarded headers',async()=> {
 const res=await call('/_desk/server/mini/api/info',{origin,authorization:'Basic attacker',cookie:'secret',forwarded:'x','x-forwarded-host':'evil'})
 assert.equal(res.status,200)
 const data=JSON.parse(res.body);assert.equal(data.path,'/api/info')
 assert.equal(data.headers.authorization,'Basic '+Buffer.from('opencode:test-only').toString('base64'))
 for(const key of ['cookie','forwarded','x-forwarded-host','origin']) assert.equal(data.headers[key],undefined)
})
test('rejects cross-site requests, unknown upstreams, traversal and direct API bypass',async()=> {
 const cases=[['/_desk/servers',{host:'evil'},'GET',404],['/_desk/servers',{origin:'https://evil.test'},'GET',403],['/_desk/servers',{'sec-fetch-site':'cross-site'},'GET',403],['/_desk/server/mini/api/session',{},'POST',403],['/_desk/server/other/api/info',{},'GET',404],['/_desk/server/mini/%2e%2e/api/info',{},'GET',400],['/_desk/server/mini/api/%5csecret',{},'GET',400],['http://evil.test/api/info',{},'GET',400],['/api/info',{},'GET',404],['/%61pi/info',{},'GET',404],['/%61uth/connect',{},'GET',404]]
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


test('requires one website sign-in before exposing any server, and remembers it securely',async()=> {
 const directory=await mkdtemp(join(tmpdir(),'desk-auth-'))
 const path=join(directory,'auth.json')
 await writeFile(path,JSON.stringify({key:'test-session-key',setup:'test-setup-code'}),{mode:0o600})
 const auth=await createDeskAuth(path)
 const protectedGateway=createGateway(Object.fromEntries(['oracle','studio','mini'].map(id=>[id,{url,password:'test-only'}])),url,auth)
 protectedGateway.listen(0,'127.0.0.1');await once(protectedGateway,'listening')
 const targetPort=protectedGateway.address().port
 const request=(path,headers={},method='GET',body)=>call(path,headers,method,body,targetPort)
 try {
  assert.equal((await request('/_desk/servers')).status,401)
  assert.equal((await request('/_desk/server/mini/api/info')).status,401)
  assert.equal((await request('/_desk/projects/experiments',{origin,'content-type':'application/json'},'POST',JSON.stringify({server:'oracle',directory:'/work/test'}))).status,401)
  assert.match((await request('/')).body,/Sign in to Desk/)
  const form={origin,'content-type':'application/x-www-form-urlencoded'}
  assert.equal((await request('/_desk/setup/test-setup-code',form,'POST','password=too-short&confirm=too-short')).status,401)
  const setup=await request('/_desk/setup/test-setup-code',form,'POST','password=test-password-long&confirm=test-password-long')
  assert.equal(setup.status,303)
  const rawCookie=setup.headers['set-cookie'][0]
  for(const attribute of ['Secure','HttpOnly','SameSite=Strict','Path=/'])assert.ok(rawCookie.includes(attribute))
  const cookie=rawCookie.split(';')[0]
  assert.equal((await request('/_desk/servers',{cookie})).status,200)
  assert.equal((await request('/_desk/server/mini/api/info',{cookie})).status,200)
  assert.equal((await request('/_desk/servers',{cookie:cookie+'forged'})).status,401)
  const malformedCookie = cookie.slice(0, cookie.lastIndexOf('.') + 1) + 'é'.repeat(43)
  assert.equal((await request('/_desk/servers',{cookie:malformedCookie})).status,401)
  const upgradeStatus = await new Promise((resolve,reject) => {
   const req=http.request({host:'127.0.0.1',port:targetPort,path:'/_desk/server/studio/api/pty/test/connect',headers:{host:'desk.saibolla.com',origin,cookie:malformedCookie,connection:'Upgrade',upgrade:'websocket'}})
   req.on('response',res=>{res.resume();resolve(res.statusCode)});req.on('error',reject);req.end()
  })
  assert.equal(upgradeStatus,401)
  assert.equal((await request('/_desk/servers',{cookie})).status,200)
  assert.equal((await request('/_desk/server/mini/api/session',{...form,cookie,origin:'https://evil.test'},'POST')).status,403)
  const saved=JSON.parse(await readFile(path,'utf8'))
  assert.equal(saved.setup,undefined);assert.equal(JSON.stringify(saved).includes('test-password-long'),false)
  assert.equal((await createDeskAuth(path)).authenticated({headers:{cookie}}),true)
  assert.equal((await request('/_desk/login',form,'POST','password=wrong')).status,401)
  assert.equal((await request('/_desk/login',form,'POST','password=test-password-long')).status,303)
 } finally {protectedGateway.closeAllConnections();protectedGateway.close();await rm(directory,{recursive:true,force:true})}
})
