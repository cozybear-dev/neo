// Internal HTTP/WebSocket relay. Chromium rejects non-loopback Host names.
const http = require('node:http')
const net = require('node:net')
const server = http.createServer((request, response) => {
  const upstream = http.request({hostname:'127.0.0.1',port:9223,path:request.url,method:request.method,headers:{...request.headers,host:'127.0.0.1:9223'}}, result => {
    response.writeHead(result.statusCode, result.headers)
    result.pipe(response)
  })
  upstream.on('error', () => {response.writeHead(503);response.end('CDP unavailable')})
  request.pipe(upstream)
})
server.on('upgrade', (request, client, head) => {
  const upstream = net.connect(9223, '127.0.0.1', () => {
    const headers={...request.headers,host:'127.0.0.1:9223'}
    upstream.write(`${request.method} ${request.url} HTTP/1.1\r\n${Object.entries(headers).map(([k,v])=>`${k}: ${v}`).join('\r\n')}\r\n\r\n`)
    if(head.length)upstream.write(head)
    client.pipe(upstream).pipe(client)
  })
  client.on('error', () => upstream.destroy())
  upstream.on('error', () => client.destroy())
  client.on('close', () => upstream.destroy())
  upstream.on('close', () => client.destroy())
})
server.listen(9222, '0.0.0.0')
process.on('SIGTERM', () => server.close(() => process.exit(0)))
