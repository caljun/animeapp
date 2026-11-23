import { Readable } from 'node:stream'
import { defineConfig, loadEnv } from 'vite'
import { createCleanupHandler } from './server/cleanup.mjs'

export default defineConfig(({ mode }) => {
  const cleanup = createCleanupHandler({ ...loadEnv(mode, process.cwd(), 'KOMA_COMFY_'), ...process.env })
  async function handler(req, res, next) {
    if (req.url?.split('?')[0] !== '/api/cleanup') return next()
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(req.headers.host ?? '')) {
      res.writeHead(403)
      res.end()
      return
    }
    const controller = new AbortController()
    res.once('close', () => { if (!res.writableEnded) controller.abort() })
    try {
      const request = new Request('http://localhost/api/cleanup', {
        method: req.method, headers: req.headers, signal: controller.signal,
        ...(req.method === 'GET' || req.method === 'HEAD' ? {} : { body: Readable.toWeb(req), duplex: 'half' }),
      })
      const response = await cleanup(request)
      if (res.destroyed) return
      res.writeHead(response.status, Object.fromEntries(response.headers))
      res.end(Buffer.from(await response.arrayBuffer()))
    } catch (error) {
      if (!res.destroyed) next(error)
    }
  }

  return {
    server: { host: '127.0.0.1' },
    preview: { host: '127.0.0.1' },
    plugins: [{
      name: 'koma-cleanup',
      configureServer(server) { server.middlewares.use(handler) },
      configurePreviewServer(server) { server.middlewares.use(handler) },
    }],
  }
})
