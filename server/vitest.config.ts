import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/globalSetup.ts'],
    fileParallelism: false,       // all files share one test database
    testTimeout: 30000,
    hookTimeout: 60000,
    env: {
      NODE_ENV: 'test',
      AUTH_MODE: 'dev',
      SESSION_SECRET: 'test-secret-test-secret-test-secret-test-secret',
      DATABASE_URL: 'postgres://namra_app:namra_app_dev@localhost:5433/namra_test',
      UPLOAD_DIR: path.join(os.tmpdir(), 'namra-voting-test-uploads'),
      VOTE_RATE_LIMIT_PER_MIN: '10000',
      ADMIN_RATE_LIMIT_PER_MIN: '10000',
      READ_RATE_LIMIT_PER_MIN: '100000',
      AUTH_RATE_LIMIT_PER_MIN: '100000',
      PUBLIC_BASE_URL: 'http://localhost:5173',
    },
  },
});
