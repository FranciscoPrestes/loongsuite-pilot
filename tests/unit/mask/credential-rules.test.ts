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
    for (const hostile of ['openssl '.repeat(120_000), 'docker login '.repeat(80_000), 'htpasswd -b a '.repeat(70_000), 'vault login -x '.repeat(70_000), 'zip -P '.repeat(140_000), 'password is '.repeat(90_000), `mysql ${'-p '.repeat(300_000)}`, 'zip -P '.repeat(140_000), 'mysql -p '.repeat(110_000), 'unzip 7z mysql psql -px '.repeat(40_000),
      'a'.repeat(1_000_000), 'sk-'.repeat(300_000), '['.repeat(500_000), 'password='.repeat(100_000), `${'x'.repeat(600_000)} password=${S}`]) {
      const masked = scanCredentials(hostile).text;
      expect(masked.length).toBeGreaterThan(0);
    }
    expect(scanCredentials(`${'x '.repeat(400_000)}password=${S}`).text).not.toContain(S);
    expect(Date.now() - started).toBeLessThan(20_000); // generous: the guard is against quadratic blow-ups (a quadratic rule took 20 s+ on ONE of these)
  });

  it('there are at least 55 positive and 20 negative forms in the table', () => {
    expect(POSITIVE.length).toBeGreaterThanOrEqual(55);
    expect(NEGATIVE.length).toBeGreaterThanOrEqual(20);
  });
});

/** C11 (I2): credentials by ARGUMENT POSITION of well-known tools, and the glued -p rule restricted to the tools that use it. */
const POSITIONAL: Array<[string, string]> = [
  ['htpasswd -b', `htpasswd -b /etc/nginx/.htpasswd alice ${S}`],
  ['htpasswd -bc', `htpasswd -bc .htpasswd alice ${S}`],
  ['htpasswd -nb', `htpasswd -nb alice ${S}`],
  ['htpasswd -bB with cost', `htpasswd -bB -C 12 .htpasswd alice ${S}`],
  ['openssl -pass pass:', `openssl genrsa -aes256 -pass pass:${S} -out key.pem 2048`],
  ['openssl -passin pass:', `openssl rsa -in key.pem -passin pass:${S} -out plain.pem`],
  ['openssl -passout pass:', `openssl pkcs12 -export -passout pass:${S} -in c.pem`],
  ['openssl enc -k', `openssl enc -aes-256-cbc -k ${S} -in a -out b`],
  ['docker login -p space', `docker login -u bob -p ${S} registry.example.com`],
  ['az login -p space', `az login --service-principal -u app -p ${S} --tenant t`],
  ['podman login -p', `podman login -p ${S} quay.io`],
  ['gpg --passphrase space', `gpg --batch --passphrase ${S} -c file`],
  ['gpg --passphrase=', `gpg --batch --passphrase=${S} -c file`],
  ['zip -P', `zip -P ${S} out.zip secrets.txt`],
  ['zip -P glued', `zip -P${S} out.zip a`],
  ['redis-cli -a', `redis-cli -h cache -a ${S} ping`],
  ['vault login token', `vault login ${S}`],
  ['vault login with flag', `vault login -no-print ${S}`],
  ['aws configure set secret (space)', `aws configure set aws_secret_access_key ${S}`],
  ['aws configure set session token', `aws configure set aws_session_token ${S}`],
  ['password is X', `the password is ${S} for the staging box`],
  ['my passphrase is X', `my passphrase is ${S}`],
  ['mysql -p glued', `mysql -h db -u root -p${S} appdb`],
  ['mysqldump -p glued', `mysqldump -uroot -p${S} appdb > dump.sql`],
  ['mariadb -p glued', `mariadb -pS3kret${S}`],
  ['7z -p glued', `7z a -p${S} out.7z dir`],
  ['unrar -p glued', `unrar x -p${S} a.rar`],
  ['zip with glued -p-less keep', `zip --password ${S} a.zip b`],
  ['kubectl --token', `kubectl --token ${S} get pods`],
  ['passphrase flag attached to a longer command', `ssh-keygen -N ${S}`.replace('-N', '--passphrase')],
];

