/**
 * Format- and context-based credential scanner for free text (commands, arguments, results, stderr).
 * Aligned with the HUB server scanner (`analytics/segredos.ts`) so the collector, which masks BEFORE anything is
 * exported, spooled, replayed or written to the failed log, no longer relies on a handful of patterns.
 *
 * Deliberately NOT ported: the generic high-entropy heuristic (it would rewrite long identifiers and code in
 * user content; the server keeps that safety net) and e-mail/CPF (PII, handled by the PII detectors).
 *
 * Masking never changes text that has no finding: normalization (NFKC, zero-width removal, %XX decoding) is only
 * used to SEE hidden secrets; when something is found the normalized, masked text is returned.
 */
export interface ScanResult { text: string; findings: number }

const APIKEY = '[APIKEY_MASKED]';
const URLPASS = '[DATABASEURL_MASKED]';
const PEM = '[PRIVATEKEY_MASKED]';
const ACCESSKEY = '[ACCESSKEY_MASKED]';
// Prefix only: a value token stops at ']' so the closing bracket is not part of what the value patterns see.
const ALREADY = /^\[(?:ACCESSKEY|APIKEY|PRIVATEKEY|DATABASEURL|IDCARD|PHONE|EMAIL|IP_ADDRESS|CREDIT_CARD)_MASKED/;

const STRONG_WORD = '(?:password|passwd|pwd|secret|private[_-]?key|accountkey|sharedaccesskey|api[_-]?key|apikey|access[_-]?key|authtoken|cred(?:ential)?s?|sig)';
// \u0004 marks a JSON-escaped quote (see escapeView); it may precede a quote on either side of a key-value pair.
const VALUE = `(\u0004?"[^"]*"|\u0004?'[^']*'|[^\\s&;,"'}\\]\u0004]+)`;
const QUOTE = `(?:\u0004?["'])?`;
const NEUTRAL = /^(?:true|false|null|none|undefined|yes|no|required|optional|omit|include|same-origin|\d{1,6})$/i;

/** Providers with their own format: the format is enough, no variable name needed. */
const FORMATS: ReadonlyArray<readonly [string, RegExp]> = [
  [PEM, /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g],
  [APIKEY, /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g], // JWT
  [APIKEY, /\bsk-[A-Za-z0-9_-]{16,}/g],
  [APIKEY, /\b[sr]k_(?:live|test)_[A-Za-z0-9]{8,}/g], // Stripe
  [APIKEY, /\bntcp_[A-Za-z0-9_-]{8,}/g], // NTConsult machine key
  [APIKEY, /\bnpm_[A-Za-z0-9]{20,}/g],
  [APIKEY, /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g],
  [APIKEY, /\bglpat-[A-Za-z0-9_-]{16,}/g],
  [APIKEY, /\bAIza[0-9A-Za-z_-]{30,}/g], // Google API key
  [APIKEY, /\bya29\.[A-Za-z0-9_-]{20,}/g], // Google OAuth
  [APIKEY, /\bxox[abposr]-[A-Za-z0-9-]{10,}/g], // Slack
  [ACCESSKEY, /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  [APIKEY, /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g], // SendGrid
  [APIKEY, /\bhf_[A-Za-z0-9]{30,}/g], // Hugging Face
  [APIKEY, /\b(?:AC|SK)[0-9a-f]{32}\b/g], // Twilio
  // Sentry DSN: the public key is the URL "user" (no password), so the URL-with-password rule does not see it.
  [APIKEY, /(?<=https?:\/\/)[0-9a-f]{20,}(?=@[^\s/]*sentry)/gi],
];

// The password may contain '@': it runs to the LAST '@' of the authority (before '/' or the end of the token).
const URL_WITH_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]*):([^\s/]+)@(?=[^\s@/]+)/gi;
const AUTHORIZATION = /\b(authorization|proxy-authorization)(["']?[ \t]*[:=][ \t]*)(?:(?:bearer|basic|token|digest)[- \t]+)?[^\s"',;]+/gi;
const BEARER = /\bbearer[ \t]+[A-Za-z0-9._~+/=-]{8,}/gi;
const BASIC = /\bBasic[ \t]+[A-Za-z0-9+/]{12,}={0,2}/g;
const COOKIE = /\b(cookie|set-cookie)([ \t]*:[ \t]*)[^\r\n\u0001\u0002]+/gi;
const FLAG = /(--(?:password|passwd|passphrase|token|secret|api-?key|auth-?token|access-?key|secret-?key|client-?secret))(?![\w-])([ =]+)(\S+)/gi;
const SSHPASS = /(\bsshpass[ \t]+-p[ \t]*)("[^"]*"|'[^']*'|\S+)/gi;
const CURL_USER = /([ \t](?:-u|--user)[ \t=]+)([^\s:'"]+):([^\s'"]+)/g;
// mysql/mariadb/psql: `-pSECRET` glued to the flag (with a space it is a port/path of other tools). Numeric-only and short values do not count.
// Only for the tools that take the password glued to -p, and only as a standalone token: never inside a longer flag
// (find -print0/-prune/-path, git log -pretty, ls -parents) or for tools where -p means port/parents/prefix.
const GLUED_P = /(\b(?:mysql|mysqldump|mysqladmin|mysqlcheck|mysqlimport|mysqlshow|mariadb|mariadb-dump|psql|7z|7za|7zr|unrar|rar|zip|unzip)\b.*?[ \t])(-p)(?=\S)(\S+)/g;
const CURL_HEADER = /((?:-H|--header)[ \t=]+["']?)([\w-]*(?:key|token|secret|auth|pass|cred|sig|cookie)[\w-]*)([ \t]*:[ \t]*)([^"'\n\u0001\u0002\u0004]+)/gi;
// Hex of 32 to 64 characters is a hash by default (commit, digest); with a suggestive NAME right before it, it is a key.
const NAMED_HEX = /\b((?:key|secret|token|pass(?:word|wd)?|sig(?:nature)?|credential|auth|api[-_ ]?key)\b["']?[ \t:=]+["']?)([0-9a-f]{32,64})\b/gi;
const QUERY_SECRET = /([?&](?:access_token|refresh_token|id_token|auth_token|token|api[_-]?key|apikey|key|secret|client_secret|password|passwd|pwd|sig|signature|code)=)([^&\s#"']+)/gi;

// --- Credentials by ARGUMENT POSITION of well-known tools (the value has no name or format of its own) ---
// One command per line: the tool and its flag must be on the same line and not cross a shell separator.
const LINE = String.raw`.*?`;
/** Tool rules run per command segment (split at newline, pipe, ; and &) and only up to this size: bounded, linear work. */
const MAX_SEGMENT = 8 * 1024;
const SEGMENT = /[^\n|;&\u0001\u0002]+/g;
// htpasswd -b FILE USER PASS | -nb USER PASS: flags first, then positionals; with -n there is no FILE.
const HTPASSWD = /\bhtpasswd((?:[ \t]+-[A-Za-z]+(?:[ \t]+\d+(?=[ \t]))?)+)((?:[ \t]+[^\s-]\S*){2,3})/g;
const OPENSSL_PASS = new RegExp(String.raw`(\bopenssl\b${LINE}[ \t]-pass(?:in|out)?[ \t=]+pass:)(\S+)`, 'g');
const OPENSSL_K = new RegExp(String.raw`(\bopenssl\b${LINE}[ \t]-k[ \t]+)(\S+)`, 'g');
const REGISTRY_LOGIN = new RegExp(String.raw`(\b(?:docker|podman|nerdctl|buildah|skopeo|az|crane|oras|helm)\b${LINE}\blogin\b${LINE}[ \t]-p[ \t=]+)(\S+)`, 'g');
const ZIP_P = new RegExp(String.raw`(\b(?:zip|unzip|zipcloak)\b${LINE}[ \t]-P[ \t]?)(\S+)`, 'g');
const REDIS_A = new RegExp(String.raw`(\bredis-cli\b${LINE}[ \t](?:-a|--pass)[ \t]+)(\S+)`, 'g');
const VAULT_LOGIN = /(\bvault[ \t]+login(?:[ \t]+-\S+)*[ \t]+)([^\s=-][^\s=]*)(?=\s|$)/g;
const AWS_CONFIGURE_SET = /(\baws_(?:secret_access_key|session_token)[ \t]+)(\S+)/gi;
// "the password is hunter2": prose with an obvious verb; ordinary adjectives after it are not a secret.
const PASSWORD_IS = /(\b(?:password|passwd|passphrase)[ \t]+(?:is|was|=|:)[ \t]+)(["']?)([^\s"']+)/gi;
const PROSE_VALUES = /^(?:required|optional|invalid|incorrect|wrong|correct|empty|missing|set|unset|hashed|stored|case-sensitive|expired|valid|weak|strong|too|not|the|a|an|your|my|reset|changed|updated|rotated|encrypted|masked|redacted|hidden|blank|none|null|unknown|n\/a|ok|fine|long|short|secure|insecure|mandatory|ignored|needed|checked|verified|accepted|rejected|denied)$/i;
// A credential WORD followed by a suffix that names something else (a URL, policy, length, file ...): not a secret value.
const NON_SECRET_SUFFIX = /^[_.-](?:reset|policy|min|max|len|length|field|label|url|uri|link|page|form|input|prompt|placeholder|hint|help|text|type|mode|strength|rules?|required|expire[sd]?|expiry|age|changed|updated|history|attempts?|count|error|message|msg|file|path|dir|env|var|name)(?![a-z])/i;
const ASSIGN_STRONG = new RegExp(`\\b([A-Za-z0-9_.-]*(?:${STRONG_WORD.slice(3, -1)}|token)[A-Za-z0-9_]*)(${QUOTE}[ \\t]*[=:][ \\t]*)${VALUE}`, 'gi');
// DB_PASS / db_passw / APP-PASSWD: `pass` only counts as the suffix of a compound name, never the bare word.
const ASSIGN_PASS = new RegExp(`\\b([A-Za-z0-9]+(?:[_-][A-Za-z0-9]+)*[_-]pass(?:w|wd|word)?)(${QUOTE}[ \\t]*[=:][ \\t]*)${VALUE}`, 'gi');
const UPPER_ENV = /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD))(=)(\S+)/g;
const STRONG = new RegExp(STRONG_WORD, 'i');
const NAME_WORD = new RegExp(`(?:${STRONG_WORD.slice(3, -1)}|token)`, 'gi');

/**
 * The variable name must END a word on the credential word: `secretKey`, `db_password`, `AUTH_TOKEN` count;
 * `secretary`, `tokenizer`, `passwordless` (a lowercase letter right after the word) are ordinary identifiers.
 */
function namesACredential(name: string): boolean {
  for (const match of name.matchAll(NAME_WORD)) {
    const end = (match.index ?? 0) + match[0].length;
    const next = name[end];
    if (next !== undefined && NON_SECRET_SUFFIX.test(name.slice(end))) continue;
    if (next === undefined || !/[a-z]/.test(next)) return true;
  }
  return false;
}

const ZERO_WIDTH = /[​-‍⁠﻿­]/g;
const CHUNK_CHARS = 256 * 1024;

/**
 * Tool arguments/results are often JSON text, where a newline is the two characters `\n` (so `\bCookie` would not
 * start a word) and quotes are `\"`. Map those escapes to single control characters for the scan and back afterwards;
 * skipped when the text already contains those characters.
 */
const ESCAPES: ReadonlyArray<readonly [string, string]> = [['\\n', '\u0001'], ['\\r', '\u0002'], ['\\t', '\u0003'], ['\\"', '\u0004"']];
const HAS_MARKERS = /[\u0001-\u0004]/;
function escapeView(text: string): string {
  if (HAS_MARKERS.test(text) || !text.includes('\\')) return text;
  return ESCAPES.reduce((t, [from, to]) => t.split(from).join(to), text);
}
function restoreEscapes(text: string): string {
  // A lone \u0004 is an escaped quote whose quote character a masked value consumed: restore it as `\"`.
  return text.replace(/\u0004"/g, '\\"').replace(/\u0001/g, '\\n').replace(/\u0002/g, '\\r').replace(/\u0003/g, '\\t').replace(/\u0004/g, '\\"');
}

function scanText(text: string): ScanResult {
  const normalized = normalizeForScan(text);
  const view = escapeView(normalized);
  const result = scan(view);
  return result.findings === 0 || view === normalized ? result : { text: restoreEscapes(result.text), findings: result.findings };
}

function normalizeForScan(text: string): string {
  let t = text.normalize('NFKC').replace(ZERO_WIDTH, '');
  if (/%[0-9a-f]{2}/i.test(t)) t = t.replace(/(?:%[0-9a-f]{2})+/gi, m => { try { return decodeURIComponent(m); } catch { return m; } });
  return t;
}

export function scanCredentials(text: string): ScanResult {
  if (text.length === 0) return { text, findings: 0 };
  if (text.length <= CHUNK_CHARS) return finish(text, scanText(text));
  // Pathological sizes: scan in chunks cut at whitespace so the work stays bounded and no tail is left unscanned.
  let findings = 0;
  const parts: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + CHUNK_CHARS, text.length);
    if (end < text.length) {
      const cut = text.lastIndexOf('\n', end) > start ? text.lastIndexOf('\n', end) : text.lastIndexOf(' ', end);
      if (cut > start) end = cut + 1;
    }
    const part = scanText(text.slice(start, end));
    findings += part.findings;
    parts.push(part.findings === 0 ? text.slice(start, end) : part.text);
    start = end;
  }
  return findings === 0 ? { text, findings: 0 } : { text: parts.join(''), findings };
}

/** No finding: the original text is returned untouched (normalization only exists to SEE hidden secrets). */
function finish(original: string, result: ScanResult): ScanResult {
  return result.findings === 0 ? { text: original, findings: 0 } : result;
}

function scan(base: string): ScanResult {
  let findings = 0;
  const hit = (token: string) => () => { findings += 1; return token; };
  const done = (value: string) => ALREADY.test(value.replace(/^["']/, ''));
  const positional = (segment: string): string => {
    let out = segment.replace(HTPASSWD, (m, flags: string, args: string) => {
      if (!/[ \t]-[A-Za-z]*b/.test(flags)) return m; // batch mode only: the password is on the command line
      const parts = args.match(/[ \t]+\S+/g) ?? [];
      const passwordAt = /[ \t]-[A-Za-z]*n/.test(flags) ? 1 : 2; // -n: USER PASS, otherwise FILE USER PASS
      if (parts.length <= passwordAt || done(parts[passwordAt]!.trim())) return m;
      findings += 1;
      return `htpasswd${flags}${parts.map((part, i) => (i === passwordAt ? part.replace(/\S+/, APIKEY) : part)).join('')}`;
    });
    for (const re of [OPENSSL_PASS, OPENSSL_K, REGISTRY_LOGIN, ZIP_P, REDIS_A, VAULT_LOGIN, AWS_CONFIGURE_SET]) {
      out = out.replace(re, (m, head: string, value: string) => (done(value) || NEUTRAL.test(value) && re !== VAULT_LOGIN ? m : (findings += 1, `${head}${APIKEY}`)));
    }
    return out.replace(GLUED_P, (m, head: string, flag: string, value: string) => (done(value) || /^\d+$/.test(value) || value.startsWith('-') ? m : (findings += 1, `${head}${flag}${APIKEY}`)));
  };
  let t = base;
  for (const [token, re] of FORMATS) t = t.replace(re, hit(token));
  t = t.replace(URL_WITH_PASSWORD, (m, scheme: string, user: string, pass: string) => {
    if (done(pass)) return m;
    findings += 1; return `${scheme}${user}:${URLPASS}@`;
  });
  t = t.replace(AUTHORIZATION, (m, name: string, sep: string) => {
    if (done(m.slice(name.length + sep.length).replace(/^(?:bearer|basic|token|digest)[-\s]+/i, ''))) return m;
    findings += 1; return `${name}${sep}${APIKEY}`;
  });
  t = t.replace(BEARER, hit(APIKEY)).replace(BASIC, hit(APIKEY));
  t = t.replace(COOKIE, (m, name: string, sep: string) => (done(m.slice(name.length + sep.length)) ? m : (findings += 1, `${name}${sep}${APIKEY}`)));
  t = t.replace(QUERY_SECRET, (m, pre: string, value: string) => (done(value) || NEUTRAL.test(value) ? m : (findings += 1, `${pre}${APIKEY}`)));
  t = t.replace(SEGMENT, segment => (segment.length > MAX_SEGMENT ? segment : positional(segment)));
  t = t.replace(PASSWORD_IS, (m, head: string, quote: string, value: string) => (done(value) || PROSE_VALUES.test(value) ? m : (findings += 1, `${head}${quote}${APIKEY}`)));
  t = t.replace(FLAG, (m, flag: string, sep: string, value: string) => (done(value) ? m : (findings += 1, `${flag}${sep}${APIKEY}`)));
  t = t.replace(SSHPASS, (m, pre: string, value: string) => (done(value) ? m : (findings += 1, `${pre}${APIKEY}`)));
  t = t.replace(CURL_USER, (m, pre: string, user: string, pass: string) => (done(pass) ? m : (findings += 1, `${pre}${user}:${APIKEY}`)));
  t = t.replace(CURL_HEADER, (m, pre: string, name: string, sep: string, value: string) => (done(value.trim()) ? m : (findings += 1, `${pre}${name}${sep}${APIKEY}`)));
  t = t.replace(NAMED_HEX, (m, pre: string, hex: string) => (done(hex) ? m : (findings += 1, `${pre}${APIKEY}`)));
  t = t.replace(ASSIGN_PASS, (m, name: string, sep: string, value: string) => {
    const clean = value.replace(/["']/g, '');
    if (done(clean) || NEUTRAL.test(clean)) return m;
    findings += 1; return `${name}${sep}${APIKEY}`;
  });
  t = t.replace(ASSIGN_STRONG, (m, name: string, sep: string, value: string) => {
    if (done(value) || !namesACredential(name)) return m;
    const clean = value.replace(/["']/g, '');
    // A bare "token" is also a counter/limit (max_tokens=4096): it only counts with a credential-looking value.
    if (!STRONG.test(name) && (clean.length < 8 || /^\d+$/.test(clean))) return m;
    if (NEUTRAL.test(clean)) return m; // credentials: 'include', pass=true, sig=1 are not secrets
    findings += 1; return `${name}${sep}${APIKEY}`;
  });
  t = t.replace(UPPER_ENV, (m, name: string, sep: string, value: string) => (done(value) ? m : (findings += 1, `${name}${sep}${APIKEY}`)));
  return { text: t, findings };
}
