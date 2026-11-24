import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import * as http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import * as https from 'node:https'
import path from 'node:path'
import * as tls from 'node:tls'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@rspack/cli'
import { rspack, type Configuration } from '@rspack/core'

const dev = process.env.NODE_ENV !== 'production'
const MAX_BODY_BYTES = 64 * 1024 * 1024
const PROXY_CACHE_TTL_MS = 10_000
const targets = ['chrome >= 79', 'edge >= 79', 'safari >= 14', 'firefox >= 85']
const root = path.dirname(fileURLToPath(import.meta.url))
const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8')
) as { version: string }

const cssLoader = {
  loader: 'builtin:lightningcss-loader',
  options: { targets },
}

type ConfigOptions = {
  /** 公开 API 的地址，注入为 __API_ORIGIN__ */
  apiOrigin?: string
  /** 开发服务器配置，支持本地接口代理 */
  devServer?: Configuration['devServer']
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

const readRequestBody = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []
    let total = 0
    let done = false
    req.on('data', (chunk: Uint8Array) => {
      if (done) {
        return
      }
      total += chunk.byteLength
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

let cachedProxyUrl: string | null | undefined
let cachedProxyAt = 0

const resolveSystemProxy = (): string | null => {
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
        const normalized = /^https?:\/\//i.test(httpsPart) ? httpsPart : `http://${httpsPart}`
        cachedProxyUrl = normalized
        return cachedProxyUrl
      }
    } catch {
      // 忽略注册表读取失败
    }
  }
  cachedProxyUrl = null
  return null
}

const isBlockedMetadataHost = (hostname: string): boolean => {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return (
    h === '169.254.169.254' ||
    h === 'metadata.google.internal' ||
    h === '100.100.100.200' ||
    h === 'fd00:ec2::254'
  )
}