const POSITIONAL_NEGATIVE: Array<[string, string]> = [
  ['find -print0', 'find . -name "*.js" -print0 | xargs -0 wc -l'],
  ['find -prune', 'find . -path ./node_modules -prune -o -type f -print'],
  ['find -path', 'find src -path "*/test/*" -name "*.ts"'],
  ['git log -pretty', 'git log -pretty=oneline -n 5'],
  ['git log --pretty', 'git log --pretty=format:%h -n 3'],
  ['git log -p', 'git log -p -n 2 README.md'],
  ['ls -parents', 'ls -parents dir'],
  ['grep -prune text', 'grep -prune notes.txt'],
  ['cp -parents', 'cp -parents a b'],
  ['mkdir -p', 'mkdir -p build/output/logs'],
  ['npm -prefix', 'npm install -prefix ./app'],
  ['ssh -p port', 'ssh -p 2222 host'],
  ['psql -p port glued', 'psql -p5432 -h db'],
  ['mysql -p prompt', 'mysql -h db -u root -p'],
  ['curl -p proxy tunnel', 'curl -p -x http://proxy:3128 https://example.com'],
  ['zip without password', 'zip -r out.zip dir'],
  ['unzip listing', 'unzip -l out.zip'],
  ['openssl x509 text', 'openssl x509 -in cert.pem -noout -text'],
  ['openssl pass from env', 'openssl enc -pass env:MY_PASSPHRASE -in a'],
  ['openssl pass from file', 'openssl rsa -passin file:/run/secrets/pw -in k'],
  ['docker login stdin', 'echo $TOKEN | docker login --password-stdin ghcr.io'],
  ['docker run publish', 'docker run -p 8080:80 nginx'],
  ['docker ps', 'docker ps -a'],
  ['gpg list', 'gpg --list-keys'],
  ['redis-cli plain', 'redis-cli -h cache ping'],
  ['vault status', 'vault status'],
  ['vault login method', 'vault login -method=oidc'],
  ['aws configure list', 'aws configure list'],
  ['aws region', 'aws configure set region eu-west-1'],
  ['htpasswd verify', 'htpasswd -v .htpasswd alice'],
  ['password prose', 'the password is required and must be rotated'],
  ['password is invalid', 'Error: the password is incorrect'],
  ['password_reset_url', 'password_reset_url = "https://app.example.com/reset"'],
  ['password_policy', 'password_policy: strong'],
  ['password min length', 'password_min_length=12'],
  ['password_field', 'password_field = "pwd_input"'],
  ['password file reference', 'password_file=/run/secrets/db'],
  ['tokenizer', 'tokenizer_max_length = 512'],
];

describe('C11 I2: argument-position credentials', () => {
  it.each(POSITIONAL)('masks %s', (_name, input) => {
    const masked = mask(input);
    expect(masked, `${input}  =>  ${masked}`).not.toContain(S);
    expect(masked).toContain('_MASKED]');
  });

  it.each(POSITIONAL_NEGATIVE)('leaves %s intact', (_name, input) => {
    expect(mask(input)).toBe(input);
  });

  it('the tool name and flags stay readable around the masked value', () => {
    expect(mask(`openssl rsa -in key.pem -passin pass:${S} -out plain.pem`)).toBe('openssl rsa -in key.pem -passin pass:[APIKEY_MASKED] -out plain.pem');
    expect(mask(`docker login -u bob -p ${S} registry.example.com`)).toBe('docker login -u bob -p [APIKEY_MASKED] registry.example.com');
    expect(mask(`htpasswd -b .htpasswd alice ${S}`)).toBe('htpasswd -b .htpasswd [USER]'.replace('[USER]', 'alice [APIKEY_MASKED]'));
  });

  it('is idempotent and the tables are large enough', () => {
    for (const [, input] of POSITIONAL) expect(mask(mask(input)), input).toBe(mask(input));
    expect(POSITIONAL.length).toBeGreaterThanOrEqual(28);
    expect(POSITIONAL_NEGATIVE.length).toBeGreaterThanOrEqual(35);
  });
});

