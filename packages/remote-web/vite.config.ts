import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Remote Web is served by the Remote Server as a static artifact (proposal
// §13.3); there is no local Host proxy. `vite preview` is used only for
// screenshot evidence on an explicitly provided high port.
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
        },
      },
    },
  },
  preview: {
    host: '127.0.0.1',
    strictPort: true,
  },
});
