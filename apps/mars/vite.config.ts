import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5172, strictPort: true },
  // One copy of three, and the runtime served straight from its build output.
  resolve: { dedupe: ['three'] },
  optimizeDeps: { exclude: ['@worldmesh/runtime'] },
  build: { target: 'es2022' },
});
