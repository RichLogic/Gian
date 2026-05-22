import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const hostPort = process.env.GIAN_HOST_PORT ?? process.env.GIAN_PORT ?? '8991';
const webPort = Number(process.env.GIAN_WEB_PORT ?? '5191');
const proxy = {
  '/ws': { target: `ws://127.0.0.1:${hostPort}`, ws: true },
  '/api': { target: `http://127.0.0.1:${hostPort}`, changeOrigin: true },
};

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: webPort,
    strictPort: true,
    proxy,
  },
  preview: {
    host: '127.0.0.1',
    port: webPort,
    strictPort: true,
    proxy,
  },
});