/** C12: the four minors of the C11 re-review. */
const BASH_SECRET = 'pa$$-w0rd&x;y|z'; // contains &, ; and | : the value is the whole token
const C12_POSITIVE: Array<[string, string, string[]]> = [
  ['continuation: -p on the next line', `docker login -u bob \\\n  -p ${S} registry.example.com`, [S]],
  ['continuation: several lines', `docker login \\\n -u bob \\\n -p ${S} \\\n registry.example.com`, [S]],
  ['continuation: CRLF', `docker login -u bob \\\r\n  -p ${S}`, [S]],
  ['continuation: htpasswd', `htpasswd -b \\\n .htpasswd alice \\\n ${S}`, [S]],
  ['continuation: mysql', `mysql -h db \\\n -u root \\\n -p${S}`, [S]],
  ['continuation: JSON-escaped', `{"cmd":"docker login -u bob \\\\\\n -p ${S}"}`, [S]],
  ['long padding line before docker login', `${'echo padding; '.repeat(1) + 'x'.repeat(20_000)} docker login -u bob -p ${S}`, [S]],
  ['long padding line before htpasswd', `${'y'.repeat(30_000)} htpasswd -b f alice ${S}`, [S]],
  ['long padding line before mysql', `${'z'.repeat(50_000)} mysql -u root -p${S} db`, [S]],
  ['tool word inside a 1 MB line', `${'a '.repeat(300_000)}redis-cli -a ${S} ping`, [S]],
  ['password with & ; | (docker)', `docker login -u bob -p '${BASH_SECRET}'`, ['pa$$', 'x;y']],
  ['password with & ; | unquoted (docker)', `docker login -u bob -p ${BASH_SECRET} registry`, ['pa$$', 'x;y', 'z']],
  ['password with & ; | (htpasswd)', `htpasswd -b f alice ${BASH_SECRET}`, ['pa$$', 'x;y']],
  ['password with & ; | (openssl)', `openssl enc -k ${BASH_SECRET} -in a`, ['pa$$', 'x;y']],
  ['password with & ; | (mysql)', `mysql -uroot -p${BASH_SECRET} db`, ['pa$$', 'x;y']],
  ['openssl passwd', `openssl passwd -1 ${S}`, [S]],
  ['openssl passwd with salt', `openssl passwd -6 -salt abc ${S}`, [S]],
  ['mongosh -p', `mongosh --host db -u admin -p ${S} --authenticationDatabase admin`, [S]],
  ['mongosh --password', `mongosh --password ${S}`, [S]],
  ['sqlcmd -P', `sqlcmd -S db -U sa -P ${S} -Q "select 1"`, [S]],
  ['sqlcmd -P glued', `sqlcmd -S db -U sa -P${S}`, [S]],
  ['ldapsearch -w', `ldapsearch -x -D cn=admin -w ${S} -b dc=example`, [S]],
  ['ldapsearch -w glued', `ldapsearch -x -wS${S}`, [S]],
  ['smbclient -U user%pass', `smbclient //srv/share -U alice%${S}`, [S]],
  ['smbclient -U space', `smbclient //srv/share -U alice%${S} -c ls`, [S]],
  ['redis-cli AUTH', `redis-cli AUTH ${S}`, [S]],
  ['redis-cli AUTH user pass', `redis-cli AUTH default ${S}`, [S]],
  ['docker -p before login', `docker -p ${S} login`, [S]],
  ['uppercase HTPASSWD', `HTPASSWD -b f alice ${S}`, [S]],
  ['uppercase DOCKER LOGIN', `DOCKER LOGIN -u bob -p ${S}`, [S]],
  ['absolute path to the tool', `/usr/local/bin/docker login -p ${S}`, [S]],
  ['windows exe', `C:\\Tools\\openssl.exe enc -k ${S}`, [S]],
  ['mixed case OpenSSL', `OpenSSL rsa -passin pass:${S}`, [S]],
  ['quoted tool name', `"docker" login -u bob -p ${S}`, [S]],
  ['single-quoted tool name', `'docker' login -p ${S}`, [S]],
  ['quoted windows path with spaces', `"C:\\Program Files\\Docker\\docker.exe" login -u bob -p ${S}`, [S]],
  ['quoted openssl path', `"/opt/openssl 3/bin/openssl" enc -k ${S}`, [S]],
  ['redis AUTH followed by a redirect', `redis-cli AUTH ${S} 2>&1`, [S]],
  ['redis AUTH followed by a file redirect', `redis-cli AUTH ${S} > out.txt`, [S]],
  ['redis AUTH user pass then a redirect', `redis-cli AUTH default ${S} 2>/dev/null`, [S]],
  ['redis AUTH then a command word', `redis-cli AUTH ${S} ping`, [S]],
  ['two commands: the second one leaks', `echo hi; redis-cli -a ${S} ping`, [S]],
  ['after &&', `cd /tmp && docker login -p ${S}`, [S]],
];

