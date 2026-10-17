/**
 * The ONLY way a git remote becomes `git.repo` / `git.domain`. A remote is repository-controlled text that may
 * carry credentials (userinfo, query, fragment), local paths or transport helpers, so it is parsed, never
 * pattern-chopped, and anything that is not a well-formed https/ssh/git URL or a strict scp-like address is
 * dropped whole (no repo, no domain): the raw value is never exported. Imports nothing (no cycles).
 *
 * Identity rules: repo = path without leading/trailing slashes and `.git`; domain = lower-case HOST ONLY. The
 * port is deliberately not part of the identity: https (443) and ssh (22 or custom) addresses of one instance
 * must map to the same repo/domain, and a port never carries meaning for repo mapping. userinfo, query and
 * fragment are dropped by construction.
 */
export interface RemoteIdentity { repo: string; domain: string }

const MAX_CHARS = 500;
const ALLOWED_SCHEMES = new Set(['https:', 'ssh:', 'git:']);
const HOST = /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:.]+\])$/;
const SCP_LIKE = /^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.?):([^\s?#:@\\]+)$/;
const SLUG = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/;

const SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Every path segment must be a plain slug segment: parameters (`;jsessionid=`), `@`, `:`, spaces etc. are rejected. */
function cleanPath(path: string): string | undefined {
  let value: string;
  try { value = decodeURIComponent(path); } catch { return undefined; }
  value = value.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  if (!value) return undefined;
  return value.split('/').every(part => part !== '.' && part !== '..' && SEGMENT.test(part)) ? value : undefined;
}

/** Lower-case, and one trailing dot (fully-qualified form) removed; the result must be a valid host. */
function normalizeHost(host: string): string | undefined {
  const value = host.toLowerCase().replace(/\.$/, '');
  return HOST.test(value) ? value : undefined;
}

/** Hosts that name this machine, whatever the form: their repo path is a local path, not a remote identity. */
function isLoopback(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || /^127(?:\.\d{1,3}){3}$/.test(host) || host === '[::1]' || host === '::1';
}

export function parseRemote(raw: unknown): RemoteIdentity | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim();
  if (!text || text.length > MAX_CHARS || /[\s\u0000-\u001f\u007f\\]/.test(text)) return undefined;

  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text)) {
    let url: URL;
    try { url = new URL(text); } catch { return undefined; }
    if (!ALLOWED_SCHEMES.has(url.protocol)) return undefined;
    const domain = normalizeHost(url.hostname);
    const repo = cleanPath(url.pathname);
    return repo && domain && !isLoopback(domain) ? { repo, domain } : undefined;
  }

  const scp = SCP_LIKE.exec(text);
  if (!scp) return undefined;
  const [, host, path] = scp;
  if (host!.length < 2) return undefined; // a single letter is a Windows drive, not a host
  const repo = cleanPath(path!);
  const domain = normalizeHost(host!);
  if (!repo || !domain || isLoopback(domain)) return undefined;
  // `host:/abs/path` with a one-label host is a local-looking path (a shell-style `devbox:/home/x`), not a remote.
  if (path!.startsWith('/') && !domain.includes('.')) return undefined;
  return { repo, domain };
}

/** Hook-supplied repo: a full remote goes through the parser; a plain `org/repo` slug is accepted as is. */
export function sanitizeRepoValue(raw: unknown): string | undefined {
  const parsed = parseRemote(raw);
  if (parsed) return parsed.repo;
  if (typeof raw !== 'string') return undefined;
  const slug = raw.trim().replace(/\.git$/, '');
  return slug.length <= MAX_CHARS && SLUG.test(slug) && !slug.split('/').some(part => part === '.' || part === '..') ? slug : undefined;
}

/** Hook-supplied domain: a host (an optional port is dropped) or a full remote; anything else is dropped. */
export function sanitizeDomainValue(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const parsed = parseRemote(raw);
  if (parsed) return parsed.domain;
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.?)(?::\d{1,5})?$/.exec(raw.trim());
  const host = match && match[1]!.length <= 253 ? normalizeHost(match[1]!) : undefined;
  return host && !isLoopback(host) ? host : undefined;
}
