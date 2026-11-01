import { createReadStream, cpSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

// prismarine-viewer in the browser (the spectate page) fetches its mesher worker and 26.1 assets relative to the page.
// Served from the package in dev and copied next to the pages on build; only what 26.1 and entity models need.
const PV = 'node_modules/prismarine-viewer/public'
const ASSETS = ['worker.js', 'worldBounds.json', 'textures/26.1.png', 'blocksStates/26.1.json', 'textures/1.16.4/entity']
const TYPES: Record<string, string> = { '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' }
const viewerAssets: Plugin = {
  name: 'prismarine-viewer-assets',
  configureServer (server) {
    server.middlewares.use((req, res, next) => {
      const path = decodeURIComponent((req.url ?? '').split('?')[0]).slice(1)
      if (!ASSETS.some(a => path === a || path.startsWith(`${a}/`))) return next()
      res.setHeader('Content-Type', TYPES[extname(path)] ?? 'application/octet-stream')
      createReadStream(join(PV, path)).on('error', () => { res.statusCode = 404; res.end() }).pipe(res)
    })
  },
  writeBundle ({ dir }) { for (const a of ASSETS) cpSync(join(PV, a), join(dir!, a), { recursive: true }) }
}

// fs.allow: replay serves trace files from the repo (?trace=/@fs/<repo>/traces/<session>.jsonl).
// /api: the web relay (web/server.ts) for the spectate page; Caddy serves both from one origin in production.
// define: what prismarine-viewer's own webpack build sets for the browser. three: the viewer's own copy (0.128), one
// instance for its require() and the page's imports (nothing else Vite builds uses three; Remotion has its own bundler).
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  server: { port: 5288, fs: { allow: ['..'] }, proxy: { '/api': process.env.JEEVE_WEB ?? 'http://127.0.0.1:8080' } },
  plugins: [viewerAssets],
  define: { 'process.platform': '"browser"', __dirname: '""' },
  resolve: { alias: [{ find: /^three$/, replacement: resolve('node_modules/prismarine-viewer/node_modules/three/build/three.module.js') }] },
  build: { rollupOptions: { input: ['index.html', 'spectate.html'] } }
})
