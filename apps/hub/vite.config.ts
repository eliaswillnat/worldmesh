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
    },
  },
  // Walk mode: one copy of three, and let Vite compile the runtime from source.
  resolve: { dedupe: ['three'] },
  optimizeDeps: { exclude: ['@worldmesh/runtime'] },
  build: { target: 'es2022' },
});
