import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5170,
    strictPort: true,
    proxy: {
      '/api/notify': {
        target: 'https://worldmesh.net',
        changeOrigin: true,
      },
      '/api/cover': {
        target: 'https://worldmesh.net',
        changeOrigin: true,
      },
      // Accounts and federation run as local Workers: npm run dev:auth / dev:federation.
      // Host stays localhost:5170, so cookies and OAuth callbacks use the hub's origin.
      '/api/auth': 'http://localhost:8788',
      // Billboard ads: npm run dev:ads (Stripe test keys in workers/ads/.dev.vars).
      '/api/ads': 'http://localhost:8790',
      '/api/account': 'http://localhost:8788',
      '/.well-known/webfinger': 'http://localhost:8789',
      '/.well-known/nodeinfo': 'http://localhost:8789',
      '/nodeinfo': 'http://localhost:8789',
      '/ap/': 'http://localhost:8789',
      // Profile pages (/@name), but not Vite's own /@vite, /@fs and /@id paths.
      '^/@(?!vite/|fs/|id/)[A-Za-z0-9_]+': 'http://localhost:8789',
    },
  },
  // Walk mode: one copy of three, and the runtime served straight from its
  // build output so edits show up with `npm run dev:runtime` watching.
  resolve: { dedupe: ['three'] },
  optimizeDeps: { exclude: ['@worldmesh/runtime'] },
  build: { target: 'es2022' },
});
