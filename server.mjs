import { execFileSync } from 'node:child_process'
import { createReadStream, existsSync, statSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(root, 'dist')
const port = Number(process.env.PORT || 8090)

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
}

const HOP_BY_HOP_HEADERS = new Set([
  'host',
  'origin',
  'referer',
  'connection',
  'content-length',
  'transfer-encoding',
  'x-proxy-target',
  'accept-encoding',
  'cookie',
])

const isLocalHost = (hostname) => {
  const h = hostname.toLowerCase()
  return (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '::1' ||
    h === '[::1]' ||
    h.startsWith('10.') ||
    h.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    h.endsWith('.local')
  )
}

let cachedProxyUrl
const resolveSystemProxy = () => {
  if (cachedProxyUrl !== undefined) {
    return cachedProxyUrl
  }
  const envProxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy
  if (envProxy?.trim()) {
    cachedProxyUrl = envProxy.trim()
    return cachedProxyUrl
  }
  if (process.platform === 'win32') {
    try {
      const output = execFileSync(
        'reg',
        ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
        { encoding: 'utf8', timeout: 2000 }
      )
      const enabled = /ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(output)
      const serverMatch = /ProxyServer\s+REG_SZ\s+([^\r\n]+)/i.exec(output)
      if (enabled && serverMatch?.[1]) {
        const raw = serverMatch[1].trim()
        const httpsPart = /https=([^;]+)/i.exec(raw)?.[1] ?? /http=([^;]+)/i.exec(raw)?.[1] ?? raw
        cachedProxyUrl = /^https?:\/\//i.test(httpsPart) ? httpsPart : `http://${httpsPart}`
        return cachedProxyUrl
      }
    } catch {
      // 忽略注册表读取失败
    }
  }
  cachedProxyUrl = null
  return null
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })

const handleProxy = async (req, res) => {
  const target = req.headers['x-proxy-target']
  if (typeof target !== 'string' || !/^https?:\/\//i.test(target)) {
    res.statusCode = 400
    res.setHeader('x-local-proxy', '1')
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ error: { message: 'Missing or invalid x-proxy-target header' } }))
    return
  }
  const targetUrl = new URL(target)
  const method = (req.method || 'GET').toUpperCase()
  const headers = {}
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower) || lower.startsWith('sec-') || value === undefined) {
      continue
    }
    headers[key] = value
  }
  const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req)
  if (body && body.length > 0) {
    headers['content-length'] = String(body.length)
  }

  const proxyRaw = isLocalHost(targetUrl.hostname) ? null : resolveSystemProxy()
  const isHttps = targetUrl.protocol === 'https:'
  const targetPort = Number(targetUrl.port || (isHttps ? 443 : 80))

  const sendViaRequest = (options) => {
    const transport = isHttps ? https : http
    const upstreamReq = transport.request(options, (upstreamRes) => {
      res.statusCode = upstreamRes.statusCode ?? 502
      res.setHeader('x-local-proxy', '1')
      const contentType = upstreamRes.headers['content-type']
      if (contentType) {
        res.setHeader('Content-Type', contentType)
      }
      res.setHeader('Cache-Control', 'no-cache')
      upstreamRes.on('data', (chunk) => res.write(chunk))
      upstreamRes.on('end', () => res.end())
      upstreamRes.on('error', (err) => {
        if (!res.writableEnded) {
          res.statusCode = 502
          res.end(JSON.stringify({ error: { message: err.message } }))
        }
      })
    })
    upstreamReq.on('error', (err) => {
      if (!res.writableEnded) {
        res.statusCode = 502
        res.setHeader('x-local-proxy', '1')
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: { message: err.message } }))
      }
    })
    res.on('close', () => {
      if (!res.writableEnded) {
        upstreamReq.destroy()
      }
    })
    if (body && body.length > 0) {
      upstreamReq.write(body)
    }
    upstreamReq.end()
  }

  if (proxyRaw) {
    const proxyUrl = new URL(proxyRaw)
    if (isHttps) {
      const connectReq = http.request({
        hostname: proxyUrl.hostname,
        port: Number(proxyUrl.port || 80),
        method: 'CONNECT',
        path: `${targetUrl.hostname}:${targetPort}`,
      })
      connectReq.on('connect', (connectRes, socket) => {
        if (connectRes.statusCode !== 200) {
          socket.destroy()
          if (!res.writableEnded) {
            res.statusCode = 502
            res.setHeader('x-local-proxy', '1')
            res.setHeader('Content-Type', 'application/json')
            res.end(
              JSON.stringify({
                error: { message: `Proxy CONNECT failed (${connectRes.statusCode})` },
              })
            )
          }
          return
        }
        sendViaRequest({
          hostname: targetUrl.hostname,
          port: targetPort,
          path: `${targetUrl.pathname}${targetUrl.search}`,
          method,
          headers: { ...headers, host: targetUrl.host },
          createConnection: () => socket,
          agent: false,
        })
      })
      connectReq.on('error', (err) => {
        if (!res.writableEnded) {
          res.statusCode = 502
          res.setHeader('x-local-proxy', '1')
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: { message: err.message } }))
        }
      })
      connectReq.end()
      return
    }
    sendViaRequest({
      hostname: proxyUrl.hostname,
      port: Number(proxyUrl.port || 80),
      path: targetUrl.toString(),
      method,
      headers: { ...headers, host: targetUrl.host },
    })
    return
  }

  sendViaRequest({
    hostname: targetUrl.hostname,
    port: targetPort,
    path: `${targetUrl.pathname}${targetUrl.search}`,
    method,
    headers: { ...headers, host: targetUrl.host },
  })
}

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url || '/', `http://localhost:${port}`)
  if (reqUrl.pathname === '/__api_proxy__') {
    void handleProxy(req, res)
    return
  }

  const safePath = path.normalize(reqUrl.pathname).replace(/^(\.\.(\/|\\|$))+/, '')
  let filePath = path.join(distDir, safePath === '/' || safePath === '\\' ? 'index.html' : safePath)
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = path.join(distDir, 'index.html')
  }
  if (!existsSync(filePath)) {
    res.statusCode = 404
    res.end('Not found. Run "pnpm build" first.')
    return
  }
  const ext = path.extname(filePath).toLowerCase()
  res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream')
  createReadStream(filePath).pipe(res)
})

server.listen(port, () => {
  process.stdout.write(`Local deployment server running at http://localhost:${port}/\n`)
})
