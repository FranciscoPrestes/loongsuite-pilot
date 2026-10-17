import { describe, expect, it } from 'vitest';
import { loadMaskPlan } from '../../../src/mask/rule-loader.js';
import { maskString } from '../../../src/mask/string-masker.js';
import { scanCredentials } from '../../../src/mask/credential-scanner.js';
import { SUPPORTED_MASK_TYPES } from '../../../src/types/index.js';

// Credential types only: PII (e-mail, phone, ...) is a separate concern with its own tests.
const plan = loadMaskPlan({ mode: 'custom', types: SUPPORTED_MASK_TYPES.filter(t => ['cloudAccessKey', 'apiKey', 'privateKey', 'databaseUrl'].includes(t)), replacementMode: 'placeholder' });
const mask = (value: string) => maskString(value, plan);
const S = 'SEKRETvalue9X'; // marker: must never survive
const alnum = (n: number) => 'aB3dE5gH7jK9mN1pQ4sT6vW8yZ2cF0hL'.repeat(3).slice(0, n);

/** [name, input, secret fragments that must be gone]. */
const POSITIVE: Array<[string, string, string[]]> = [
  ['bearer header', `Authorization: Bearer ${alnum(30)}${S}`, [S]],
  ['bearer in curl', `curl -H "Authorization: Bearer ${alnum(24)}${S}" https://api.example.com`, [S]],
  ['basic header', `Authorization: Basic dXNlcjoke${S}Cg==`, [`dXNlcjoke${S}`]],
  ['proxy authorization', `Proxy-Authorization: Basic YWxhZGRpbjpvcGVuc2VzYW1l${S}`, [S]],
  ['jwt', `token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIke${S}In0.abcd1234efgh`, [`eyJzdWIi`]],
  ['ntcp key', `NTC_KEY=ntcp_${alnum(24)}${S}`, [S]],
  ['password equals', `password=${S}`, [S]],
  ['password colon quoted', `passwd: "${S}"`, [S]],
  ['json password', `{"password":"${S}","user":"bob"}`, [S]],
  ['json token', `{"token":"${S}abcdefgh"}`, [S]],
  ['npm token', `//registry.npmjs.org/:_authToken=npm_${alnum(36)}${S}`, [S]],
  ['npm token bare', `npm_${alnum(36)}${S}`, [S]],
  ['stripe live', `sk_live_${alnum(24)}${S}`, [S]],
  ['stripe restricted', `rk_test_${alnum(24)}${S}`, [S]],
  ['openai style', `sk-${alnum(40)}${S}`, [S]],
  ['google api key', `key AIza${alnum(35)}${S}`, [S]],
  ['slack bot', `xoxb-1234567890-${alnum(20)}${S}`, [S]],
  ['slack user', `xoxp-1234567890-${alnum(20)}${S}`, [S]],
  ['azure account key', `DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=${alnum(40)}${S}==;EndpointSuffix=core.windows.net`, [S]],
  ['github pat', `ghp_${alnum(36)}${S}`, [S]],
  ['github fine grained', `github_pat_${alnum(40)}${S}`, [S]],
  ['gitlab pat', `glpat-${alnum(20)}${S}`, [S]],
  ['aws access key', `AKIAIOSFODNN7EXAMPLE and ASIAIOSFODNN7EXAMPLE`, ['AKIAIOSFODNN7EXAMPLE', 'ASIAIOSFODNN7EXAMPLE']],
  ['aws secret env', `export AWS_SECRET_ACCESS_KEY=${alnum(30)}/${S}+x==`, [S]],
  ['pem block', `-----BEGIN RSA PRIVATE KEY-----\nMIIEow${S}\n-----END RSA PRIVATE KEY-----`, [S]],
  ['pem openssh', `-----BEGIN OPENSSH PRIVATE KEY-----\n${S}\n-----END OPENSSH PRIVATE KEY-----`, [S]],
  ['postgres url', `postgres://app:${S}@db.internal:5432/app`, [S]],
  ['url password with @', `mysql://root:pa@${S}@db.internal/app`, [S, 'pa@']],
  ['mongodb srv url', `mongodb+srv://user:${S}@cluster0.abcde.mongodb.net/test`, [S]],
  ['https url with password', `git clone https://bob:${S}@github.com/org/repo.git`, [S]],
  ['sqlserver connection string', `Server=db;Database=x;User Id=sa;Password=${S};`, [S]],
  ['jdbc password', `jdbc:postgresql://db/app?user=a&password=${S}`, [S]],
  ['cookie header', `Cookie: sessionid=${S}; theme=dark`, [S]],
  ['set-cookie header', `Set-Cookie: sid=${S}; HttpOnly; Secure`, [S]],
  ['query access_token', `GET https://api.example.com/v1/items?access_token=${S}&page=2`, [S]],
  ['query api_key', `https://maps.example.com/api?api_key=${S}`, [S]],
  ['query sig', `https://blob.example.net/c/x?sv=2020&sig=${S}%3D&se=2030`, [S]],
  ['mysql glued -p', `mysql -uroot -p${S} appdb`, [S]],
  ['sshpass', `sshpass -p '${S}' ssh user@host`, [S]],
  ['curl -u', `curl -u admin:${S} https://internal.example.com/x`, [S]],
  ['flag password', `tool --password ${S} --verbose`, [S]],
  ['flag token equals', `tool --token=${S}`, [S]],
  ['percent encoded', `password%3D${S}`, [S]],
  ['zero width inside name', `pass​word=${S}`, [S]],
  ['fullwidth digits and letters', `ｐａｓｓｗｏｒｄ=${S}`, [S]],
  ['bare ntcp key in prose', `the key ntcp_${alnum(24)}${S} was printed`, [S]],
  ['bare bearer phrase', `use bearer ${alnum(20)}${S} for the call`, [S]],
  ['query key param', `https://x.example.com/y?key=${S}`, [S]],
  ['query code param', `https://x.example.com/cb?code=${S}&state=1`, [S]],
  ['named hex with auth', `auth 0123456789abcdef0123456789abcdef`, ['0123456789abcdef0123456789abcdef']],
  ['url password with @ on a non-database scheme', `ftp://bob:pa@${S}@files.example.com/x`, [S, 'pa@']],
  ['json-escaped newline before a header', `{"command":"echo hi\\nCookie: sid=${S}; theme=dark\\necho done"}`, [S]],
  ['json-escaped quotes around a key', `{"command":"export {\\"password\\":\\"${S}\\"}"}`, [S]],
  ['json-escaped authorization header', `{"cmd":"curl -H \\"Authorization: Bearer ${alnum(20)}${S}\\" x"}`, [S]],
  ['named hex key', `secret: 0123456789abcdef0123456789abcdef`, ['0123456789abcdef0123456789abcdef']],
  ['sentry dsn', `https://0123456789abcdef0123456789abcdef@o123.ingest.sentry.io/456`, ['0123456789abcdef0123456789abcdef']],
  ['twilio account sid', `A${"C"}0123456789abcdef0123456789abcdef`, ['AC0123456789abcdef']],
  ['twilio api key', `S${"K"}0123456789abcdef0123456789abcdef`, ['SK0123456789abcdef']],
  ['sendgrid', `SG.${alnum(22)}.${alnum(30)}${S}`, [S]],
  ['hugging face', `hf_${alnum(34)}${S}`, [S]],
  ['google oauth', `ya29.${alnum(30)}${S}`, [S]],
  ['env db pass', `DB_PASS=${S}`, [S]],
  ['env api token', `API_TOKEN=${S}`, [S]],
  ['curl custom header', `curl -H "X-Api-Key: ${S}" https://x`, [S]],
  ['tencent secret id', `AKID${alnum(20)}`, ['AKID' + alnum(20)]],
];

