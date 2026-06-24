/**
 * URL validation helpers for security-sensitive inputs.
 *
 * Rules:
 * - httpUrlOnly: allow only http/https schemes with no private-IP targets
 * - graphicUrl:  httpUrlOnly OR safe data: image URIs (no svg, no text/html)
 * - srtUrl:      srt:// scheme only
 */

/**
 * Matches IPv4 literals in RFC 1918, loopback, link-local, and broadcast ranges.
 * Also matches IPv6 loopback (::1) and ULA prefixes (fc/fd).
 *
 * Note: this guards against IP literals used directly as hostnames. Hostnames
 * that *resolve* to private IPs require a DNS-lookup check that is not done
 * here; the defence-in-depth for that is network-level egress filtering on
 * the Strom host.
 */
const PRIVATE_IP_RE =
  /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.0\.0\.0|::1$|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:)/i;

/** Hostnames that resolve to loopback or link-local addresses. */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal', // GCP metadata endpoint
]);

/**
 * Throws if the URL is not a safe http/https URL.
 * Rejects private IP ranges (RFC 1918, loopback, link-local, AWS IMDS)
 * used as IP literals or well-known SSRF hostnames.
 */
export function httpUrlOnly(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Disallowed URL scheme "${parsed.protocol}" — only http/https allowed`);
  }
  if (!parsed.hostname) {
    throw new Error('URL must have a hostname');
  }
  // Strip surrounding brackets from IPv6 literals (e.g. [::1] → ::1)
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (PRIVATE_IP_RE.test(hostname)) {
    throw new Error(`URL hostname "${hostname}" is in a private/reserved IP range — SSRF blocked`);
  }
  if (BLOCKED_HOSTNAMES.has(hostname.toLowerCase())) {
    throw new Error(`URL hostname "${hostname}" is not allowed — SSRF blocked`);
  }
}

const ALLOWED_DATA_MIME = /^data:(text\/html|image\/(png|jpeg|gif|webp))[;,]/i;
const BLOCKED_SCHEMES = /^(file|javascript|ftp|gopher|chrome|about|data:application):/i;

/**
 * Throws if the value is not a safe graphic URL.
 * Accepts: http/https URLs, data:text/html (inline HTML overlays rendered by Strom's headless browser),
 *          or data:image/(png|jpeg|gif|webp) base64 URIs.
 * Rejects: file://, javascript:, data:application/*, etc.
 */
export function graphicUrl(url: string): void {
  if (BLOCKED_SCHEMES.test(url)) {
    throw new Error(`Disallowed URL scheme in graphic URL`);
  }
  if (url.startsWith('data:')) {
    if (!ALLOWED_DATA_MIME.test(url)) {
      throw new Error('Only data:text/html or data:image/(png|jpeg|gif|webp) URIs are allowed for graphics');
    }
    return;
  }
  // Otherwise must be a safe http/https URL with no private IP
  httpUrlOnly(url);
}

// srt://<host>:<port>[?params] or srt://:<port>[?params] (empty host = bind all interfaces)
const SRT_URL_RE = /^srt:\/\/[^!; ]*$/i;

/**
 * Throws if the value is not a valid SRT URL.
 */
export function srtUrl(url: string): void {
  if (!url.startsWith('srt://')) {
    throw new Error('Only srt:// URLs are allowed');
  }
  if (!SRT_URL_RE.test(url)) {
    throw new Error('SRT URL contains disallowed characters');
  }
}
