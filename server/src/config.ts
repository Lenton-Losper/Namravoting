import path from 'node:path';
import { z } from 'zod';
import { loadDotEnv } from './env.js';
import { normalizeEmployeeCode } from './domain/employeeCode.js';

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
    DEMO_USERS: z.string().optional(),
    ENTRA_TENANT_ID: z.string().optional(),
    ENTRA_CLIENT_ID: z.string().optional(),
    ENTRA_CLIENT_SECRET: z.string().optional(),
    ENTRA_REDIRECT_URI: z.string().optional(),
    ADMIN_EMAILS: z.string().optional(),
    DEMO_MEMBER_EMAILS: z.string().optional(),
    DEMO: z.enum(['true', 'false']).optional(),
    ADMIN_OIDS: z.string().optional(),
    ADMIN_EMAILS_FALLBACK: z.enum(['true', 'false']).optional(),
    ENTRA_SECRET_EXPIRES_AT: z.string().optional(),
    DEMO_BANNER: z.enum(['true', 'false']).optional(),
    PUBLIC_BASE_URL: z.string().url().default('http://localhost:5173'),
    SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
    // Rotation: the previous secret is accepted for verification only; CSRF_SECRET lets the CSRF key rotate on its own (auth/keys.ts).
    SESSION_SECRET_PREVIOUS: z.string().min(32, 'SESSION_SECRET_PREVIOUS must be at least 32 characters').optional(),
    CSRF_SECRET: z.string().min(32, 'CSRF_SECRET must be at least 32 characters').optional(),
    DATABASE_URL: z.string().min(1),
    UPLOAD_DIR: z.string().default('./uploads'),
    VOTE_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(10),
    ADMIN_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(60),
    READ_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(120),
    AUTH_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(30),
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
  const entra = e.AUTH_MODE === 'entra' ? parseEntra(e) : null;
  // SEC-07: the demo membership override must never ride along into a real election by accident. In production it needs an
  // explicit DEMO=true; the admin banner (auth/notices.ts) shows it whenever it is active.
  if (entra && e.NODE_ENV === 'production' && entra.demoMemberEmails.length > 0 && e.DEMO !== 'true') {
    throw new Error('Refusing to start: DEMO_MEMBER_EMAILS is set in production but DEMO=true is not. Remove DEMO_MEMBER_EMAILS for a real election, or set DEMO=true for the demo deployment');
  }
  const demoUsers = parseDemoUsers(e.DEMO_USERS);
  return {
    demoUsers,
    entra,
    demo: e.DEMO === 'true',
    demoBanner: e.DEMO_BANNER ? e.DEMO_BANNER === 'true' : e.AUTH_MODE === 'demo',
    nodeEnv: e.NODE_ENV,
    isProd: e.NODE_ENV === 'production',
    port: e.PORT,
    authMode: e.AUTH_MODE,
    publicBaseUrl: e.PUBLIC_BASE_URL.replace(/\/$/, ''),
    sessionSecret: e.SESSION_SECRET,
    sessionSecretPrevious: e.SESSION_SECRET_PREVIOUS ?? null,
    csrfSecret: e.CSRF_SECRET ?? null,
    databaseUrl: e.DATABASE_URL,
    uploadDir: path.resolve(e.UPLOAD_DIR),
    storage: e.STORAGE,
    r2: { endpoint: e.R2_ENDPOINT, bucket: e.R2_BUCKET, accessKeyId: e.R2_ACCESS_KEY_ID, secretAccessKey: e.R2_SECRET_ACCESS_KEY },
    access: e.AUTH_MODE === 'demo' ? { teamDomain: e.CF_ACCESS_TEAM_DOMAIN!, aud: e.CF_ACCESS_AUD! } : null,
    voteRateLimit: e.VOTE_RATE_LIMIT_PER_MIN,
    adminRateLimit: e.ADMIN_RATE_LIMIT_PER_MIN,
    readRateLimit: e.READ_RATE_LIMIT_PER_MIN,
    authRateLimit: e.AUTH_RATE_LIMIT_PER_MIN,
  };
}
export interface EntraConfig {
  tenantId: string; clientId: string; clientSecret: string; redirectUri: string;
  /** Admins by Entra object id (SEC-11). The preferred way. */
  adminOids: string[];
  /** Admins by email: only used when ADMIN_OIDS is empty, or when ADMIN_EMAILS_FALLBACK=true (an email can be renamed or reused). */
  adminEmails: string[];
  adminEmailsAllowed: boolean;
  demoMemberEmails: string[];
  /** When the client secret expires (ENTRA_SECRET_EXPIRES_AT, e.g. 2027-05-30). null = not tracked. */
  secretExpiresAt: Date | null;
}

