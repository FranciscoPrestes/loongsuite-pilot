import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { CREDENTIAL_RULES, mightHoldCredential, scanCredentials } from '../../../src/mask/credential-scanner.js';

// One credential per trigger word, each free of every other trigger word, so dropping a word from the
// pre-filter makes the matching row fail.
const body = 'Zq8vL2mN9pR4tY7wK3xB5cD6';
const ROWS: ReadonlyArray<readonly [string, string]> = [
  ['pass', `db_pass=${body}`],
  ['pwd', `DB_PWD=${body}`],
  ['secret', `client_secret=${body}`],
  ['token', `access_token=${body}`],
  ['key', `api_key=${body}`],
  ['cred', `x_cred=${body}`],
  ['sig', `?sig=${body}`],
  ['auth', `Authorization: ${body}`],
  ['bearer', `Bearer ${body}`],
  ['basic', 'Basic dXNlcjp4eXp6eTEyMzQ1Ng=='],
  ['cookie', `Cookie: session=${body}`],
  ['://', 'https://alice:Zq8vL2mN9pR4@example.com/x'],
  ['eyj', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4eHh4eHh4eCJ9.abcdEFGH'],
  ['aiza', 'AIza8vL2mN9pR4tY7wK3xB5cD6eF1gH0jQ'],
  ['ya29.', `ya29.${body}`],
  ['xox', 'xoxb-1234567890-abcdefghij'],
  ['akia', 'AKIAIOSFODNN7EXAMPLE'],
  ['sg.', `SG.${body}.${body}`],
  ['hf_', `hf_${'Zq8vL2mN9pR4tY7wK3xB5cD6eF1gH0j'}`],
  ['-u', 'curl -u bob:Zq8vL2mN9 localhost:8080/api'],
  ['--user', 'curl --user bob:Zq8vL2mN9 host/path'],
  ['code=', '/callback?code=Zq8vL2mN9pR4tY7w'],
  ['pem', '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----'],
];

describe('credential pre-filter', () => {
  it.each(ROWS)('%s: lets a credential through and the scanner masks it', (_word, text) => {
    expect(mightHoldCredential(text)).toBe(true);
    expect(scanCredentials(text).findings).toBeGreaterThan(0);
  });

  it('skips plain prose and keeps non-ASCII or percent-encoded text on the full path', () => {
    expect(mightHoldCredential('ordinary collector output without sensitive values')).toBe(false);
    expect(mightHoldCredential('café')).toBe(true);
    expect(mightHoldCredential('a%3Db')).toBe(true);
  });

  // The pre-filter must never change what the scanner does: compare it with the full scan on mixed inputs.
  it('gives the same result as the unfiltered scan on seeded random input', () => {
    const vocab = ['curl', '-u', '--user', '-H', 'bob:x1y2z3w4', 'code=', 'abcd1234efgh', '?', '&', 'pass', 'word=', 'token', '=', ':', ' ', ' ', '\n',
      'key', 'sig', 'Cookie:', 'sshpass -p', 'mysql -p', 'docker login -p', 'AKIA', 'Basic ', 'Bearer ', 'secret', 'cred', 'x', 'localhost:8080/api', 'Zq8vL2mN9pR4'];
    let seed = 12345;
    const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
    for (let i = 0; i < 20000; i += 1) {
      const text = Array.from({ length: 1 + (next() % 8) }, () => vocab[next() % vocab.length]).join('');
      expect(scanCredentials(text), text).toEqual(scanCredentials(text, false));
    }
  });

  // One sample per rule of the scanner. A rule added to CREDENTIAL_RULES without a sample here fails the key check.
  const RULE_SAMPLES: Readonly<Record<string, string>> = {
    FORMAT_0: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
    FORMAT_1: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4eHh4eHh4eCJ9.abcdEFGH',
    FORMAT_2: `sk-${body}`,
    FORMAT_3: `rk_live_${body}`,
    FORMAT_4: `ntcp_${body}`,
    FORMAT_5: `npm_${body}`,
    FORMAT_6: `ghp_${body}`,
    FORMAT_7: `glpat-${body}`,
    FORMAT_8: 'AIza8vL2mN9pR4tY7wK3xB5cD6eF1gH0jQ',
    FORMAT_9: `ya29.${body}`,
    FORMAT_10: 'xoxb-1234567890-abcdefghij',
    FORMAT_11: 'AKIAIOSFODNN7EXAMPLE',
    FORMAT_12: `SG.${body}.${body}`,
    FORMAT_13: `hf_${'8vL2mN9pR4tY7wK3xB5cD6eF1gH0jQ'}`,
    FORMAT_14: `AC${'0123456789abcdef'.repeat(2)}`,
    FORMAT_15: 'https://0123456789abcdef0123@o1.ingest.sentry.io/1',
    URL_WITH_PASSWORD: 'postgres://alice:Zq8vL2mN9pR4@db/x',
    AUTHORIZATION: `Authorization: ${body}`,
    BEARER: `Bearer ${body}`,
    BASIC: 'Basic dXNlcjp4eXp6eTEyMzQ1Ng==',
    COOKIE: `Cookie: session=${body}`,
    QUERY_SECRET: `/cb?code=${body}`,
    PASSWORD_IS: 'the password is Zq8vL2mN9pR4',
    FLAG: `cmd --password ${body}`,
    SSHPASS: `sshpass -p ${body} ssh host`,
    CURL_USER: `curl -u bob:${body} host`,
    CURL_HEADER: `curl -H "X-Api-Key: ${body}" host`,
    NAMED_HEX: 'key: 0123456789abcdef0123456789abcdef',
    ASSIGN_PASS: `db_pass=${body}`,
    ASSIGN_STRONG: `client_secret=${body}`,
    UPPER_ENV: `MY_TOKEN=${body}`,
  };

  it('has a pre-filter trigger for every scanner rule', () => {
    expect(Object.keys(RULE_SAMPLES).sort()).toEqual(Object.keys(CREDENTIAL_RULES).sort());
    for (const [name, rule] of Object.entries(CREDENTIAL_RULES)) {
      const sample = RULE_SAMPLES[name];
      expect(new RegExp(rule.source, rule.flags.replace('g', '')).test(sample), `${name} sample must match its rule`).toBe(true);
      expect(mightHoldCredential(sample), `${name} has no trigger`).toBe(true);
      expect(scanCredentials(sample), name).toEqual(scanCredentials(sample, false));
    }
  });

  it('has a trigger for the token-based tool rules', () => {
    const text = `docker login -u u -p ${body}`;
    expect(mightHoldCredential(text.replace('-u u ', ''))).toBe(true);
    expect(scanCredentials(text).findings).toBeGreaterThan(0);
  });

  // Every string literal of the mask test suites goes through both paths: the pre-filter must change nothing.
  it('matches the unfiltered scan on every string literal of the mask tests', () => {
    const files = [
      ...readdirSync('tests/unit/mask').map(f => join('tests/unit/mask', f)),
      'tests/integration/credential-masking-order.test.ts',
    ].filter(f => f.endsWith('.ts') && !f.endsWith('credential-prefilter.test.ts'));
    let checked = 0;
    for (const file of files) {
      for (const [, quote, raw] of readFileSync(file, 'utf8').matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) {
        let text = raw;
        if (quote !== '`') { try { text = JSON.parse(`"${raw.replace(/\\'/g, "'").replace(/"/g, '\\"')}"`) as string; } catch { /* keep raw */ } }
        expect(scanCredentials(text), `${file}: ${text}`).toEqual(scanCredentials(text, false));
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });
});
