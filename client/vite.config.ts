import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// The app can be served under a path (BASE_PATH=/voting-app, see HOSTING.md). Vite bakes it into every asset URL at build time.
const raw = (process.env.BASE_PATH ?? '').trim().replace(/\/+$/, '');
if (raw && !/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(raw)) throw new Error('BASE_PATH must look like /voting-app');
const base = raw ? raw + '/' : '/';

export default defineConfig({
  base,
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { [base + 'api']: { target: 'http://localhost:3001', changeOrigin: false } },
  },
  test: { environment: 'jsdom', include: ['src/**/*.test.{ts,tsx}'], testTimeout: 20000 },
});
