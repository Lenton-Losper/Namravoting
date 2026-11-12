import { DurableObject } from 'cloudflare:workers';
import { toContainerRequest } from './forward';

/**
 * Routes every request to ONE container instance running the Express app (max_instances: 1, because the app's
 * rate limits are in memory). No extra dependency: this uses the Durable Object container API directly.
 *
 * Container env comes from the Worker's own env: plain vars from wrangler.jsonc, secrets from `wrangler secret put`.
 * The app gates every request on the Cloudflare Access JWT itself, so this Worker forwards headers untouched.
 */
interface Env {
  APP: DurableObjectNamespace<NamraContainer>;
  // secrets
  SESSION_SECRET: string; DEMO_USERS?: string; ENTRA_CLIENT_SECRET: string; DATABASE_URL: string; R2_ACCESS_KEY_ID: string; R2_SECRET_ACCESS_KEY: string; R2_ENDPOINT: string;
  // vars
  ENTRA_TENANT_ID: string; ENTRA_CLIENT_ID: string; ENTRA_REDIRECT_URI: string; ADMIN_EMAILS: string; DEMO_MEMBER_EMAILS: string; DEMO_BANNER: string; DEMO?: string; ADMIN_OIDS?: string; ADMIN_EMAILS_FALLBACK?: string; ENTRA_SECRET_EXPIRES_AT?: string;
  NODE_ENV: string; AUTH_MODE: string; STORAGE: string; R2_BUCKET: string; PUBLIC_BASE_URL: string;
  CF_ACCESS_TEAM_DOMAIN: string; CF_ACCESS_AUD: string; SLEEP_AFTER_MINUTES?: string;
}

const PORT = 8080;
const START_BUDGET_MS = 50_000;     // a Worker request may wait this long for a cold start before answering 503
const RECYCLE_AFTER_MS = 25_000;
const CONTAINER_ENV_KEYS = [
  'NODE_ENV', 'AUTH_MODE', 'STORAGE', 'R2_BUCKET', 'PUBLIC_BASE_URL', 'CF_ACCESS_TEAM_DOMAIN', 'CF_ACCESS_AUD',
  'SESSION_SECRET', 'DEMO_USERS', 'ENTRA_CLIENT_SECRET', 'ENTRA_TENANT_ID', 'ENTRA_CLIENT_ID', 'ENTRA_REDIRECT_URI', 'ADMIN_EMAILS', 'DEMO_MEMBER_EMAILS', 'DEMO_BANNER', 'DEMO', 'ADMIN_OIDS', 'ADMIN_EMAILS_FALLBACK', 'ENTRA_SECRET_EXPIRES_AT', 'DATABASE_URL', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ENDPOINT',
] as const;

function logError(what: string, e: unknown): void {
  console.error(what, e instanceof Error ? `${e.name}: ${e.message}
${e.stack ?? ''}` : String(e));
}

function startingUp(): Response {
  return new Response('Starting up, try again in a few seconds.', { status: 503, headers: { 'retry-after': '5', 'content-type': 'text/plain; charset=utf-8' } });
}

export class NamraContainer extends DurableObject<Env> {
  private lastTouch = 0;

  private starting: Promise<void> | null = null;

  /**
   * Starts the container if needed and waits until the app answers (any HTTP status counts as "up").
   * Concurrent requests share one start attempt. A start can fail transiently, e.g. right after a rollout while the
   * previous instance is still being torn down ("no container instance that can be provided"), so it is retried; a
   * container that is "running" but never answers is destroyed once and started afresh.
   */
  private ensureRunning(): Promise<void> {
    this.starting ??= this.startAndWait().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async startAndWait(): Promise<void> {
    const c = this.ctx.container;
    if (!c) throw new Error('Containers are not enabled for this Durable Object');
    const env: Record<string, string> = { PORT: String(PORT) };
    for (const k of CONTAINER_ENV_KEYS) { const v = (this.env as unknown as Record<string, string | undefined>)[k]; if (v) env[k] = v; }
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const t0 = Date.now();
    let recycled = false;
    let last: unknown;
    while (Date.now() - t0 < START_BUDGET_MS) {
      if (!c.running) {
        try { c.start({ env, enableInternet: true }); } catch (e) { last = e; logError('container start() failed, retrying', e); await sleep(2000); continue; }
      }
      try { await c.getTcpPort(PORT).fetch('http://container/__ready'); return; } catch (e) { last = e; }
      if (!recycled && Date.now() - t0 > RECYCLE_AFTER_MS && c.running) {
        recycled = true;
        logError('container running but not answering; recycling', last);
        try { await c.destroy(); } catch (e) { logError('container destroy() failed', e); }
      }
      await sleep(1000);
    }
    throw last instanceof Error ? last : new Error('The app did not start in time');
  }

  async fetch(request: Request): Promise<Response> {
    try {
      await this.ensureRunning();
    } catch (e) {
      logError('container start failed', e);
      return startingUp();
    }
    try {
      // Keep the instance warm: push the idle alarm out on activity (written at most every 30 s).
      const now = Date.now();
      if (now - this.lastTouch > 30_000) {
        this.lastTouch = now;
        const minutes = Number(this.env.SLEEP_AFTER_MINUTES ?? '60') || 60;
        await this.ctx.storage.setAlarm(now + minutes * 60_000);
      }
      return await this.ctx.container!.getTcpPort(PORT).fetch(toContainerRequest(request));
    } catch (e) {
      logError('forward to container failed', e);
      return startingUp();
    }
  }

  /** Idle timeout reached: stop the container (it restarts on the next request). */
  async alarm(): Promise<void> {
    const c = this.ctx.container;
    if (c?.running) await c.destroy();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await env.APP.get(env.APP.idFromName('demo')).fetch(request);
    } catch (e) {
      logError('worker fetch failed', e);
      return startingUp();
    }
  },
};