/** AUTH_MODE=entra needs every ENTRA_* setting. Names the missing keys, never values. */
function parseEntra(e: { ENTRA_TENANT_ID?: string; ENTRA_CLIENT_ID?: string; ENTRA_CLIENT_SECRET?: string; ENTRA_REDIRECT_URI?: string; ADMIN_EMAILS?: string; ADMIN_OIDS?: string; ADMIN_EMAILS_FALLBACK?: string; DEMO_MEMBER_EMAILS?: string; ENTRA_SECRET_EXPIRES_AT?: string }): EntraConfig {
  const need = ['ENTRA_TENANT_ID', 'ENTRA_CLIENT_ID', 'ENTRA_CLIENT_SECRET', 'ENTRA_REDIRECT_URI'] as const;
  const missing = need.filter((k) => !e[k]?.trim());
  if (missing.length) throw new Error(`Refusing to start: AUTH_MODE=entra requires ${missing.join(', ')}`);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(e.ENTRA_TENANT_ID!.trim())) throw new Error('Refusing to start: ENTRA_TENANT_ID must be a tenant GUID');
  if (!uuid.test(e.ENTRA_CLIENT_ID!.trim())) throw new Error('Refusing to start: ENTRA_CLIENT_ID must be a client (application) GUID');
  let redirect: URL;
  try { redirect = new URL(e.ENTRA_REDIRECT_URI!.trim()); } catch { throw new Error('Refusing to start: ENTRA_REDIRECT_URI must be an absolute URL'); }
  if (redirect.pathname !== '/auth/callback') throw new Error('Refusing to start: ENTRA_REDIRECT_URI must end with /auth/callback');
  const adminOids = (e.ADMIN_OIDS ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  for (const o of adminOids) if (!uuid.test(o)) throw new Error('Refusing to start: ADMIN_OIDS must be a comma-separated list of Entra object ids (GUIDs)');
  const adminEmails = (e.ADMIN_EMAILS ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  let secretExpiresAt: Date | null = null;
  if (e.ENTRA_SECRET_EXPIRES_AT?.trim()) {
    const raw = e.ENTRA_SECRET_EXPIRES_AT.trim();
    secretExpiresAt = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(raw + 'T23:59:59Z') : new Date(raw);   // a plain date means "until the end of that day"
    if (Number.isNaN(secretExpiresAt.getTime())) throw new Error('Refusing to start: ENTRA_SECRET_EXPIRES_AT must be a date such as 2027-05-30');
  }
  return {
    adminOids, adminEmails, adminEmailsAllowed: adminOids.length === 0 || e.ADMIN_EMAILS_FALLBACK === 'true', secretExpiresAt,
    tenantId: e.ENTRA_TENANT_ID!.trim().toLowerCase(), clientId: e.ENTRA_CLIENT_ID!.trim().toLowerCase(),
    clientSecret: e.ENTRA_CLIENT_SECRET!.trim(), redirectUri: redirect.toString(),
    demoMemberEmails: parseDemoMemberEmails(e.DEMO_MEMBER_EMAILS),
  };
}

/**
 * DEMO_MEMBER_EMAILS: comma-separated, lower-cased. A user whose email (from the verified Entra ID token, stored at sign-in)
 * is listed counts as an active Umoja member even without an employeeId. Demo override only; empty/unset = no overrides.
 * Entries are validated strictly because they are embedded in a SQL array literal (no quotes or backslashes can get through).
 */
export function parseDemoMemberEmails(raw: string | undefined): string[] {
  const list = (raw ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const e of list) if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e)) throw new Error('Refusing to start: DEMO_MEMBER_EMAILS has an entry that is not a plain email address');
  return [...new Set(list)];
}

const demoUserSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  roles: z.array(z.enum(['CampaignAdmin'])).max(1).default([]),
  employeeCode: z.string().max(32).nullable().optional(),
}).strict();
export interface DemoProfile { displayName: string; roles: string[]; employeeCode: string | null }

/** DEMO_USERS: JSON object email -> { displayName, roles, employeeCode }. Keys are lower-cased. Never echoes values on error. */
export function parseDemoUsers(raw: string | undefined): Record<string, DemoProfile> {
  if (!raw?.trim()) return {};
  let json: unknown;
  try { json = JSON.parse(raw); } catch { throw new Error('DEMO_USERS is not valid JSON'); }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('DEMO_USERS must be a JSON object of email -> profile');
  const out: Record<string, DemoProfile> = {};
  for (const [email, v] of Object.entries(json)) {
    const p = demoUserSchema.safeParse(v);
    if (!p.success || !email.includes('@')) throw new Error(`DEMO_USERS entry for "${email}" is invalid (needs displayName, optional roles ["CampaignAdmin"], optional employeeCode)`);
    const code = p.data.employeeCode == null ? null : normalizeEmployeeCode(p.data.employeeCode);
    if (p.data.employeeCode != null && code === null) throw new Error(`DEMO_USERS entry for "${email}" has a malformed employeeCode (expected e.g. TST0001)`);
    out[email.trim().toLowerCase()] = { displayName: p.data.displayName, roles: p.data.roles, employeeCode: code };
  }
  return out;
}

/** One line describing a config failure: names the keys, never their values. */
export function describeConfigError(e: unknown): string {
  if (e instanceof z.ZodError) return 'invalid or missing environment variables: ' + e.issues.map((i) => `${i.path.join('.') || '(root)'} (${i.message})`).join('; ');
  return e instanceof Error ? e.message : String(e);
}
export type Config = ReturnType<typeof parseConfig>;

let cached: Config | undefined;
export function getConfig(): Config {
  if (!cached) { loadDotEnv(); cached = parseConfig(process.env); }
  return cached;
}
