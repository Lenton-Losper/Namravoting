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
  SESSION_SECRET: string; DATABASE_URL: string; R2_ACCESS_KEY_ID: string; R2_SECRET_ACCESS_KEY: string; R2_ENDPOINT: string;
  // vars
  NODE_ENV: string; AUTH_MODE: string; STORAGE: string; R2_BUCKET: string; PUBLIC_BASE_URL: string;
  CF_ACCESS_TEAM_DOMAIN: string; CF_ACCESS_AUD: string; SLEEP_AFTER_MINUTES?: string;
}

const PORT = 8080;
const CONTAINER_ENV_KEYS = [
  'NODE_ENV', 'AUTH_MODE', 'STORAGE', 'R2_BUCKET', 'PUBLIC_BASE_URL', 'CF_ACCESS_TEAM_DOMAIN', 'CF_ACCESS_AUD',
  'SESSION_SECRET', 'DATABASE_URL', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ENDPOINT',
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

  /** Starts the container if needed and waits until the app answers (any HTTP status counts as "up"). */
  private async ensureRunning(): Promise<void> {
    const c = this.ctx.container;
    if (!c) throw new Error('Containers are not enabled for this Durable Object');
    if (!c.running) {
      const env: Record<string, string> = { PORT: String(PORT) };
      for (const k of CONTAINER_ENV_KEYS) { const v = (this.env as unknown as Record<string, string | undefined>)[k]; if (v) env[k] = v; }
      c.start({ env, enableInternet: true });
    }
    const port = c.getTcpPort(PORT);
    for (let i = 0; i < 60; i++) {
      try { await port.fetch('http://container/__ready'); return; } catch { await new Promise((r) => setTimeout(r, 1000)); }
    }
    throw new Error('The app did not start in time');
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
