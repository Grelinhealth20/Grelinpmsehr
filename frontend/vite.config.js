import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// During development the SPA still talks to the API through the gateway/WAF/proxy
// layer (never the internal API directly), mirroring production exactly.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Talk to the API through the gateway (WAF/proxy layer), mirroring production.
      // The gateway's port is set in gateway/.env (GATEWAY_PORT, 8080 here); override with
      // VITE_API_TARGET if the gateway runs elsewhere.
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
