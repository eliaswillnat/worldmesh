import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5170, strictPort: true },
  build: { target: 'es2022' },
});
