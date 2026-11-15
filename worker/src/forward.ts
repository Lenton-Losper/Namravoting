/**
 * Containers only accept plain HTTP from the Worker ("Connecting to a container using HTTPS is not currently
 * supported"), but the incoming request URL is https://. Rebuild it with the http scheme; method, headers and body
 * (including the Cf-Access-Jwt-Assertion header the app verifies, and multipart uploads) are carried over untouched.
 * Redirects are NOT followed here: the browser must see them.
 *
 * SEC-25: the forwarding headers are set HERE, never taken from the client. Anything a client sends in X-Forwarded-*, Forwarded or
 * X-Real-IP is dropped and replaced with what the Worker itself saw: the public host and scheme of this request, and the client
 * address Cloudflare recorded (CF-Connecting-IP, which Cloudflare's edge sets and overwrites). The app uses CF-Connecting-IP for
 * its per-address rate limits and does not trust the others for anything.
 */
const CLIENT_FORWARDING_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-forwarded-server', 'forwarded', 'x-real-ip', 'x-original-url', 'x-original-host', 'x-rewrite-url'];

export function toContainerRequest(request: Request): Request {
  const original = new URL(request.url);
  const url = new URL(original);
  url.protocol = 'http:';
  const headers = new Headers(request.headers);
  for (const h of CLIENT_FORWARDING_HEADERS) headers.delete(h);
  headers.set('x-forwarded-host', original.host);
  headers.set('x-forwarded-proto', original.protocol.replace(':', ''));
  const client = request.headers.get('cf-connecting-ip');
  if (client) headers.set('x-forwarded-for', client);
  return new Request(url.toString(), new Request(request, { headers, redirect: 'manual' }));
}

/**
 * A fingerprint of the settings a container is started with (SHA-256 over the sorted KEY=value pairs; the values never leave this
 * function). The Worker stores it when it starts the container and compares it on the next request: when Cloudflare rolls a new image
 * onto a RUNNING container it keeps the old start settings, so a change of AUTH_MODE or a secret would otherwise not take effect until
 * the container happened to stop.
 */
export async function envFingerprint(env: Record<string, string>): Promise<string> {
  const text = Object.keys(env).sort().map((k) => `${k}=${env[k]}`).join('\n');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
