import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  root: 'frontend',
  build: { outDir: '../dist/frontend' },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8000',
      '/ws': { target: 'ws://localhost:8000', ws: true },
    },
  },
});
