import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const entry = 'prototypes/board-angle/index.html';

export default defineConfig({
  base: './',
  optimizeDeps: { entries: [entry] },
  build: {
    outDir: '.tmp/board-angle-dist',
    rollupOptions: { input: resolve(entry) },
  },
});
