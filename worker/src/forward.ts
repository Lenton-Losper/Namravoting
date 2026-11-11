/**
 * Containers only accept plain HTTP from the Worker ("Connecting to a container using HTTPS is not currently
 * supported"), but the incoming request URL is https://. Rebuild it with the http scheme; method, headers and body
 * (including the Cf-Access-Jwt-Assertion header the app verifies, and multipart uploads) are carried over untouched.
 * Redirects are NOT followed here: the browser must see them. X-Forwarded-* tell the app the public origin.
 */
export function toContainerRequest(request: Request): Request {
  const original = new URL(request.url);
  const url = new URL(original);
  url.protocol = 'http:';
  const headers = new Headers(request.headers);
  if (!headers.has('x-forwarded-host')) headers.set('x-forwarded-host', original.host);
  if (!headers.has('x-forwarded-proto')) headers.set('x-forwarded-proto', original.protocol.replace(':', ''));
  return new Request(url.toString(), new Request(request, { headers, redirect: 'manual' }));
}
