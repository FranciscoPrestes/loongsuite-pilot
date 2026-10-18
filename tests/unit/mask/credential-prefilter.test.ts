import { describe, expect, it } from 'vitest';

import { mightHoldCredential, scanCredentials, scanTextUnfiltered } from '../../../src/mask/credential-scanner.js';

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
      expect(scanCredentials(text), text).toEqual(scanTextUnfiltered(text));
    }
  });
});