const NEGATIVE: Array<[string, string]> = [
  ['the word password alone', 'Please reset your password from the settings page.'],
  ['password policy prose', 'The password must contain 12 characters.'],
  ['token counter', 'max_tokens=4096 and tokens: 120'],
  ['empty assignment', 'token= and password:'],
  ['boolean credentials', "fetch(url, { credentials: 'include' })"],
  ['numeric sig', 'sig=1 pass=true'],
  ['commit hash', 'commit 0123456789abcdef0123456789abcdef01234567 fixes #12'],
  ['sha256 digest', 'sha256: 3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b'],
  ['uuid', 'id 123e4567-e89b-12d3-a456-426614174000'],
  ['absolute path', '/usr/local/lib/node_modules/some-package/index.js'],
  ['plain url', 'https://github.com/org/repo/pull/12'],
  ['url with port and no password', 'http://localhost:8080/health'],
  ['email', 'contact bob@example.com'],
  ['Basic as a word', 'Basic usage guide and Bearer of bad news'],
  ['sk dash short', 'pip install sk-learn and skill-runner'],
  ['akia short', 'AKIA is an AWS prefix'],
  ['ghp short', 'ghp_ prefix explained'],
  ['empty assignment before another line', 'password=\njdbc:mysql://localhost/db?user=root&passwordless=true'],
  ['port flag', 'python -m http.server -p 8080'],
  ['dash p short', 'ls -pa'],
  ['git command', 'git log --oneline -n 5'],
  ['common config', 'timeout=30 retries=3 name=build-agent'],
  ['markdown', '## Tokens\nWe count tokens per request.'],
  ['code identifier', 'const secretary = getSecretary(); export class AuthTokenProvider {}'],
  ['tokenizer assignment', 'const tokenizer = loadTokenizer(config); passwordless = enableWebAuthn()'],
  ['version string', 'node v22.21.0 npm 10.9.0'],
  ['key word in prose', 'press the key to continue; the secret garden'],
];

