/**
 * The URL path the app is served under (Vite `base`, set at build time from BASE_PATH, e.g. /voting-app). '' when served from the root.
 * Router links are prefixed by <BrowserRouter basename>; everything the browser itself requests or navigates to (fetch, plain links,
 * location changes) goes through withBase().
 */
export const BASE: string = (import.meta.env.BASE_URL ?? '/').replace(/\/+$/, '');

/** "/api/x" -> "/voting-app/api/x". App-relative paths only; anything else is returned unchanged. */
export function withBase(path: string): string {
  return path.startsWith('/') && !path.startsWith('//') ? BASE + path : path;
}

/** "/voting-app/votes" -> "/votes" (the path the router and the server's `next` checks work with). */
export function stripBase(pathname: string): string {
  return BASE && (pathname === BASE || pathname.startsWith(BASE + '/')) ? pathname.slice(BASE.length) || '/' : pathname;
}
