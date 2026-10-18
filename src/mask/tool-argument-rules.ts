/**
 * Credentials by ARGUMENT POSITION of well-known command-line tools (the value has no name or format of its own).
 *
 * Token based and linear: the text is split into whitespace-delimited tokens once; a tool word starts a bounded scan
 * of the tokens that follow it (until a real newline or a shell separator token, at most MAX_ARG_TOKENS). A
 * `\`+newline continuation is NOT a boundary, and the value is the whole token, so a password containing `&`, `;`
 * or `|` is masked completely. Tool names are matched case-insensitively and by basename (`/usr/bin/DOCKER`).
 * Hostile input costs at most MAX_ARG_TOKENS steps per tool word, never a quadratic regex scan.
 */
export interface ToolRuleResult { text: string; findings: number }

const MAX_ARG_TOKENS = 64;
const ALREADY_MASKED = /^\[(?:ACCESSKEY|APIKEY|PRIVATEKEY|DATABASEURL|IDCARD|PHONE|EMAIL|IP_ADDRESS|CREDIT_CARD)_MASKED/;
/** Real line breaks end a command; `\u0005`-`\u0007` are line continuations (see credential-scanner escapeView). */
const BOUNDARY_GAP = /[\n\u0001\u0002]/;
const SEPARATOR = /^(?:\|\|?|&&?|;;?|\()$/;
const TOKEN = /[^\s\u0005\u0006\u0007]+/g;
const REDIRECTION = /^(?:\d*[<>]|&>)/;
/** Cheap pre-filter: without any tool word the text is not even tokenized (plain prose is the common case). */
const TOOL_WORD = /\b(?:htpasswd|openssl|docker|podman|nerdctl|buildah|skopeo|az|crane|oras|helm|zip|unzip|zipcloak|zipsplit|redis-cli|vault|mongosh|mongo|sqlcmd|ldap[a-z]+|smbclient|mysql[a-z]*|mariadb(?:-dump)?|psql|7z[a-z]?|unrar|rar|aws_secret_access_key|aws_session_token)/i;

interface Token { text: string; start: number; end: number; boundaryBefore: boolean }
interface Edit { start: number; end: number }

function basename(token: string): string {
  // JSON and shell glue punctuation to the command word: `{"cmd":"docker`, `$(openssl`, `FOO=docker`.
  // Trailing quotes/brackets first (`"docker"`), then everything up to the last glue character before the name.
  const unquoted = token.replace(/["'`)}]+$/g, '').replace(/^.*["'`({=,:]/, '');
  return (unquoted.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(?:exe|cmd|bat|sh)$/, '');
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let previousEnd = 0;
  for (const match of text.matchAll(TOKEN)) {
    const start = match.index ?? 0;
    tokens.push({ text: match[0], start, end: start + match[0].length, boundaryBefore: tokens.length > 0 && BOUNDARY_GAP.test(text.slice(previousEnd, start)) });
    previousEnd = start + match[0].length;
  }
  return tokens;
}

/** The argument tokens of the command whose name is at `index` (bounded, stops at a newline or a separator). */
function argsOf(tokens: Token[], index: number): number[] {
  const args: number[] = [];
  for (let i = index + 1; i < tokens.length && args.length < MAX_ARG_TOKENS; i += 1) {
    if (tokens[i]!.boundaryBefore || SEPARATOR.test(tokens[i]!.text)) break;
    args.push(i);
  }
  return args;
}

const isFlag = (t: string) => t.startsWith('-') && t.length > 1;
const REGISTRY_TOOLS = new Set(['docker', 'podman', 'nerdctl', 'buildah', 'skopeo', 'az', 'crane', 'oras', 'helm']);
const MYSQL_FAMILY = new Set(['mysql', 'mysqldump', 'mysqladmin', 'mysqlcheck', 'mysqlimport', 'mysqlshow', 'mariadb', 'mariadb-dump', 'psql', '7z', '7za', '7zr', 'unrar', 'rar', 'zip', 'unzip']);
const LDAP_TOOLS = new Set(['ldapsearch', 'ldapmodify', 'ldapadd', 'ldapdelete', 'ldapwhoami', 'ldappasswd', 'ldapcompare', 'ldapmodrdn']);
const ZIP_TOOLS = new Set(['zip', 'unzip', 'zipcloak', 'zipsplit']);

export function maskToolArguments(text: string, replacement: string): ToolRuleResult {
  if (text.length === 0 || !TOOL_WORD.test(text)) return { text, findings: 0 };
  const tokens = tokenize(text);
  const edits: Edit[] = [];
  const mask = (token: Token, from = 0) => {
    const value = token.text.slice(from);
    if (value.length === 0 || ALREADY_MASKED.test(value)) return;
    edits.push({ start: token.start + from, end: token.end });
  };

  for (let i = 0; i < tokens.length; i += 1) {
    if (!/[A-Za-z]/.test(tokens[i]!.text)) continue; // names have letters: skip numbers and punctuation cheaply
    const name = basename(tokens[i]!.text);
    if (name.length === 0) continue;
    const isTool = name === 'htpasswd' || name === 'openssl' || REGISTRY_TOOLS.has(name) || ZIP_TOOLS.has(name) || name === 'redis-cli' || name === 'vault'
      || name === 'mongosh' || name === 'mongo' || name === 'sqlcmd' || LDAP_TOOLS.has(name) || name === 'smbclient' || MYSQL_FAMILY.has(name);
    if (!isTool) {
      // Not tied to a tool: the AWS CLI key is a plain "name SPACE value" pair.
      if (/^aws_(?:secret_access_key|session_token)$/i.test(tokens[i]!.text) && tokens[i + 1] && !tokens[i + 1]!.boundaryBefore) mask(tokens[i + 1]!);
      continue;
    }
    const args = argsOf(tokens, i);
    const at = (k: number) => (k < args.length ? tokens[args[k]!]! : undefined);

    if (name === 'htpasswd') {
      const flags: string[] = []; const positional: Token[] = [];
      for (let k = 0; k < args.length; k += 1) {
        const token = at(k)!;
        if (isFlag(token.text)) { flags.push(token.text); if (token.text === '-C' && at(k + 1) && /^\d+$/.test(at(k + 1)!.text)) k += 1; } else positional.push(token);
      }
      const batch = flags.some(flag => /^-[A-Za-z]*b/.test(flag));
      const noFile = flags.some(flag => /^-[A-Za-z]*n/.test(flag));
      const target = positional[noFile ? 1 : 2];
      if (batch && target) mask(target);
    } else if (name === 'openssl') {
      for (let k = 0; k < args.length; k += 1) {
        const token = at(k)!;
        if (/^-pass(?:in|out)?$/.test(token.text) && at(k + 1)?.text.startsWith('pass:')) mask(at(k + 1)!, 5);
        else if (token.text === '-k' && at(k + 1) && !isFlag(at(k + 1)!.text)) mask(at(k + 1)!);
        else if (token.text === 'passwd') {
          // openssl passwd [-1|-5|-6|-apr1|-salt X|-in F|-stdin|-quiet|-table|-noverify|-reverse] PASSWORD
          for (let j = k + 1; j < args.length; j += 1) {
            const arg = at(j)!;
            if (arg.text === '-salt' || arg.text === '-in' || arg.text === '-rand') { j += 1; continue; }
            if (isFlag(arg.text)) continue;
            mask(arg); break;
          }
        }
      }
    } else if (REGISTRY_TOOLS.has(name)) {
      if (args.some((_, k) => at(k)!.text.toLowerCase() === 'login')) {
        for (let k = 0; k < args.length; k += 1) {
          const token = at(k)!;
          if ((token.text === '-p' || token.text === '--password') && at(k + 1) && !isFlag(at(k + 1)!.text)) mask(at(k + 1)!);
          else if (token.text.startsWith('-p=')) mask(token, 3);
        }
      }
    } else if (ZIP_TOOLS.has(name)) {
      for (let k = 0; k < args.length; k += 1) {
        const token = at(k)!;
        if (token.text === '-P' && at(k + 1)) mask(at(k + 1)!);
        else if (/^-P\S+/.test(token.text)) mask(token, 2);
      }
    } else if (name === 'redis-cli') {
      for (let k = 0; k < args.length; k += 1) {
        const token = at(k)!;
        if ((token.text === '-a' || token.text === '--pass') && at(k + 1)) mask(at(k + 1)!);
        else if (token.text.toLowerCase() === 'auth' && at(k + 1)) {
          // AUTH pass | AUTH user pass: the first argument is always secret; a second one too unless it is a redirection or a flag.
          mask(at(k + 1)!);
          const second = at(k + 2);
          if (second && !isFlag(second.text) && !REDIRECTION.test(second.text)) mask(second);
          break;
        }
      }
    } else if (name === 'vault') {
      if (at(0)?.text === 'login') {
        for (let k = 1; k < args.length; k += 1) {
          const token = at(k)!;
          if (isFlag(token.text)) continue;
          if (!token.text.includes('=')) mask(token);
          break;
        }
      }
    } else if (name === 'mongosh' || name === 'mongo') {
      for (let k = 0; k < args.length; k += 1) {
        const token = at(k)!;
        if ((token.text === '-p' || token.text === '--password') && at(k + 1) && !isFlag(at(k + 1)!.text)) mask(at(k + 1)!);
      }
    } else if (name === 'sqlcmd') {
      for (let k = 0; k < args.length; k += 1) {
        const token = at(k)!;
        if (token.text === '-P' && at(k + 1)) mask(at(k + 1)!);
        else if (/^-P\S+/.test(token.text)) mask(token, 2);
      }
    } else if (LDAP_TOOLS.has(name)) {
      for (let k = 0; k < args.length; k += 1) {
        const token = at(k)!;
        if (token.text === '-w' && at(k + 1)) mask(at(k + 1)!);
        else if (/^-w\S+/.test(token.text)) mask(token, 2);
      }
    } else if (name === 'smbclient') {
      for (let k = 0; k < args.length; k += 1) {
        const token = at(k)!;
        const credentials = token.text === '-U' ? at(k + 1) : /^-U\S+/.test(token.text) ? token : undefined;
        const from = token.text === '-U' ? 0 : 2;
        const percent = credentials?.text.indexOf('%', from) ?? -1;
        if (credentials && percent >= 0) mask(credentials, percent + 1);
      }
    }
    if (MYSQL_FAMILY.has(name)) {
      // The password glued to -p (mysql -psecret, 7z a -psecret). A bare -p prompts; -p<digits> is a port.
      for (const k of args) {
        const token = tokens[k]!;
        if (token.text.length > 2 && token.text.startsWith('-p') && token.text[2] !== '-' && !/^-p\d+$/.test(token.text)) mask(token, 2);
      }
    }
  }

  if (edits.length === 0) return { text, findings: 0 };
  edits.sort((a, b) => a.start - b.start);
  let out = ''; let cursor = 0; let findings = 0;
  for (const edit of edits) {
    if (edit.start < cursor) continue;
    out += text.slice(cursor, edit.start) + replacement;
    cursor = edit.end; findings += 1;
  }
  return { text: out + text.slice(cursor), findings };
}
