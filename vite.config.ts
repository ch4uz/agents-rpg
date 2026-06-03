import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { createReadStream, statSync } from 'node:fs';
import { extname } from 'node:path';

/**
 * Dev-only middleware that serves the repo's `assets/` directory directly
 * at `/assets/*`. Lets standalone preview pages (dice-test, battle-order-
 * test) render character portraits and dice-face sprites WITHOUT needing
 * the WS stub server to be running on port 5175. Falls through to the
 * `/assets` proxy below for anything not present on disk, so dynamically
 * served paths still reach the WS server in the normal dev flow.
 */
const serveAssets = () => ({
  name: 'serve-static-assets',
  configureServer(server: { middlewares: { use: (path: string, fn: (req: { url?: string }, res: { writeHead: (code: number, headers: Record<string, string>) => void; end: () => void }, next: () => void) => void) => void } }) {
    const root = resolve(__dirname, 'assets');
    const mime: Record<string, string> = {
      '.png':  'image/png',
      '.jpg':  'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.svg':  'image/svg+xml',
      '.glb':  'model/gltf-binary',
      '.json': 'application/json',
    };
    server.middlewares.use('/assets', (req, res, next) => {
      const rel = (req.url ?? '').split('?')[0]!.replace(/^\/+/, '');
      const filePath = resolve(root, rel);
      // Refuse path-traversal attempts.
      if (!filePath.startsWith(root)) return next();
      try {
        const st = statSync(filePath);
        if (!st.isFile()) return next();
        const type = mime[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
        res.writeHead(200, {
          'Content-Type':   type,
          'Content-Length': String(st.size),
          'Cache-Control':  'no-cache',
        });
        createReadStream(filePath).pipe(res as unknown as NodeJS.WritableStream);
      } catch {
        next();  /* falls through to /assets proxy */
      }
    });
  },
});

export default defineConfig({
  root: 'web',
  plugins: [serveAssets()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    assetsDir: 'bundle',
    rollupOptions: {
      input: {
        // Main game shell.
        index: resolve(__dirname, 'web/index.html'),
        // Standalone harness for the 3D dice overlay. Boots Dice3DOverlay
        // without WS/Pixi so the dice physics + pixelation can be exercised
        // in isolation. Open `/dice-test.html` in dev or production.
        'dice-test': resolve(__dirname, 'web/dice-test.html'),
        // Standalone preview for the BattleOrderReveal plaque. Mounts the
        // component with mock initiative summaries so the UI can be
        // visually inspected without running the engine + WS server.
        // Open `/battle-order-test.html` in dev or production.
        'battle-order-test': resolve(__dirname, 'web/battle-order-test.html'),
        // Standalone preview for the pixel-art explosion VFX. Fires
        // triggerExplosion over a bare floor so the fire/smoke animation can be
        // hot-iterated without WS/engine. Open `/explosion-test.html`.
        'explosion-test': resolve(__dirname, 'web/explosion-test.html'),
        // Standalone preview for the in-world thought balloon (pulsing dots
        // over a thinking hero's head; hover expands to the live streamed
        // thought). Open `/thought-test.html`.
        'thought-test': resolve(__dirname, 'web/thought-test.html'),
      },
    },
  },
  server: {
    port: 5174,
    proxy: {
      '/ws': { target: 'ws://localhost:5175', ws: true },
      '/assets': { target: 'http://localhost:5175' },
    },
  },
});