const matchesNoProxy = (hostname: string): boolean => {
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

const isLocalHost = (hostname: string): boolean => {
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

const sendProxyJsonError = (res: ServerResponse, status: number, message: string) => {
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

const forwardUpstream = (
  targetUrl: URL,
  method: string,
  headers: Record<string, string | string[]>,
  body: Buffer | undefined,
  res: ServerResponse
) => {
  const proxyRaw =
    isLocalHost(targetUrl.hostname) || matchesNoProxy(targetUrl.hostname)
      ? null
      : resolveSystemProxy()
  const isHttps = targetUrl.protocol === 'https:'
  const targetPort = Number(targetUrl.port || (isHttps ? 443 : 80))

  const sendViaRequest = (options: https.RequestOptions) => {
    const transport = isHttps ? https : http
    const upstreamReq = transport.request(options, (upstreamRes) => {
      res.statusCode = upstreamRes.statusCode ?? 502
      res.setHeader('x-local-proxy', '1')
      const contentType = upstreamRes.headers['content-type']
      if (contentType) {
        res.setHeader('Content-Type', contentType)
      }
      res.setHeader('Cache-Control', 'no-cache')
      upstreamRes.on('data', (chunk: Uint8Array) => {
        res.write(chunk)
      })
      upstreamRes.on('end', () => {
        res.end()
      })
      upstreamRes.on('error', (err) => {
        if (!res.writableEnded) {
          if (!res.headersSent) {
            sendProxyJsonError(res, 502, err.message)
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
          sendProxyJsonError(res, 502, err.message)
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
    let proxyUrl: URL
    try {
      proxyUrl = new URL(proxyRaw)
    } catch {
      sendProxyJsonError(res, 502, 'Invalid system proxy URL')
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
      const connectReq = connectTransport.request({
        hostname: proxyUrl.hostname,
        port: proxyPort,
        method: 'CONNECT',
        path: `${targetUrl.hostname}:${targetPort}`,
        headers: proxyAuth ? { 'Proxy-Authorization': proxyAuth } : {},
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
          sendProxyJsonError(res, 502, `Proxy CONNECT failed (${connectRes.statusCode})`)
          return
        }
        const tlsSocket = tls.connect({ socket, servername: targetUrl.hostname })
        const tunnelAgent = new https.Agent({ keepAlive: false })
        ;(tunnelAgent as https.Agent & { createConnection: () => tls.TLSSocket }).createConnection =
          () => tlsSocket
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
        sendProxyJsonError(res, 502, err.message)
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

const handleDevProxy = async (req: IncomingMessage, res: ServerResponse) => {
  const originHeader = req.headers.origin
  if (typeof originHeader === 'string' && originHeader !== 'null') {
    try {
      const originHost = new URL(originHeader).hostname.toLowerCase()
      if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(originHost)) {
        sendProxyJsonError(res, 403, 'Forbidden proxy origin')
        return
      }
    } catch {
      sendProxyJsonError(res, 403, 'Invalid proxy origin')
      return
    }
  }

  const targetHeader = req.headers['x-proxy-target']
  const target = Array.isArray(targetHeader) ? targetHeader[0] : targetHeader
  if (!target || !/^https?:\/\//i.test(target)) {
    sendProxyJsonError(res, 400, 'Missing or invalid x-proxy-target header')
    return
  }

  let targetUrl: URL
  try {
    targetUrl = new URL(target)
  } catch {
    sendProxyJsonError(res, 400, 'Invalid x-proxy-target URL')
    return
  }
  if (isBlockedMetadataHost(targetUrl.hostname)) {
    sendProxyJsonError(res, 403, 'Blocked metadata target')
    return
  }

  const method = (req.method ?? 'GET').toUpperCase()
  const headers: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower) || lower.startsWith('sec-') || value === undefined) {
      continue
    }
    headers[key] = value
  }
  let body: Buffer | undefined
  if (method !== 'GET' && method !== 'HEAD') {
    try {
      body = await readRequestBody(req)
    } catch (err) {
      sendProxyJsonError(res, 413, err instanceof Error ? err.message : 'Invalid request body')
      return
    }
  }
  if (body && body.length > 0) {
    headers['content-length'] = String(body.length)
  }
  forwardUpstream(targetUrl, method, headers, body, res)
}

/** 创建构建配置，支持自定义 API 地址和开发服务器选项 */
export const createConfig = ({
  apiOrigin = 'https://api.deepseek.com',
  devServer,
}: ConfigOptions = {}): Configuration => ({
  mode: dev ? 'development' : 'production',
  entry: './src/main.tsx',
  output: {
    path: path.resolve(root, 'dist'),
    // 运行时按当前脚本地址推导资源路径，file:// 下异步 chunk、字体都按相对位置加载
    publicPath: 'auto',
    filename: 'static/js/[name].[contenthash:8].js',
    chunkFilename: 'static/js/async/[name].[contenthash:8].js',
    cssFilename: 'static/css/[name].[contenthash:8].css',
    cssChunkFilename: 'static/css/async/[name].[contenthash:8].css',
    assetModuleFilename: 'static/media/[name].[contenthash:8][ext]',
    clean: true,
  },
  devtool: dev ? 'cheap-module-source-map' : false,
  // 开发模式预编译异步模块，保持首次加载代码高亮和公式时的页面状态
  lazyCompilation: false,
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
    // 将 .js 导入路径解析到同名 .ts、.tsx 或 .js 文件
    extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
  },
  module: {
    // CSS Modules 使用默认导出：`import styles from './x.module.css'`
    parser: { 'css/module': { namedExports: false } },
    generator: { 'css/module': { localIdentName: '[local]-[hash:6]' } },
    rules: [
      { test: /\.module\.css$/, type: 'css/module', use: [cssLoader] },
      { test: /\.css$/, exclude: /\.module\.css$/, type: 'css', use: [cssLoader] },
      {
        test: /\.(j|t)sx?$/,
        exclude: /[\\/]node_modules[\\/]/,
        loader: 'builtin:swc-loader',
        options: {
          jsc: {
            parser: { syntax: 'typescript', tsx: true },
            transform: { react: { runtime: 'automatic', development: dev } },
            externalHelpers: true,
          },
          env: { targets },
        },
        type: 'javascript/auto',
      },
      { test: /\.(woff2?|ttf|png|webp)$/, type: 'asset/resource' },
    ],
  },
  plugins: [
    // 经典 defer 脚本支持 file:// 页面的资源加载
    new rspack.HtmlRspackPlugin({
      template: './src/index.html',
      scriptLoading: 'defer',
      meta: { 'application-version': version },
    }),
    new rspack.DefinePlugin({
      __APP_VERSION__: JSON.stringify(version),
      __API_ORIGIN__: JSON.stringify(apiOrigin),
      __DEV_PROXY__: JSON.stringify(dev),
    }),
    new rspack.CopyRspackPlugin({
      patterns: [
        { from: path.resolve(root, 'LICENSE'), to: 'LICENSE', toType: 'file' },
        {
          from: path.resolve(root, 'assets/manifest.webmanifest'),
          to: 'manifest.webmanifest',
        },
        { from: path.resolve(root, 'assets/sw.js'), to: 'sw.js' },
        { from: path.resolve(root, 'assets/apple-touch-icon.png'), to: 'apple-touch-icon.png' },
        { from: path.resolve(root, 'assets/favicon.png'), to: 'favicon.png' },
        { from: path.resolve(root, 'assets/icon-192.png'), to: 'icon-192.png' },
        { from: path.resolve(root, 'assets/icon-512.png'), to: 'icon-512.png' },
        {
          from: path.resolve(root, 'assets/icon-maskable-512.png'),
          to: 'icon-maskable-512.png',
        },
      ],
    }),
  ],
  performance: { hints: false },
  devServer:
    devServer === false
      ? false
      : {
          host: '127.0.0.1',
          port: 8090,
          ...devServer,
          setupMiddlewares: (middlewares, server) => {
            if (server.app) {
              server.app.use(
                '/__api_proxy__',
                (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
                  void handleDevProxy(req, res).catch(next)
                }
              )
            }
            return devServer?.setupMiddlewares
              ? devServer.setupMiddlewares(middlewares, server)
              : middlewares
          },
        },
})

// eslint-disable-next-line import/no-default-export
export default defineConfig(createConfig())