describe('credential masking: positives', () => {
  it.each(POSITIVE)('masks %s', (_name, input, secrets) => {
    const masked = mask(input);
    for (const secret of secrets) expect(masked, `${input}  =>  ${masked}`).not.toContain(secret);
    expect(masked).toContain('_MASKED]');
  });

  it('masking is idempotent: a second pass changes nothing', () => {
    for (const [, input] of POSITIVE) {
      const once = mask(input);
      expect(mask(once), input).toBe(once);
      expect(scanCredentials(once).text, input).toBe(once);
    }
  });

  it('the new scanner is what covers these forms (the legacy rules alone leave them readable)', () => {
    const covered = POSITIVE.filter(([, input]) => scanCredentials(input).findings > 0);
    expect(covered.length).toBeGreaterThanOrEqual(45);
  });
});

describe('credential masking: ordinary text is left alone', () => {
  it.each(NEGATIVE)('does not touch %s', (_name, input) => {
    expect(scanCredentials(input)).toEqual({ text: input, findings: 0 });
    expect(mask(input)).toBe(input);
  });
});

describe('credential masking: shape and safety', () => {
  it('keeps the variable name so the text stays readable', () => {
    expect(mask(`DB_PASS=${S} and password="${S}"`)).toBe('DB_PASS=[APIKEY_MASKED] and password=[APIKEY_MASKED]');
  });

  it('JSON-escaped input keeps its escapes (the result is still the same JSON text shape)', () => {
    const masked = mask(`{"command":"echo hi\\nCookie: sid=${S}\\necho done"}`);
    expect(masked).toContain('\\necho done');
    expect(masked).toContain('echo hi\\n');
    expect(masked).not.toContain(S);
  });

  it('text without findings is returned byte-for-byte even if it contains encodings or zero-width characters', () => {
    const input = 'caf%C3%A9 na​me and ｆｕｌｌｗｉｄｔｈ';
    expect(scanCredentials(input).text).toBe(input);
  });

  it('survives hostile large inputs in bounded time and still masks inside a large value', () => {
    const started = Date.now();
    for (const hostile of ['a'.repeat(1_000_000), 'sk-'.repeat(300_000), '['.repeat(500_000), 'password='.repeat(100_000), `${'x'.repeat(600_000)} password=${S}`]) {
      const masked = scanCredentials(hostile).text;
      expect(masked.length).toBeGreaterThan(0);
    }
    expect(scanCredentials(`${'x '.repeat(400_000)}password=${S}`).text).not.toContain(S);
    expect(Date.now() - started).toBeLessThan(20_000); // generous: the guard is against quadratic blow-ups
  });

  it('there are at least 55 positive and 20 negative forms in the table', () => {
    expect(POSITIVE.length).toBeGreaterThanOrEqual(55);
    expect(NEGATIVE.length).toBeGreaterThanOrEqual(20);
  });
});
