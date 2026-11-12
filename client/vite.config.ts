import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:3001', changeOrigin: false } },
  },
  test: { environment: 'jsdom', include: ['src/**/*.test.tsx'], testTimeout: 20000 },
});
