import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {connectCdp} from '../../plugins/neo-tools-browser/src/client.ts'
const id='11111111-1111-4111-8111-111111111111'
let denied=0
const server=createServer(async(req,res)=>{let body='';for await(const data of req)body+=data;const request=JSON.parse(body);assert.equal(request.task_token,'fixture');if(new URL(request.url).hostname!=='lab'){denied++;res.writeHead(403);res.end('{}');return}res.setHeader('content-type','application/json');res.end(JSON.stringify({status:200,headers:{'content-type':'text/html'},body_base64:Buffer.from('<html><title>fixture</title><body>lab</body></html>').toString('base64')}))})
await new Promise(resolve=>server.listen(8091,'127.0.0.1',resolve))
const env={NEO_TASK_ID:id,NEO_TASK_TOKEN:'fixture',NEO_BROKER_URL:'http://127.0.0.1:8091',NEO_WORKSPACE_BASE:'/tmp/neo-browser-smoke'}
let a,b
try {
  for(let i=0;i<20;i++){try{const r=await fetch('http://neo-browser-remediation-test:9222/json/version');if(r.ok)break}catch{}await new Promise(r=>setTimeout(r,250))}
  a=await connectCdp({env,cdpUrl:'http://neo-browser-remediation-test:9222'})
  b=await connectCdp({env:{...env,NEO_TASK_ID:'22222222-2222-4222-8222-222222222222'},cdpUrl:'http://neo-browser-remediation-test:9222'})
  assert.equal((await a.navigate('http://lab/')).title,'fixture')
  await a.evaluate('document.cookie="task=first"')
  await b.navigate('http://lab/')
  assert.equal(await b.evaluate('document.cookie'),'')
  assert.match(await a.evaluate('document.cookie'),/first/)
  assert.equal(await a.evaluate('fetch("http://canary/secret").then(()=>"allowed",()=>"blocked")'),'blocked')
  assert.equal(denied,1)
  // Raw browser requests cannot bypass the default-deny network proxy.
  assert.equal(await b.evaluate('new Promise(resolve=>{const img=new Image();img.onload=()=>resolve("allowed");img.onerror=()=>resolve("blocked");img.src="http://control:8090/health"})'),'blocked')
  console.log('peer discovery + WebSocket, lab fulfillment, independent cookies, eval/subresource deny passed')
} finally {await a?.close();await b?.close();await new Promise(resolve=>server.close(resolve))}
