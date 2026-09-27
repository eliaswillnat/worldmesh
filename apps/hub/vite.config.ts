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
    },
  },
  build: { target: 'es2022' },
});
