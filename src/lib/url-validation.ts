/**
 * URL validation helpers for security-sensitive inputs.
 *
 * Rules:
 * - httpUrlOnly: allow only http/https, reject private/loopback IP ranges
 * - graphicUrl:  httpUrlOnly OR safe data: image URIs (no svg, no text/html)
 * - srtUrl:      srt:// scheme only, reject private/loopback hosts
 */

const PRIVATE_HOST_RE = /^(127\.|10\.|192\.168\.|169\.254\.|::1$|fe80:)/i;

function isPrivateHost(hostname: string): boolean {
  // 172.16.0.0/12
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
  return PRIVATE_HOST_RE.test(hostname);
}

/**
 * Throws if the URL is not a safe http/https URL pointing to a public host.
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
  if (isPrivateHost(parsed.hostname)) {
    throw new Error(`Private/loopback host "${parsed.hostname}" is not allowed`);
  }
}

const ALLOWED_IMAGE_MIME = /^data:image\/(png|jpeg|gif|webp);base64,/i;
const BLOCKED_SCHEMES = /^(file|javascript|ftp|gopher|chrome|about|data:text\/html|data:application):/i;

/**
 * Throws if the value is not a safe graphic URL.
 * Accepts: http/https URLs to public hosts, or data:image/(png|jpeg|gif|webp) base64 URIs.
 * Rejects: file://, javascript:, data:text/html, data:image/svg+xml (can carry scripts), etc.
 */
export function graphicUrl(url: string): void {
  if (BLOCKED_SCHEMES.test(url)) {
    throw new Error(`Disallowed URL scheme in graphic URL`);
  }
  if (url.startsWith('data:')) {
    if (!ALLOWED_IMAGE_MIME.test(url)) {
      throw new Error('Only data:image/(png|jpeg|gif|webp) base64 URIs are allowed for graphics');
    }
    return; // valid data URI
  }
  // Otherwise must be a safe http/https URL
  httpUrlOnly(url);
}

/**
 * Throws if the value is not a safe SRT URL pointing to a public host.
 */
export function srtUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid SRT URL: ${url}`);
  }
  if (parsed.protocol !== 'srt:') {
    throw new Error(`Disallowed URL scheme "${parsed.protocol}" — only srt:// allowed`);
  }
  if (!parsed.hostname) {
    throw new Error('SRT URL must have a hostname');
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new Error(`Private/loopback host "${parsed.hostname}" is not allowed in SRT URL`);
  }
  // Reject injection-prone characters in the query string
  if (/[!; ]/.test(parsed.search)) {
    throw new Error('SRT URL query string contains disallowed characters');
  }
}
