import { describe, expect, it } from 'vitest';
import { parseRemote, sanitizeDomainValue, sanitizeRepoValue } from '../../../src/normalization/remote-identity.js';
import { normalizeSourceContext, sourceFieldsFromContext } from '../../../src/normalization/source-context.js';

const T = 'TOKEN-7f3a'; // marker: it must never appear in any exported attribute

/** Every remote shape that carries the marker in userinfo, query, fragment or a malformed prefix. */
const LEAKY: string[] = [
  `https://user:${T}@github.com/org/repo.git`, `https://${T}@github.com/org/repo.git`, `https://user:${T}@github.com:8443/org/repo.git`,
  `ssh://git:${T}@github.com/org/repo.git`, `ssh://${T}@github.com:2222/org/repo.git`, `git://user:${T}@github.com/org/repo.git`,
  `https://user:p@${T}@github.com/org/repo`, `ssh://user:p@${T}@github.com/org/repo`,
  `https://user:pa/${T}@github.com/org/repo`, `ssh://user:pa/${T}@github.com/org/repo`,
  `https://github.com/org/repo.git?token=${T}`, `https://github.com/org/repo.git?access_token=${T}#frag`, `https://github.com/org/repo.git#${T}`,
  `ssh://git@github.com/org/repo.git?x=${T}`, `https://github.com/org/repo?${T}`,
  `git@github.com:org/repo.git?x=${T}`, `github.com:org/repo?x=${T}`, `git@github.com:org/repo#${T}`,
  `HTTPS://user:${T}@GitHub.com/org/repo`, `Https://user:${T}@github.com/org/repo.git`,
  `https:/user:${T}@github.com/org/repo`, `https:\\\\user:${T}@github.com/org/repo`, `https:\\user:${T}@github.com/org/repo`,
  `//user:${T}@github.com/org/repo`, `user:${T}@github.com/org/repo`, `user:${T}@github.com/org/repo.git`,
  `https://user:${T}@[2001:db8::1]:8443/org/repo`, `ssh://${T}@[2001:db8::1]/org/repo`,
  `https://user%40x:${T}@github.com/org/repo`, `https://user:%40${T}@github.com/org/repo`,
  `ext::sh -c "echo ${T}"`, `ext::ssh://user:${T}@host/x`, `fd::${T}`,
  `file:///home/${T}/repo.git`, `ftp://user:${T}@host/org/repo`, `http://user:${T}@host/org/repo`,
  `https://github.com/org/repo.git\n?token=${T}`, `https://user:${T}@github.com/org/repo .git`,
  `https://github.com/org;jsessionid=${T}/repo`, `https://github.com/org/repo;token=${T}`, `git@github.com:org;jsessionid=${T}/repo`, `git@github.com:org/repo;token=${T}.git`,
  `https://github.com/org/repo%3Btoken=${T}`, `https://github.com/org%3Bjsessionid=${T}/repo`, `ssh://git@github.com/org/repo,${T}`,
  `${T}@github.com:org/repo.git?`, `https://github.com:${T}/org/repo`, `https://user:${T}@`,
];

