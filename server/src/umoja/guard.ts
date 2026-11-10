/**
 * The real HR member list must only ever go into a LOCAL database. Importing into anything else (a demo, staging
 * or production database) needs the explicit --allow-remote flag.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function dbHost(connectionString: string): string | null {
  try { return new URL(connectionString).hostname.toLowerCase(); } catch { return null; }
}

export function isLocalDatabase(connectionString: string): boolean {
  const h = dbHost(connectionString);
  return h !== null && LOCAL_HOSTS.has(h);
}

/** Throws unless the database is local or the caller passed --allow-remote. Unparseable URLs count as remote. */
export function assertImportAllowed(connectionString: string, allowRemote: boolean): void {
  if (allowRemote || isLocalDatabase(connectionString)) return;
  throw new Error(
    `Refusing to import: the database host "${dbHost(connectionString) ?? 'unknown'}" is not localhost. ` +
    'The Umoja member list must not be loaded into a remote database. Pass --allow-remote only if you are sure.');
}
