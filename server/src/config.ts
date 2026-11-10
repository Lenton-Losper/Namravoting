import path from 'node:path';
import { z } from 'zod';
import { loadDotEnv } from './env.js';

export function parseConfig(env: NodeJS.ProcessEnv) {
  const schema = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().default(3001),
    AUTH_MODE: z.enum(['dev', 'entra']).default('dev'),
    PUBLIC_BASE_URL: z.string().url().default('http://localhost:5173'),
    SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
    DATABASE_URL: z.string().min(1),
    UPLOAD_DIR: z.string().default('./uploads'),
    VOTE_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(10),
    ADMIN_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(60),
  });
  const e = schema.parse(env);
  if (e.AUTH_MODE === 'dev' && e.NODE_ENV === 'production') {
    throw new Error('Refusing to start: AUTH_MODE=dev is not allowed when NODE_ENV=production');
  }
  if (e.NODE_ENV === 'production' && e.SESSION_SECRET.startsWith('change-me')) {
    throw new Error('Refusing to start: set a real SESSION_SECRET in production');
  }
  return {
    nodeEnv: e.NODE_ENV,
    isProd: e.NODE_ENV === 'production',
    port: e.PORT,
    authMode: e.AUTH_MODE,
    publicBaseUrl: e.PUBLIC_BASE_URL.replace(/\/$/, ''),
    sessionSecret: e.SESSION_SECRET,
    databaseUrl: e.DATABASE_URL,
    uploadDir: path.resolve(e.UPLOAD_DIR),
    voteRateLimit: e.VOTE_RATE_LIMIT_PER_MIN,
    adminRateLimit: e.ADMIN_RATE_LIMIT_PER_MIN,
  };
}
export type Config = ReturnType<typeof parseConfig>;

let cached: Config | undefined;
export function getConfig(): Config {
  if (!cached) { loadDotEnv(); cached = parseConfig(process.env); }
  return cached;
}
