import { Readable } from 'node:stream'
import { defineConfig, loadEnv } from 'vite'
import { createCleanupHandler } from './server/cleanup.mjs'

export default defineConfig(({ mode }) => {
  const cleanup = createCleanupHandler({ ...loadEnv(mode, process.cwd(), ''), ...process.env })
  async function handler(req, res, next) {
    if (req.url?.split('?')[0] !== '/api/cleanup') return next()
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
    plugins: [{
      name: 'koma-cleanup',
      configureServer(server) { server.middlewares.use(handler) },
      configurePreviewServer(server) { server.middlewares.use(handler) },
    }],
  }
})
