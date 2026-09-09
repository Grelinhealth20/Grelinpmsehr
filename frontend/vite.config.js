import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// During development the SPA talks to the API through the combined backend EDGE (the same process that
// runs the WAF / hardened headers / rate limits and serves /api), mirroring production exactly — never a
// bare internal API. Run the backend with COMBINED_EDGE=true and GATEWAY_PORT=8080 in dev, or point
// VITE_API_TARGET at whatever edge port you use.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
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
