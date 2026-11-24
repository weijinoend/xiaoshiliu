import { execFileSync } from 'node:child_process'
import { createReadStream, existsSync, statSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(root, 'dist')
const port = Number(process.env.PORT || 8090)
const host = process.env.HOST || '127.0.0.1'
const MAX_BODY_BYTES = 64 * 1024 * 1024
const PROXY_CACHE_TTL_MS = 10_000

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

const isBlockedMetadataHost = (hostname) => {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return (
    h === '169.254.169.254' ||
    h === 'metadata.google.internal' ||
    h === '100.100.100.200' ||
    h === 'fd00:ec2::254'
  )
}

const matchesNoProxy = (hostname) => {
  const raw = process.env.NO_PROXY || process.env.no_proxy || ''
  if (!raw.trim()) {
    return false
  }
  const h = hostname.toLowerCase()
  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => {
      if (entry === '*') {
        return true
      }
      const clean = entry.split(':')[0]
      if (clean.startsWith('.')) {
        return h === clean.slice(1) || h.endsWith(clean)
      }
      return h === clean || h.endsWith(`.${clean}`)
    })
}

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
let cachedProxyAt = 0
const resolveSystemProxy = () => {
  if (cachedProxyUrl !== undefined && Date.now() - cachedProxyAt < PROXY_CACHE_TTL_MS) {
    return cachedProxyUrl
  }
  cachedProxyAt = Date.now()
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
    let total = 0
    let done = false
    req.on('data', (chunk) => {
      if (done) {
        return
      }
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        done = true
        req.destroy()
        reject(new Error('Request body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!done) {
        done = true
        resolve(Buffer.concat(chunks))
      }
    })
    req.on('error', (err) => {
      if (!done) {
        done = true
        reject(err)
      }
    })
  })

const sendJsonError = (res, status, message) => {
  if (res.writableEnded) {
    return
  }
  if (!res.headersSent) {
    res.statusCode = status
    res.setHeader('x-local-proxy', '1')
    res.setHeader('Content-Type', 'application/json')
  }
  res.end(JSON.stringify({ error: { message } }))
}

