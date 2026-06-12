import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// The Rust backend serves the built SPA from the binary at the root path, so we
// build with base '/'. Dev uses Vite's proxy at '/'.
export default defineConfig(() => ({
  base: '/',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8001',
        changeOrigin: true,
      },
      '/ws': {
        target: 'http://localhost:8001',
        ws: true,
        changeOrigin: true,
      },
    },
  },
}));
