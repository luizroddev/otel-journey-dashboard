import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  // Relative asset URLs: the server makes them absolute under BASE_PATH at
  // runtime (server/src/http/dashboard.ts), so one build serves any path.
  base: './',
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': `http://localhost:${process.env.PORT ?? 8686}` },
  },
});
