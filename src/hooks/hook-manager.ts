import * as path from 'node:path';
import { withClaudeSettingsLock } from './claude-settings.js';
import {
  writeTextFileAtomic,
  ensureDir,
  resolveHome,
} from '../utils/fs-utils.js';
import {
  editJsonc,
  parseJsonDocument,
  readJsonDocument,
  type JsonSyntax,
} from '../utils/json-document.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('HookManager');
const hookExt = process.platform === 'win32' ? '.ps1' : '.sh';
const isWin = process.platform === 'win32';

function wrapHookCommand(scriptPath: string, args?: string): string {
  if (!isWin) return args ? `${scriptPath} ${args}` : scriptPath;
  const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`;
  return args ? `${cmd} ${args}` : cmd;
}

export interface HookDefinition {
  /** Agent identifier (e.g. "qoder", "claude"). */
  agentId: string;
  /** Path to the agent's settings file (e.g. ~/.qoder/settings.json). */
  settingsPath: string;
  /** File syntax. Defaults to strict JSON. */
  settingsSyntax?: JsonSyntax;
  /** JSON path to inject hooks into (e.g. ["hooks", "PostToolUse"]). */
  hookJsonPath: string[];
  /** The hook command to inject. */
  hookCommand: string;
  /** Matcher pattern for the hook. */
  matcher?: string;
  /** Optional explicit history log directory for agents whose control id differs from storage path. */
  historyDir?: string;
  /** Hook commands that should be removed when installing this definition. */
  replaceHookCommands?: string[];
  /**
   * If true, use Qoder's nested format:
   *   { matcher: "...", hooks: [{ command, type }] }
   * Otherwise use flat format:
   *   { command, type, matcher }
   */
  useNestedFormat?: boolean;
  /**
   * Optional shell declared on the nested hook entry's inner object
   * (`{ command, type, shell }`). Set for hosts (Qoder family on Windows) that
   * need `"shell": "powershell"` to run the `.ps1` command through PowerShell.
   * Only emitted when set, so agents that omit it (e.g. codex) are unaffected.
   */
  shell?: string;
  /** Optional hook timeout in seconds, written onto the command entry. */
  timeout?: number;
  /** Where to insert a new entry. Defaults to tail to keep collection hooks stable. */
  insert?: 'head' | 'tail';
}

/**
 * Manages installation and removal of hook scripts into AI tools' config files.
 *
 * Hook injection flow:
 *   1. Read tool's settings.json
 *   2. Navigate to the hookJsonPath
 *   3. Append the hook command entry if not already present
 *   4. Write back settings.json
 */
export class HookManager {
  private readonly hookScriptDir: string;
  private readonly logBaseDir: string;

  constructor(hookScriptDir?: string, logBaseDir?: string) {
    this.hookScriptDir = hookScriptDir ?? resolveHome('~/.loongsuite-pilot/hooks');
    this.logBaseDir = logBaseDir ?? resolveHome('~/.loongsuite-pilot/logs');
  }

  /**
   * Install a hook into the target tool's configuration.
   */
  async installHook(def: HookDefinition): Promise<boolean> {
    try {
      return def.agentId === 'claude-code'
        ? await withClaudeSettingsLock(def.settingsPath, () => this.installHookUnlocked(def))
        : await this.installHookUnlocked(def);
    } catch (err) {
      logger.error('hook configuration lock failed', { agentId: def.agentId, error: String(err) });
      return false;
    }
  }

  private async installHookUnlocked(def: HookDefinition): Promise<boolean> {
    await ensureDir(path.dirname(def.settingsPath));
    return this.retryConcurrentWrite(() => this.installJsoncHook(def));
  }

  private async retryConcurrentWrite(operation: () => Promise<boolean>): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await operation(); }
      catch (error) {
        if (!(error instanceof Error) || !error.message.includes('file changed before write') || attempt === 2) throw error;
      }
    }
    return false;
  }

  /**
   * Remove a previously installed hook.
   */
  async uninstallHook(def: HookDefinition): Promise<boolean> {
    try {
      return def.agentId === 'claude-code'
        ? await withClaudeSettingsLock(def.settingsPath, () => this.uninstallHookUnlocked(def))
        : await this.uninstallHookUnlocked(def);
    } catch (err) {
      logger.error('hook configuration lock failed', { agentId: def.agentId, error: String(err) });
      return false;
    }
  }

  private async uninstallHookUnlocked(def: HookDefinition): Promise<boolean> {
    return this.retryConcurrentWrite(() => this.uninstallJsoncHook(def));
  }

  /**
   * Check if a hook is currently installed.
   */
  async isHookInstalled(def: HookDefinition): Promise<boolean> {
    try {
      const document = await readJsonDocument<Record<string, unknown>>(
        def.settingsPath,
        def.settingsSyntax ?? 'json',
      );
      if (document.status !== 'ok') return false;
      const settings = this.requireSettingsObject(document.data);

      let target: any = settings;
      for (const key of def.hookJsonPath.slice(0, -1)) {
        if (!target[key]) return false;
        target = target[key];
      }

      const lastKey = def.hookJsonPath[def.hookJsonPath.length - 1];
      if (!Array.isArray(target[lastKey])) return false;

      const hooks = target[lastKey] as any[];
      if (def.replaceHookCommands?.some(command => this.isCommandPresent(hooks, command))) {
        return false;
      }

      if (!this.isCommandPresent(hooks, def.hookCommand)) return false;

      // A matching command whose nested entry lacks the required `shell` counts
      // as not fully installed, so an upgrade that adds winShell (Qoder family
      // on Windows) redeploys and repairs the entry rather than skipping it.
      if (!this.hasRequiredShell(hooks, def.hookCommand, def.shell)) return false;
      if (!this.hasRequiredTimeout(hooks, def.hookCommand, def.timeout)) return false;
      if (def.insert === 'head' && !this.isCommandAtHead(hooks, def.hookCommand)) return false;
      return true;
    } catch {
      return false;
    }
  }

  private async installJsoncHook(def: HookDefinition): Promise<boolean> {
    const document = await readJsonDocument<Record<string, unknown>>(
      def.settingsPath,
      def.settingsSyntax ?? 'json',
    );
    if (document.status === 'error') {
      throw new Error(`refusing to overwrite invalid settings: ${document.error.message}`);
    }

    const expected = document.status === 'missing'
      ? { exists: false as const }
      : { exists: true as const, content: document.raw };
    let raw = document.status === 'missing' || document.status === 'empty'
      ? '{}\n'
      : document.raw;
    const settings = document.status === 'missing' || document.status === 'empty'
      ? {}
      : this.requireSettingsObject(document.data);
    const existingValue = this.valueAtPath(settings, def.hookJsonPath);
    if (existingValue !== undefined && !Array.isArray(existingValue)) {
      throw new Error(`hook path is not an array: ${def.hookJsonPath.join('.')}`);
    }

    if (def.replaceHookCommands?.length && Array.isArray(existingValue)) {
      raw = this.removeCommandsFromJsonc(
        raw,
        def.hookJsonPath,
        existingValue,
        def.replaceHookCommands,
      );
    }

    const reparsed = parseJsonDocument<Record<string, unknown>>(raw, 'jsonc');
    if (!reparsed.ok) throw reparsed.error;
    const currentValue = this.valueAtPath(
      this.requireSettingsObject(reparsed.data),
      def.hookJsonPath,
    );
    if (currentValue !== undefined && !Array.isArray(currentValue)) {
      throw new Error(`hook path is not an array: ${def.hookJsonPath.join('.')}`);
    }
    const hooks = currentValue ?? [];

    if (!this.isCommandPresent(hooks, def.hookCommand)) {
      const hookEntry = this.buildHookEntry(def);
      raw = currentValue === undefined
        ? editJsonc(raw, def.hookJsonPath, [hookEntry])
        : editJsonc(
            raw,
            [...def.hookJsonPath, def.insert === 'head' ? 0 : hooks.length],
            hookEntry,
            { isArrayInsertion: true },
          );
    } else {
      raw = this.repairJsoncHookEntry(raw, def, hooks);
    }

    if (document.status === 'ok' && raw === document.raw) {
      logger.debug('hook already installed', { agentId: def.agentId });
      return true;
    }

    await writeTextFileAtomic(def.settingsPath, raw, {
      expected,
      backupPath: document.status === 'missing'
        ? undefined
        : `${def.settingsPath}.loongsuite-pilot.bak`,
    });
    await ensureDir(def.historyDir ?? path.join(this.logBaseDir, def.agentId, 'history'));
    logger.info('hook installed', { agentId: def.agentId });
    return true;
  }

  private async uninstallJsoncHook(def: HookDefinition): Promise<boolean> {
    const document = await readJsonDocument<Record<string, unknown>>(
      def.settingsPath,
      def.settingsSyntax ?? 'json',
    );
    if (document.status === 'missing' || document.status === 'empty') return true;
    if (document.status === 'error') {
      throw new Error(`refusing to overwrite invalid settings: ${document.error.message}`);
    }

    const settings = this.requireSettingsObject(document.data);
    const existingValue = this.valueAtPath(settings, def.hookJsonPath);
    if (existingValue === undefined) return true;
    if (!Array.isArray(existingValue)) {
      throw new Error(`hook path is not an array: ${def.hookJsonPath.join('.')}`);
    }

    const commands = [def.hookCommand, ...(def.replaceHookCommands ?? [])];
    let raw = this.removeCommandsFromJsonc(
      document.raw,
      def.hookJsonPath,
      existingValue,
      commands,
    );
    if (raw === document.raw) return true;
    const parsed = parseJsonDocument<Record<string, unknown>>(raw, def.settingsSyntax ?? 'json');
    if (parsed.ok && Array.isArray(this.valueAtPath(parsed.data, def.hookJsonPath)) &&
      (this.valueAtPath(parsed.data, def.hookJsonPath) as unknown[]).length === 0) raw = editJsonc(raw, def.hookJsonPath, undefined);

    await writeTextFileAtomic(def.settingsPath, raw, {
      expected: { exists: true, content: document.raw },
      backupPath: `${def.settingsPath}.loongsuite-pilot.bak`,
    });
    logger.info('hook uninstalled', { agentId: def.agentId });
    return true;
  }

  private removeCommandsFromJsonc(
    source: string,
    hookPath: string[],
    entries: unknown[],
    commands: string[],
  ): string {
    let raw = source;
    for (let entryIndex = entries.length - 1; entryIndex >= 0; entryIndex--) {
      const entry = entries[entryIndex] as any;
      if (commands.includes(entry?.command)) {
        raw = editJsonc(raw, [...hookPath, entryIndex], undefined);
        continue;
      }
      if (!Array.isArray(entry?.hooks)) continue;

      const matching: number[] = [];
      for (let hookIndex = entry.hooks.length - 1; hookIndex >= 0; hookIndex--) {
        if (commands.includes(entry.hooks[hookIndex]?.command)) {
          matching.push(hookIndex);
        }
      }
      if (matching.length === entry.hooks.length && matching.length > 0) {
        raw = editJsonc(raw, [...hookPath, entryIndex], undefined);
        continue;
      }
      for (const hookIndex of matching) {
        raw = editJsonc(raw, [...hookPath, entryIndex, 'hooks', hookIndex], undefined);
      }
    }
    const parsed = parseJsonDocument<Record<string, unknown>>(raw, 'jsonc');
    return parsed.ok ? raw : editJsonc(source, hookPath, this.removeCommands(entries, commands));
  }

  private buildHookEntry(def: HookDefinition): Record<string, unknown> {
    const timeout = typeof def.timeout === 'number' ? { timeout: def.timeout } : {};
    return def.useNestedFormat
      ? {
          matcher: def.matcher ?? '*',
          hooks: [{
            command: def.hookCommand,
            type: 'command',
            ...(def.shell ? { shell: def.shell } : {}),
            ...timeout,
          }],
        }
      : {
          type: 'command',
          command: def.hookCommand,
          ...(def.matcher ? { matcher: def.matcher } : {}),
          ...timeout,
        };
  }

  private valueAtPath(root: Record<string, unknown>, jsonPath: string[]): unknown {
    let current: unknown = root;
    for (const key of jsonPath) {
      if (!current || typeof current !== 'object' || Array.isArray(current)) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[key];
    }
    return current;
  }

  private requireSettingsObject(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('settings root must be a JSON object');
    }
    return value as Record<string, unknown>;
  }

  /**
   * Build hook definitions for Cursor.
   * Registers cursor-loongsuite-pilot-hook.sh into ~/.cursor/hooks.json for key events.
   */
  static buildCursorHooks(loongsuitePilotDir?: string): HookDefinition[] {
    const baseDir = loongsuitePilotDir ?? resolveHome('~/.loongsuite-pilot');
    const command = wrapHookCommand(`${baseDir}/hooks/cursor-loongsuite-pilot-hook${hookExt}`);
    const settingsPath = resolveHome('~/.cursor/hooks.json');

    const events = [
      'stop',
      'preToolUse',
      'postToolUse',
      'postToolUseFailure',
      'beforeSubmitPrompt',
      'preCompact',
      'sessionStart',
      'sessionEnd',
      'subagentStart',
      'subagentStop',
      'afterAgentResponse',
      'afterAgentThought',
    ];

    return events.map(event => ({
      agentId: 'cursor',
      settingsPath,
      hookJsonPath: ['hooks', event],
      hookCommand: command,
      historyDir: path.join(baseDir, 'logs', 'cursor', 'history'),
    }));
  }

  /**
   * Build hook definitions for Qoder CLI (Stop only).
   */
  static buildQoderCliHooks(loongsuitePilotDir?: string): HookDefinition[] {
    const baseDir = loongsuitePilotDir ?? resolveHome('~/.loongsuite-pilot');
    const command = wrapHookCommand(`${baseDir}/hooks/qoder-loongsuite-pilot-hook${hookExt}`, 'qoder');
    const settingsPath = resolveHome('~/.qoder/settings.json');

    return [
      {
        agentId: 'qoder',
        settingsPath,
        hookJsonPath: ['hooks', 'Stop'],
        hookCommand: command,
        matcher: '*',
        useNestedFormat: true,
      },
    ];
  }

  /**
   * Build hook definitions for Qoder Work (Stop only).
   */
  static buildQoderWorkHooks(loongsuitePilotDir?: string): HookDefinition[] {
    const baseDir = loongsuitePilotDir ?? resolveHome('~/.loongsuite-pilot');
    const command = wrapHookCommand(`${baseDir}/hooks/qoderwork-loongsuite-pilot-hook${hookExt}`);
    const legacyCommand = wrapHookCommand(`${baseDir}/hooks/qoder-loongsuite-pilot-hook${hookExt}`, 'qoder-work');
    const settingsPath = resolveHome('~/.qoderwork/settings.json');

    const replaceCmds = [legacyCommand];
    if (isWin) {
      replaceCmds.push(`${baseDir}/hooks/qoderwork-loongsuite-pilot-hook.sh`);
      replaceCmds.push(`${baseDir}/hooks/qoderwork-loongsuite-pilot-hook.ps1`);
      replaceCmds.push(`${baseDir}/hooks/qoder-loongsuite-pilot-hook.sh qoder-work`);
      replaceCmds.push(`${baseDir}/hooks/qoder-loongsuite-pilot-hook.ps1 qoder-work`);
    }

    return [
      {
        agentId: 'qoder-work',
        settingsPath,
        hookJsonPath: ['hooks', 'Stop'],
        hookCommand: command,
        replaceHookCommands: replaceCmds,
        matcher: '*',
        useNestedFormat: true,
      },
    ];
  }

  static buildQoderWorkCNHooks(loongsuitePilotDir?: string): HookDefinition[] {
    const baseDir = loongsuitePilotDir ?? resolveHome('~/.loongsuite-pilot');
    const command = wrapHookCommand(`${baseDir}/hooks/qoderworkcn-loongsuite-pilot-hook${hookExt}`);
    const legacyCommand = wrapHookCommand(`${baseDir}/hooks/qoder-loongsuite-pilot-hook${hookExt}`, 'qoder-work-cn');
    const settingsPath = resolveHome('~/.qoderworkcn/settings.json');

    const replaceCmds = [legacyCommand];
    if (isWin) {
      replaceCmds.push(`${baseDir}/hooks/qoderworkcn-loongsuite-pilot-hook.sh`);
      replaceCmds.push(`${baseDir}/hooks/qoderworkcn-loongsuite-pilot-hook.ps1`);
      replaceCmds.push(`${baseDir}/hooks/qoder-loongsuite-pilot-hook.sh qoder-work-cn`);
      replaceCmds.push(`${baseDir}/hooks/qoder-loongsuite-pilot-hook.ps1 qoder-work-cn`);
    }

    return [
      {
        agentId: 'qoder-work-cn',
        settingsPath,
        hookJsonPath: ['hooks', 'Stop'],
        hookCommand: command,
        replaceHookCommands: replaceCmds,
        matcher: '*',
        useNestedFormat: true,
      },
    ];
  }

  /** Build the dedicated QwenWorkCN Stop hook definition. */
  static buildQwenWorkCNHooks(loongsuitePilotDir?: string): HookDefinition[] {
    const baseDir = loongsuitePilotDir ?? resolveHome('~/.loongsuite-pilot');
    const command = wrapHookCommand(`${baseDir}/hooks/qwenworkcn-loongsuite-pilot-hook${hookExt}`);
    return [
      {
        agentId: 'qwen-work-cn',
        settingsPath: resolveHome('~/.qwenworkcn/settings.json'),
        hookJsonPath: ['hooks', 'Stop'],
        hookCommand: command,
        matcher: '*',
        useNestedFormat: true,
        shell: isWin ? 'powershell' : undefined,
      },
    ];
  }

  /**
   * @deprecated Use buildQoderCliHooks() instead.
   */
  static buildQoderCliHook(loongsuitePilotDir?: string): HookDefinition {
    return HookManager.buildQoderCliHooks(loongsuitePilotDir)[1];
  }

  /**
   * Build a standard hook definition for any MCP-compatible tool
   * that supports PostToolUse hooks.
   */
  static buildGenericHook(opts: {
    agentId: string;
    settingsDir: string;
    loongsuitePilotDir?: string;
  }): HookDefinition {
    const baseDir = opts.loongsuitePilotDir ?? resolveHome('~/.loongsuite-pilot');
    return {
      agentId: opts.agentId,
      settingsPath: path.join(opts.settingsDir, 'settings.json'),
      hookJsonPath: ['hooks', 'PostToolUse'],
      hookCommand: wrapHookCommand(`${baseDir}/hooks/${opts.agentId}-hook${hookExt}`),
      matcher: '*',
    };
  }

  /**
   * Check if a command string exists in a hook array entry,
   * supporting both flat ({ command }) and nested ({ hooks: [{ command }] }) formats.
   */
  private entryMatchesCommand(entry: any, command: string): boolean {
    if (entry.command === command) return true;
    if (Array.isArray(entry.hooks)) {
      return entry.hooks.some((h: any) => h.command === command);
    }
    return false;
  }

  private isCommandPresent(arr: any[], command: string): boolean {
    return arr.some((entry: any) => this.entryMatchesCommand(entry, command));
  }

  /**
   * Whether the nested inner hook matching `command` declares the required
   * `shell`. `shell` lives only on nested inner entries (`{ command, type,
   * shell }`), so this only inspects those. Returns true when `shell` is unset
   * (non-Windows, or agents that don't declare winShell) — the shell dimension
   * is simply ignored there.
   */
  private hasRequiredShell(arr: any[], command: string, shell?: string): boolean {
    if (!shell) return true;
    return arr.some((entry: any) =>
      Array.isArray(entry.hooks) &&
      entry.hooks.some((h: any) => h.command === command && h.shell === shell),
    );
  }

  /**
   * Set `shell` on every nested inner hook matching `command` when it is
   * missing or stale. Returns true if any entry was mutated. No-op when `shell`
   * is unset. Used to repair entries installed before winShell was introduced.
   */
  private applyShellToEntries(arr: any[], command: string, shell?: string): boolean {
    if (!shell) return false;
    let changed = false;
    for (const entry of arr) {
      if (!Array.isArray(entry.hooks)) continue;
      for (const h of entry.hooks) {
        if (h.command === command && h.shell !== shell) {
          h.shell = shell;
          changed = true;
        }
      }
    }
    return changed;
  }

  private hasRequiredTimeout(arr: any[], command: string, timeout?: number): boolean {
    if (timeout === undefined) return true;
    return arr.some((entry: any) => {
      if (entry.command === command) return entry.timeout === timeout;
      return Array.isArray(entry.hooks)
        && entry.hooks.some((h: any) => h.command === command && h.timeout === timeout);
    });
  }

  private applyTimeoutToEntries(arr: any[], command: string, timeout?: number): boolean {
    if (timeout === undefined) return false;
    let changed = false;
    for (const entry of arr) {
      if (entry.command === command && entry.timeout !== timeout) {
        entry.timeout = timeout;
        changed = true;
      }
      if (!Array.isArray(entry.hooks)) continue;
      for (const h of entry.hooks) {
        if (h.command === command && h.timeout !== timeout) {
          h.timeout = timeout;
          changed = true;
        }
      }
    }
    return changed;
  }

  private isCommandAtHead(arr: any[], command: string): boolean {
    return arr.length > 0 && this.entryMatchesCommand(arr[0], command);
  }

  private moveCommandToHead(arr: any[], command: string, insert?: 'head' | 'tail'): boolean {
    if (insert !== 'head' || this.isCommandAtHead(arr, command)) return false;
    const index = arr.findIndex((entry) => this.entryMatchesCommand(entry, command));
    if (index < 0) return false;
    const [entry] = arr.splice(index, 1);
    arr.unshift(entry);
    return true;
  }

  private repairJsoncHookEntry(
    raw: string,
    def: HookDefinition,
    hooks: any[],
  ): string {
    const index = hooks.findIndex((entry) => this.entryMatchesCommand(entry, def.hookCommand));
    if (index < 0) return raw;
    let next = this.applyTimeoutToJsonc(raw, def, hooks, index);
    if (def.shell && Array.isArray(hooks[index]?.hooks)) {
      for (let j = 0; j < hooks[index].hooks.length; j++) {
        if (hooks[index].hooks[j]?.command === def.hookCommand && hooks[index].hooks[j].shell !== def.shell) {
          next = editJsonc(next, [...def.hookJsonPath, index, 'hooks', j, 'shell'], def.shell);
        }
      }
      this.applyShellToEntries(hooks, def.hookCommand, def.shell);
    }
    // The move below reinserts the in-memory entry. applyTimeoutToJsonc only
    // edits the serialized text, so the object must carry the timeout too.
    this.applyTimeoutToEntries(hooks, def.hookCommand, def.timeout);
    if (def.insert === 'head' && index > 0) {
      const entry = hooks[index];
      next = editJsonc(next, [...def.hookJsonPath, index], undefined);
      next = editJsonc(next, [...def.hookJsonPath, 0], entry, { isArrayInsertion: true });
    }
    return next;
  }

  private applyTimeoutToJsonc(
    raw: string,
    def: HookDefinition,
    hooks: any[],
    entryIndex: number,
  ): string {
    if (def.timeout === undefined) return raw;
    const entry = hooks[entryIndex];
    if (entry?.command === def.hookCommand && entry.timeout !== def.timeout) {
      return editJsonc(raw, [...def.hookJsonPath, entryIndex, 'timeout'], def.timeout);
    }
    if (!Array.isArray(entry?.hooks)) return raw;
    const hookIndex = entry.hooks.findIndex((h: any) => h.command === def.hookCommand);
    if (hookIndex < 0 || entry.hooks[hookIndex].timeout === def.timeout) return raw;
    return editJsonc(
      raw,
      [...def.hookJsonPath, entryIndex, 'hooks', hookIndex, 'timeout'],
      def.timeout,
    );
  }

  private removeCommands(arr: any[], commands: string[]): any[] {
    return arr
      .map((entry: any) => this.removeCommandsFromEntry(entry, commands))
      .filter((entry: any) => entry !== null);
  }

  private removeCommandsFromEntry(entry: any, commands: string[]): any | null {
    if (commands.includes(entry.command)) return null;
    if (!Array.isArray(entry.hooks)) return entry;

    const hooks = entry.hooks.filter((h: any) => !commands.includes(h.command));
    if (hooks.length === 0) return null;
    if (hooks.length === entry.hooks.length) return entry;
    return { ...entry, hooks };
  }
}
