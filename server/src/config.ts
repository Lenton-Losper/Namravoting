import path from 'node:path';
import { z } from 'zod';
import { loadDotEnv } from './env.js';

export function parseConfig(env: NodeJS.ProcessEnv) {
  const schema = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().default(3001),
    AUTH_MODE: z.enum(['dev', 'entra', 'demo']).default('dev'),
    STORAGE: z.enum(['disk', 'r2']).default('disk'),
    R2_ENDPOINT: z.string().url().optional(),
    R2_BUCKET: z.string().default('namra-voting-photos'),
    R2_ACCESS_KEY_ID: z.string().optional(),
    R2_SECRET_ACCESS_KEY: z.string().optional(),
    CF_ACCESS_TEAM_DOMAIN: z.string().optional(),
    CF_ACCESS_AUD: z.string().optional(),
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
  // AUTH_MODE=demo (identity picker) is only ever allowed behind Cloudflare Access.
  if (e.AUTH_MODE === 'demo' && (!e.CF_ACCESS_TEAM_DOMAIN || !e.CF_ACCESS_AUD)) {
    throw new Error('Refusing to start: AUTH_MODE=demo requires CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD (Cloudflare Access)');
  }
  if (e.STORAGE === 'r2' && (!e.R2_ENDPOINT || !e.R2_ACCESS_KEY_ID || !e.R2_SECRET_ACCESS_KEY)) {
    throw new Error('Refusing to start: STORAGE=r2 requires R2_ENDPOINT, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY');
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
    storage: e.STORAGE,
    r2: { endpoint: e.R2_ENDPOINT, bucket: e.R2_BUCKET, accessKeyId: e.R2_ACCESS_KEY_ID, secretAccessKey: e.R2_SECRET_ACCESS_KEY },
    access: e.AUTH_MODE === 'demo' ? { teamDomain: e.CF_ACCESS_TEAM_DOMAIN!, aud: e.CF_ACCESS_AUD! } : null,
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
