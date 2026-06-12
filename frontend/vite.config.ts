import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// In dev we serve from root ('/') and use Vite's proxy; in a production build
// the app is served by MAMP/Apache under http://localhost:8888/sandbox/.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/sandbox/' : '/',
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
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'http://localhost:8000',
        ws: true,
        changeOrigin: true,
      },
    },
  },
}));
