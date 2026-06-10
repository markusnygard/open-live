function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

/**
 * Builds the CouchDB server root URL.
 *
 * New style — credentials as separate vars (preferred for local dev and new deployments):
 *   COUCHDB_URL=https://host/   COUCHDB_USER=admin   COUCHDB_PASSWORD=secret
 *
 * Old style — credentials embedded in URL (backward compat for existing deployments):
 *   COUCHDB_URL=https://admin:secret@host/
 *
 * If COUCHDB_PASSWORD is absent the URL is used as-is.
 */
function buildCouchdbUrl(): string {
  const raw = requireEnv('COUCHDB_URL');
  const user = process.env['COUCHDB_USER'];
  const password = process.env['COUCHDB_PASSWORD'];
  if (!password) return raw;
  const url = new URL(raw);
  if (user) url.username = user;
  url.password = password;
  return url.toString();
}

export const config = {
  port: parseInt(process.env['PORT'] ?? '3000', 10),
  couchdbUrl: buildCouchdbUrl(),
  stromUrl: process.env['STROM_URL'] ?? 'http://localhost:7000',
  /** STROM_AUTH_TOKEN is the preferred name; STROM_TOKEN kept for backward compat. */
  stromToken: process.env['STROM_AUTH_TOKEN'] ?? process.env['STROM_TOKEN'] ?? undefined,
  /** 'osc' = PAT→SAT exchange via token.svc.prod.osaas.io (default for OSC-hosted Strom)
   *  'direct' = API key used as Bearer token directly (self-hosted / non-OSC Strom) */
  stromAuthMode: (process.env['STROM_AUTH_MODE'] ?? 'osc') as 'osc' | 'direct',
  logLevel: process.env['LOG_LEVEL'] ?? 'info',
} as const;
