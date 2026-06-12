/**
 * Strom auth helper — getStromToken
 *
 * - STROM_AUTH_MODE=direct: returns the API key as-is (self-hosted Strom)
 * - STROM_AUTH_MODE=osc (default): exchanges the PAT for a short-lived SAT
 *   via the OSC token service (required for OSC-hosted Strom instances).
 *   Caches the SAT and refreshes it 5 min before expiry.
 */

const TOKEN_EXCHANGE_URL = 'https://token.svc.prod.osaas.io/servicetoken'
const STROM_SERVICE_ID = 'eyevinn-strom'
const REFRESH_BUFFER_MS = 5 * 60 * 1000 // refresh 5 min before expiry

interface SatCache {
  token: string
  expiresAt: number // unix ms
}

let cache: SatCache | null = null

// Clear cached token on shutdown so it doesn't linger in memory after process exit
// (heap dumps taken during graceful shutdown would otherwise expose the plaintext SAT)
process.once('SIGTERM', () => { cache = null })
process.once('SIGINT', () => { cache = null })

function isExpiringSoon(cache: SatCache): boolean {
  return Date.now() >= cache.expiresAt - REFRESH_BUFFER_MS
}

/**
 * Returns a valid Strom auth token.
 *
 * - STROM_AUTH_MODE=direct: returns the API key as-is (self-hosted Strom)
 * - STROM_AUTH_MODE=osc (default): exchanges the PAT for a short-lived SAT
 *   via the OSC token service (required for OSC-hosted Strom instances)
 *
 * Returns undefined if no token is configured (local dev without auth).
 */
export async function getStromToken(pat: string | undefined): Promise<string | undefined> {
  if (!pat) return undefined

  // Direct mode: API key is used as Bearer token without any exchange
  if (process.env['STROM_AUTH_MODE'] === 'direct') {
    return pat
  }

  if (cache && !isExpiringSoon(cache)) {
    return cache.token
  }

  const res = await fetch(TOKEN_EXCHANGE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      accept: 'application/json',
      'x-pat-jwt': `Bearer ${pat}`,
    },
    body: JSON.stringify({ serviceId: STROM_SERVICE_ID }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`SAT exchange failed: ${res.status} ${res.statusText} — ${body.slice(0, 200)}`)
  }

  const data = (await res.json()) as { token: string; expiry: number }
  cache = { token: data.token, expiresAt: data.expiry * 1000 }
  return cache.token
}
