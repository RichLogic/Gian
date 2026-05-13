import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5190,
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:8990', ws: true },
      '/api': { target: 'http://127.0.0.1:8990', changeOrigin: true },
    },
  },
});
