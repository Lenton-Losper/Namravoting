import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Loads the repo-root .env if present (never overrides real env vars). */
export function loadDotEnv(): void {
  if (process.env.NODE_ENV === 'test') return;   // tests get their settings from vitest.config and .env.test, never from the real .env
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  try { process.loadEnvFile(path.join(root, '.env')); } catch { /* no .env file: rely on the real environment */ }
}
