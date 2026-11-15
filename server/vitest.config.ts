import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { TEST_APP_URL, TEST_DB_IS_REMOTE } from './tests/testDb.js';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/globalSetup.ts'],
    fileParallelism: false,       // all files share one test database
    testTimeout: TEST_DB_IS_REMOTE ? 300000 : 30000,   // a remote database is ~200ms per query away
    hookTimeout: TEST_DB_IS_REMOTE ? 600000 : 60000,
    env: {
      NODE_ENV: 'test',
      AUTH_MODE: 'dev',
      ALLOW_DEV_AUTH: 'true',
      SESSION_SECRET: 'test-secret-test-secret-test-secret-test-secret',
      DATABASE_URL: TEST_APP_URL,
      UPLOAD_DIR: path.join(os.tmpdir(), 'namra-voting-test-uploads'),
      VOTE_RATE_LIMIT_PER_MIN: '10000',
      ADMIN_RATE_LIMIT_PER_MIN: '10000',
      READ_RATE_LIMIT_PER_MIN: '100000',
      AUTH_RATE_LIMIT_PER_MIN: '100000',
      PUBLIC_BASE_URL: 'http://localhost:5173',
    },
  },
});
