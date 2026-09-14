import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  build: {
    target: 'es2020',
    outDir: 'dist',
  },
  server: {
    port: 5173,
  },
});
