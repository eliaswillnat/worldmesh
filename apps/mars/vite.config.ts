import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5172, strictPort: true },
  // One copy of three, and let Vite compile the runtime from source.
  resolve: { dedupe: ['three'] },
  optimizeDeps: { exclude: ['@worldmesh/runtime'] },
  build: { target: 'es2022' },
});