describe('remote identity parser: nothing sensitive is ever exported', () => {
  it.each(LEAKY)('%j never leaks the marker through repo or domain', (raw) => {
    const identity = parseRemote(raw);
    expect(JSON.stringify(identity ?? null)).not.toContain(T);
    // The hook path uses the same sanitizer.
    const context = normalizeSourceContext({ repo: raw, domain: raw });
    expect(JSON.stringify(sourceFieldsFromContext(context))).not.toContain(T);
    expect(JSON.stringify([sanitizeRepoValue(raw), sanitizeDomainValue(raw)])).not.toContain(T);
  });

  it('there are at least 40 hostile shapes in the table', () => { expect(LEAKY.length).toBeGreaterThanOrEqual(40); });

  it.each([
    // Valid remotes keep working; credentials/query/fragment are dropped by construction; the port never enters the repo.
    ['https://github.com/org/repo.git', 'org/repo', 'github.com'],
    ['HTTPS://GitHub.com/Org/Repo.git', 'Org/Repo', 'github.com'],
    ['https://user:secret@github.com/org/repo.git?x=1#f', 'org/repo', 'github.com'],
    ['https://host.example:8443/org/repo', 'org/repo', 'host.example'],
    ['ssh://git@host.example:2222/org/repo.git', 'org/repo', 'host.example'],
    ['ssh://git@host.example/org/sub/repo', 'org/sub/repo', 'host.example'],
    ['git://github.com/org/repo.git', 'org/repo', 'github.com'],
    ['https://[2001:db8::1]:8443/org/repo', 'org/repo', '[2001:db8::1]'],
    ['git@github.com:org/repo.git', 'org/repo', 'github.com'],
    ['github.com:org/repo.git', 'org/repo', 'github.com'],
    ['git@gitlab.example.com:group/sub/repo.git', 'group/sub/repo', 'gitlab.example.com'],
    ['git@host.example:/srv/git/repo.git', 'srv/git/repo', 'host.example'],
  ])('keeps the identity of %s', (raw, repo, domain) => {
    expect(parseRemote(raw)).toEqual({ repo, domain });
  });

  it.each([
    '/Users/alice/work/repo', '/srv/git/repo.git', 'Users/alice/work/repo', '../sibling/repo', './repo', 'repo', 'org/repo',
    'C:\\Users\\alice\\repo', 'C:/Users/alice/repo', 'file:///srv/repo', 'http://github.com/org/repo', 'ftp://host/org/repo',
    'https://github.com/org/my repo', 'git@github.com:org/my repo', 'https://github.com/org/re\tpo', 'git@github.com:org/../repo', 'git@github.com:../../etc/passwd', 'host.example:./repo', 'ext::sh -c x', 'https://', 'https://github.com', 'https://github.com/', 'git@github.com:', '', '   ', 'a'.repeat(600),
  ])('rejects %j: no repo, no domain, the raw value is never exported', (raw) => {
    expect(parseRemote(raw)).toBeUndefined();
  });

  it.each([
    'git@github.com:org/re$po', 'git@github.com:org/re(po)', 'https://github.com/org/re po', 'https://github.com/org/repo!', 'https://github.com/org/re*po',
  ])('only slug characters are allowed in path segments: %s', (raw) => { expect(parseRemote(raw)).toBeUndefined(); });

  it.each([
    'localhost:/Users/alice/x', 'localhost:Users/alice/x', 'git@localhost:/Users/alice/x', '127.0.0.1:/Users/alice/x', 'git@127.0.0.1:/home/a/x',
    'ssh://git@localhost/Users/alice/x', 'https://localhost/org/repo', 'https://127.0.0.1:8443/org/repo', 'ssh://[::1]/Users/alice/x', 'https://[::1]:3000/org/repo',
    'devbox:/Users/alice/x', 'git@devbox:/home/alice/repo.git',
  ])('rejects loopback hosts and single-label hosts with an absolute scp path: %s', (raw) => { expect(parseRemote(raw)).toBeUndefined(); });

  it.each([
    '0.0.0.0:org/repo', 'git@0.0.0.0:org/repo.git', 'https://0.0.0.0/org/repo', '1234:org/repo', 'git@12345:org/repo', '1.2:org/repo', '999.1.1.1:org/repo',
    'git@300.300.300.300:org/repo', 'ssh://git@1.2.3/org/repo', 'git@1.2.3.4.5:org/repo',
  ])('rejects numeric hosts that are not a real IPv4 address: %s', (raw) => { expect(parseRemote(raw)).toBeUndefined(); });

  it('keeps a real on-prem IPv4 git server and alphabetic hosts', () => {
    expect(parseRemote('git@10.20.30.40:org/repo.git')).toEqual({ repo: 'org/repo', domain: '10.20.30.40' });
    expect(parseRemote('https://192.168.1.5:8443/org/repo')).toEqual({ repo: 'org/repo', domain: '192.168.1.5' });
    expect(parseRemote('git@git.corp.example:org/repo.git')?.domain).toBe('git.corp.example');
  });

  it('keeps an intranet single-label host when the path is relative or the form is a URL', () => {
    expect(parseRemote('git@devbox:org/repo.git')).toEqual({ repo: 'org/repo', domain: 'devbox' });
    expect(parseRemote('https://gitserver/org/repo')).toEqual({ repo: 'org/repo', domain: 'gitserver' });
  });

  it('normalizes a fully-qualified host with a trailing dot instead of dropping the remote', () => {
    expect(parseRemote('https://GitHub.com./org/repo.git')).toEqual({ repo: 'org/repo', domain: 'github.com' });
    expect(parseRemote('git@github.com.:org/repo.git')).toEqual({ repo: 'org/repo', domain: 'github.com' });
    expect(parseRemote('ssh://git@github.com.:2222/org/repo')).toEqual({ repo: 'org/repo', domain: 'github.com' });
    expect(sanitizeDomainValue('github.com.')).toBe('github.com');
    expect(parseRemote('https://github.com../org/repo')).toBeUndefined();
  });

  it('rejects non-strings and hostile hosts', () => {
    for (const value of [undefined, null, 5, {}, ['x']]) expect(parseRemote(value as never)).toBeUndefined();
    expect(parseRemote('https://exa mple.com/org/repo')).toBeUndefined();
    expect(parseRemote('https://evil.com%2f@github.com/org/repo')?.domain).not.toContain('%');
  });
});

describe('hook-supplied values use the same sanitizer', () => {
  it('keeps a plain org/repo slug and a clean domain, drops credentials and ports from the domain', () => {
    expect(normalizeSourceContext({ repo: 'sls/loongsuite-pilot', domain: 'github.com' })).toMatchObject({ repo: 'sls/loongsuite-pilot', domain: 'github.com' });
    expect(normalizeSourceContext({ domain: 'GitHub.com:8443' }).domain).toBe('github.com');
    expect(normalizeSourceContext({ repo: 'https://github.com/example-org/loongsuite-pilot.git' }).repo).toBe('example-org/loongsuite-pilot');
  });
  it('drops a loopback domain from hooks as well', () => {
    for (const host of ['localhost', 'LOCALHOST:3000', '127.0.0.1', 'dev.localhost']) expect(normalizeSourceContext({ domain: host }).domain, host).toBeUndefined();
  });
  it('drops anything that is not a repo slug or a host', () => {
    for (const bad of [`user:${T}@host`, '/Users/alice/repo', 'ext::x', `a@b@${T}`]) {
      const context = normalizeSourceContext({ repo: bad, domain: bad });
      expect(context.domain, bad).toBeUndefined();
      expect(JSON.stringify(context), bad).not.toContain(T);
    }
  });
});