const C12_NEGATIVE: Array<[string, string]> = [
  ['continuation does not glue unrelated lines', 'docker ps \\\n  -a\nredis-cli ping'],
  ['-p on the next real line belongs to another command', 'docker login -u bob\nssh -p 2222 host'],
  ['-p after a pipe is another command', 'docker login -u bob | ssh -p 2222 host'],
  ['-p after a semicolon is another command', 'docker login -u bob ; ls -p'],
  ['openssl passwd help', 'openssl passwd -help'],
  ['mongosh without password', 'mongosh --host db --eval "db.stats()"'],
  ['sqlcmd integrated auth', 'sqlcmd -S db -E -Q "select 1"'],
  ['sqlcmd lowercase -p', 'sqlcmd -S db -p'],
  ['ldapsearch simple', 'ldapsearch -x -b dc=example "(cn=bob)"'],
  ['ldapsearch -W prompt', 'ldapsearch -x -D cn=admin -W -b dc=example'],
  ['smbclient list', 'smbclient -L //srv -N'],
  ['smbclient user only', 'smbclient //srv/share -U alice'],
  ['redis-cli auth word in prose', 'redis-cli --help shows how authentication works'],
  ['unrelated tool with -w', 'wc -w notes.txt && grep -w word file'],
  ['unrelated tool with -P', 'grep -P "^a+" file && ps -P'],
  ['unrelated -k', 'curl -k https://localhost:8443'],
  ['dockerfile word', 'edit the Dockerfile to run docker build -t app .'],
  ['redis AUTH alone', 'redis-cli AUTH'],
  ['quoted benign tool use', '"docker" ps -a'],
  ['quoted windows path benign', '"C:\\Program Files\\Docker\\docker.exe" ps'],
  ['long benign line', `${'word '.repeat(60_000)}docker ps`],
  ['long line with a tool word and no secret', `${'x'.repeat(30_000)} docker login --help`],
];

describe('C12: continuation lines, long lines, special characters in passwords, more tools', () => {
  it.each(C12_POSITIVE)('masks %s', (_name, input, parts) => {
    const masked = mask(input);
    for (const part of parts) expect(masked, `${input.slice(0, 80)}  =>  ${masked.slice(0, 160)}`).not.toContain(part);
    expect(masked).toContain('_MASKED]');
  });

  it.each(C12_NEGATIVE)('leaves %s intact', (_name, input) => { expect(mask(input)).toBe(input); });

  it('a continuation keeps the layout of the command (backslash and newline are preserved)', () => {
    expect(mask(`docker login -u bob \\\n  -p ${S} \\\n  registry.example.com`)).toBe('docker login -u bob \\\n  -p [APIKEY_MASKED] \\\n  registry.example.com');
  });

  it('redirections and flags after the password stay readable', () => {
    expect(mask(`redis-cli AUTH ${S} 2>&1`)).toBe('redis-cli AUTH [APIKEY_MASKED] 2>&1');
    expect(mask(`redis-cli AUTH ${S} > out.txt`)).toBe('redis-cli AUTH [APIKEY_MASKED] > out.txt');
    expect(mask(`"docker" login -u bob -p ${S} registry`)).toBe('"docker" login -u bob -p [APIKEY_MASKED] registry');
  });

  it('is idempotent and linear on hostile input of 1 MB', () => {
    for (const [, input] of C12_POSITIVE) expect(mask(mask(input)), input.slice(0, 60)).toBe(mask(input));
    const started = Date.now();
    for (const hostile of ['docker login -p '.repeat(65_000), 'openssl passwd '.repeat(65_000), 'redis-cli AUTH '.repeat(65_000), 'smbclient -U a%b '.repeat(60_000), 'htpasswd -b '.repeat(80_000),
      '\\\n'.repeat(500_000), `${'docker '.repeat(140_000)}login`, 'mysql -p'.repeat(120_000), 'a&b;c|d '.repeat(120_000)]) {
      mask(hostile);
    }
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it('the tables are large enough', () => {
    expect(C12_POSITIVE.length).toBeGreaterThanOrEqual(38);
    expect(C12_NEGATIVE.length).toBeGreaterThanOrEqual(18);
  });
});