const handleProxy = async (req, res) => {
  const originHeader = req.headers.origin
  if (typeof originHeader === 'string' && originHeader !== 'null') {
    try {
      const originHost = new URL(originHeader).hostname.toLowerCase()
      if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(originHost)) {
        sendJsonError(res, 403, 'Forbidden proxy origin')
        return
      }
    } catch {
      sendJsonError(res, 403, 'Invalid proxy origin')
      return
    }
  }

  const target = req.headers['x-proxy-target']
  if (typeof target !== 'string' || !/^https?:\/\//i.test(target)) {
    sendJsonError(res, 400, 'Missing or invalid x-proxy-target header')
    return
  }
  let targetUrl
  try {
    targetUrl = new URL(target)
  } catch {
    sendJsonError(res, 400, 'Invalid x-proxy-target URL')
    return
  }
  if (isBlockedMetadataHost(targetUrl.hostname)) {
    sendJsonError(res, 403, 'Blocked metadata target')
    return
  }

  const method = (req.method || 'GET').toUpperCase()
  const headers = {}
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower) || lower.startsWith('sec-') || value === undefined) {
      continue
    }
    headers[key] = value
  }
  let body
  if (method !== 'GET' && method !== 'HEAD') {
    try {
      body = await readBody(req)
    } catch (err) {
      sendJsonError(res, 413, err instanceof Error ? err.message : 'Invalid request body')
      return
    }
  }
  if (body && body.length > 0) {
    headers['content-length'] = String(body.length)
  }

  const proxyRaw =
    isLocalHost(targetUrl.hostname) || matchesNoProxy(targetUrl.hostname)
      ? null
      : resolveSystemProxy()
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
          if (!res.headersSent) {
            sendJsonError(res, 502, err.message)
          } else {
            res.destroy(err)
          }
        }
      })
    })
    upstreamReq.setTimeout(120_000, () => {
      upstreamReq.destroy(new Error('Upstream timeout'))
    })
    upstreamReq.on('error', (err) => {
      if (!res.writableEnded) {
        if (!res.headersSent) {
          sendJsonError(res, 502, err.message)
        } else {
          res.destroy(err)
        }
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
    let proxyUrl
    try {
      proxyUrl = new URL(proxyRaw)
    } catch {
      sendJsonError(res, 502, 'Invalid system proxy URL')
      return
    }
    const proxyIsHttps = proxyUrl.protocol === 'https:'
    const proxyPort = Number(proxyUrl.port || (proxyIsHttps ? 443 : 80))
    const proxyAuth =
      proxyUrl.username || proxyUrl.password
        ? `Basic ${Buffer.from(
            `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`
          ).toString('base64')}`
        : null

    if (isHttps) {
      const connectTransport = proxyIsHttps ? https : http
      const connectHeaders = proxyAuth ? { 'Proxy-Authorization': proxyAuth } : {}
      const connectReq = connectTransport.request({
        hostname: proxyUrl.hostname,
        port: proxyPort,
        method: 'CONNECT',
        path: `${targetUrl.hostname}:${targetPort}`,
        headers: connectHeaders,
      })
      connectReq.setTimeout(15_000, () => {
        connectReq.destroy(new Error('Proxy CONNECT timeout'))
      })
      res.on('close', () => {
        if (!res.writableEnded) {
          connectReq.destroy()
        }
      })
      connectReq.on('connect', (connectRes, socket) => {
        if (connectRes.statusCode !== 200) {
          socket.destroy()
          sendJsonError(res, 502, `Proxy CONNECT failed (${connectRes.statusCode})`)
          return
        }
        const tlsSocket = tls.connect({ socket, servername: targetUrl.hostname })
        const tunnelAgent = new https.Agent({ keepAlive: false })
        tunnelAgent.createConnection = () => tlsSocket
        sendViaRequest({
          hostname: targetUrl.hostname,
          port: targetPort,
          path: `${targetUrl.pathname}${targetUrl.search}`,
          method,
          headers: { ...headers, host: targetUrl.host },
          agent: tunnelAgent,
        })
      })
      connectReq.on('error', (err) => {
        sendJsonError(res, 502, err.message)
      })
      connectReq.end()
      return
    }
    sendViaRequest({
      hostname: proxyUrl.hostname,
      port: proxyPort,
      path: targetUrl.toString(),
      method,
      headers: {
        ...headers,
        host: targetUrl.host,
        ...(proxyAuth ? { 'proxy-authorization': proxyAuth } : {}),
      },
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
  let reqUrl
  try {
    reqUrl = new URL(req.url || '/', `http://localhost:${port}`)
  } catch {
    res.statusCode = 400
    res.end('Bad Request')
    return
  }
  if (reqUrl.pathname === '/__api_proxy__') {
    void handleProxy(req, res).catch((err) => {
      sendJsonError(res, 500, err instanceof Error ? err.message : 'Proxy internal error')
    })
    return
  }

  let decodedPath = '/'
  try {
    decodedPath = decodeURIComponent(reqUrl.pathname)
  } catch {
    res.statusCode = 400
    res.end('Bad Request')
    return
  }
  const rel = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '')
  let filePath = path.resolve(distDir, rel)
  if (!filePath.startsWith(distDir + path.sep) && filePath !== distDir) {
    res.statusCode = 403
    res.end('Forbidden')
    return
  }
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
  const stream = createReadStream(filePath)
  stream.on('error', () => {
    if (!res.headersSent) {
      res.statusCode = 500
    }
    if (!res.writableEnded) {
      res.end('Read error')
    }
  })
  stream.pipe(res)
})

server.listen(port, host, () => {
  process.stdout.write(`Local deployment server running at http://${host}:${port}/\n`)
})
