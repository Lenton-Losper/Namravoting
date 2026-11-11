/**
 * Containers only accept plain HTTP from the Worker ("Connecting to a container using HTTPS is not currently
 * supported"), but the incoming request URL is https://. Rebuild it with the http scheme; method, headers and body
 * (including the Cf-Access-Jwt-Assertion header the app verifies) are carried over untouched.
 */
export function toContainerRequest(request: Request): Request {
  const url = new URL(request.url);
  url.protocol = 'http:';
  return new Request(url.toString(), request);
}
