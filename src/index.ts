#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { Client } from 'ssh2';
import { z } from 'zod';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync, appendFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { parse as parseYaml } from 'yaml';

// ── Types ──────────────────────────────────────────────────────────────────

interface HostConfig {
  host: string;
  port?: number;
  user: string;
  password?: string;
  key?: string;
  sudoPassword?: string;
  suPassword?: string;
  timeout?: number;
}

interface HostsFile {
  hosts: Record<string, HostConfig>;
}

// ── Security Types ──────────────────────────────────────────────────────────

type SecurityLevel = 'standard' | 'strict' | 'readonly' | 'disabled';

interface SecurityRule {
  pattern: RegExp;
  reason: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

interface SecurityRuleRaw {
  pattern: string;
  reason: string;
  severity?: 'critical' | 'high' | 'medium' | 'low';
}

interface SecurityConfig {
  level: SecurityLevel;
  blocked: SecurityRule[];
  allowed: SecurityRule[];
  hosts: Record<string, {
    level?: SecurityLevel;
    blocked?: SecurityRule[];
    allowed?: SecurityRule[];
  }>;
}

interface SecurityConfigRaw {
  level?: SecurityLevel;
  blocked?: SecurityRuleRaw[];
  allowed?: SecurityRuleRaw[];
  hosts?: Record<string, {
    level?: SecurityLevel;
    blocked?: SecurityRuleRaw[];
    allowed?: SecurityRuleRaw[];
  }>;
}

// ── CLI argument parsing ───────────────────────────────────────────────────

function parseArgv(): Record<string, string | null> {
  const args = process.argv.slice(2);
  const config: Record<string, string | null> = {};
  for (const arg of args) {
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq === -1) {
        config[arg.slice(2)] = null;
      } else {
        config[arg.slice(2, eq)] = arg.slice(eq + 1);
      }
    }
  }
  return config;
}

const argv = parseArgv();

const HOSTS_FILE = argv['hosts-file'];
const SINGLE_HOST = argv.host ?? null;
const SINGLE_PORT = argv.port ? parseInt(argv.port) : 22;
const SINGLE_USER = argv.user ?? null;
const SINGLE_PASSWORD = argv.password ?? null;
const SINGLE_KEY = argv.key ?? null;
const SINGLE_SU_PASSWORD = argv.suPassword ?? null;
const SINGLE_SUDO_PASSWORD = argv.sudoPassword ?? null;
const DEFAULT_TIMEOUT = argv.timeout ? parseInt(argv.timeout) : 60000;
const MAX_CHARS = (() => {
  const raw = argv.maxChars;
  if (typeof raw === 'string') {
    if (raw.toLowerCase() === 'none') return Infinity;
    const n = parseInt(raw);
    if (isNaN(n) || n <= 0) return Infinity;
    return n;
  }
  return 1000;
})();
const DISABLE_SUDO = argv.disableSudo !== undefined;
const SECURITY_FILE = argv['security-file'] ?? null;

// ── Mode detection ─────────────────────────────────────────────────────────

const isMultiHost = !!HOSTS_FILE;

// ── Load hosts config ──────────────────────────────────────────────────────

const hostsConfig: Record<string, HostConfig> = {};

if (isMultiHost) {
  const filePath = resolve(HOSTS_FILE!);
  const content = readFileSync(filePath, 'utf8');
  const parsed = parseYaml(content) as HostsFile;
  if (!parsed?.hosts || typeof parsed.hosts !== 'object') {
    console.error(`Invalid hosts file: ${filePath}. Expected top-level "hosts" mapping.`);
    process.exit(1);
  }
  for (const [name, cfg] of Object.entries(parsed.hosts)) {
    if (!cfg.host || !cfg.user) {
      console.error(`Host "${name}" missing required "host" or "user" field.`);
      process.exit(1);
    }
    hostsConfig[name] = {
      host: cfg.host,
      port: cfg.port ?? 22,
      user: cfg.user,
      password: cfg.password,
      key: cfg.key ? resolve(dirname(filePath), cfg.key) : undefined,
      sudoPassword: cfg.sudoPassword,
      suPassword: cfg.suPassword,
      timeout: cfg.timeout,
    };
  }
  console.error(`Loaded ${Object.keys(hostsConfig).length} hosts from ${filePath}`);
} else if (SINGLE_HOST && SINGLE_USER) {
  hostsConfig['__default__'] = {
    host: SINGLE_HOST,
    port: SINGLE_PORT,
    user: SINGLE_USER,
    password: SINGLE_PASSWORD ?? undefined,
    key: SINGLE_KEY ?? undefined,
    sudoPassword: SINGLE_SUDO_PASSWORD ?? undefined,
    suPassword: SINGLE_SU_PASSWORD ?? undefined,
  };
} else {
  console.error('Usage: --hosts-file=<path> OR --host=<ip> --user=<name> [--password=<pw> | --key=<path>]');
  process.exit(1);
}

// ── Default Security Rules ─────────────────────────────────────────────────

const DEFAULT_BLOCKED_RULES: SecurityRuleRaw[] = [
  // Filesystem destruction
  { pattern: '(^|\\s|;|&&|\\|\\|)\\s*rm\\s+(-\\w*\\s+)*/(\\s|$)', reason: '禁止删除根目录 (rm /)', severity: 'critical' },
  { pattern: '(^|\\s|;|&&|\\|\\|)\\s*rm\\s+(-\\w*\\s+)*/etc\\b', reason: '禁止删除 /etc 下的系统文件 (rm /etc)', severity: 'critical' },
  { pattern: '(^|\\s|;|&&|\\|\\|)\\s*mkfs(\\.|\\s|$)', reason: '禁止格式化文件系统 (mkfs)', severity: 'critical' },
  { pattern: '(^|\\s|;|&&|\\|\\|)\\s*dd\\s+.*of=/dev/', reason: '禁止直接写块设备 (dd to block device)', severity: 'critical' },
  // System control
  { pattern: '(^|\\s|;|&&|\\|\\|)\\s*(shutdown|poweroff|halt)\\b', reason: '禁止关机 (shutdown/poweroff/halt)', severity: 'critical' },
  { pattern: '(^|\\s|;|&&|\\|\\|)\\s*reboot\\b', reason: '禁止重启 (reboot)', severity: 'critical' },
  { pattern: '(^|\\s|;|&&|\\|\\|)\\s*init\\s+[06]\\b', reason: '禁止切换到关机/重启运行级别 (init 0/6)', severity: 'critical' },
  // Network destruction
  { pattern: '(^|\\s|;|&&|\\|\\|)\\s*iptables\\s+-F\\b', reason: '禁止清空防火墙规则 (iptables -F)', severity: 'critical' },
  { pattern: '(^|\\s|;|&&|\\|\\|)\\s*ip\\s+link\\s+set\\s+\\S+\\s+down\\b', reason: '禁止关闭网络接口 (ip link set down)', severity: 'high' },
  // User/permission manipulation
  { pattern: '(^|\\s|;|&&|\\|\\|)\\s*passwd\\s+root\\b', reason: '禁止修改 root 密码 (passwd root)', severity: 'critical' },
  { pattern: '(^|\\s|;|&&|\\|\\|)\\s*userdel\\s+(-\\w*\\s+)?root\\b', reason: '禁止删除 root 用户 (userdel root)', severity: 'critical' },
  { pattern: '(^|\\s|;|&&|\\|\\|)\\s*(chmod|chown)\\s+(-\\w*\\s+)?(000|777)\\s+/', reason: '禁止在根路径设置极端权限 (chmod/chown 000/777 on /)', severity: 'high' },
  // Package removal (system-critical)
  { pattern: '(^|\\s|;|&&|\\|\\|)\\s*(apt|yum|dnf)\\s+remove\\s+.*\\b(kernel|systemd|bash|coreutils|openssh|sudo)\\b', reason: '禁止卸载关键系统包 (removing critical packages)', severity: 'critical' },
  // Overwriting critical files
  { pattern: '(>\\s*|>>\\s*)/etc/(passwd|shadow|sudoers|ssh/sshd_config)(\\s|$)', reason: '禁止覆盖关键系统文件 (overwriting /etc/passwd, shadow, etc.)', severity: 'critical' },
  // Kernel module removal
  { pattern: '(^|\\s|;|&&|\\|\\|)\\s*modprobe\\s+-r\\s+\\S+', reason: '禁止卸载内核模块 (modprobe -r)', severity: 'high' },
  // Evasion/obfuscation
  { pattern: '(^|\\s|;|&&|\\|\\|)\\s*(eval|bash\\s+-c)\\s+.*\\b(rm|shutdown|reboot|mkfs|dd|halt|poweroff|passwd)\\b', reason: '禁止通过 eval/bash -c 间接执行危险命令', severity: 'critical' },
  { pattern: '(base64\\s+-d|gunzip|gzip\\s+-d)\\s*.*\\|\\s*(bash|sh)\\b', reason: '禁止通过编码/压缩绕过执行命令 (encoded command execution)', severity: 'critical' },
];

// ── Security Engine ─────────────────────────────────────────────────────────

function compileRules(raw: SecurityRuleRaw[]): SecurityRule[] {
  return raw.map(r => ({
    pattern: new RegExp(r.pattern, 'i'),
    reason: r.reason,
    severity: r.severity ?? 'high',
  }));
}

function loadSecurityConfig(securityFilePath: string | null): SecurityConfig {
  let raw: SecurityConfigRaw = { level: 'standard' };

  if (securityFilePath) {
    const filePath = resolve(securityFilePath);
    try {
      const content = readFileSync(filePath, 'utf8');
      const parsed = parseYaml(content) as SecurityConfigRaw;
      if (parsed && typeof parsed === 'object') {
        raw = parsed;
      }
    } catch (err: any) {
      console.error(`Warning: Failed to load security config from ${filePath}: ${err.message}`);
      console.error('Falling back to default security rules.');
    }
  }

  const level = raw.level ?? 'standard';

  // Merge default + user-defined blocked rules
  const userBlocked = raw.blocked ?? [];
  const allBlocked = compileRules([...DEFAULT_BLOCKED_RULES, ...userBlocked]);

  const allAllowed = compileRules(raw.allowed ?? []);

  // Compile per-host overrides
  const hostOverrides: SecurityConfig['hosts'] = {};
  if (raw.hosts) {
    for (const [hostName, hostCfg] of Object.entries(raw.hosts)) {
      if (hostCfg) {
        hostOverrides[hostName] = {
          level: hostCfg.level,
          blocked: hostCfg.blocked ? compileRules(hostCfg.blocked) : undefined,
          allowed: hostCfg.allowed ? compileRules(hostCfg.allowed) : undefined,
        };
      }
    }
  }

  const config: SecurityConfig = {
    level,
    blocked: allBlocked,
    allowed: allAllowed,
    hosts: hostOverrides,
  };

  console.error(`Security: level=${level}, ${allBlocked.length} blocked rules, ${allAllowed.length} allowed rules`);
  return config;
}

function splitCommandChain(command: string): string[] {
  // Split by shell operators: ; | && || |&
  const segments = command.split(/\s*(?:;|\|\||&&|\|&|\|)\s*/);
  return segments.map(s => s.trim()).filter(s => s.length > 0);
}

function checkCommandSecurity(
  command: string,
  hostLabel: string,
  config: SecurityConfig,
): { allowed: boolean; reason?: string } {
  const hostOverride = config.hosts[hostLabel];
  const effectiveLevel = hostOverride?.level ?? config.level;

  if (effectiveLevel === 'disabled') {
    return { allowed: true };
  }

  const effectiveBlocked = hostOverride?.blocked
    ? [...config.blocked, ...hostOverride.blocked]
    : config.blocked;
  const effectiveAllowed = hostOverride?.allowed
    ? [...config.allowed, ...hostOverride.allowed]
    : config.allowed;

  // Check full command against blocked list first (catches cross-pipe patterns like base64 | bash)
  for (const rule of effectiveBlocked) {
    if (rule.pattern.test(command)) {
      return { allowed: false, reason: rule.reason };
    }
  }

  // Split compound commands and check each segment
  const segments = splitCommandChain(command);

  for (const segment of segments) {
    // Check blocked list on each segment
    for (const rule of effectiveBlocked) {
      if (rule.pattern.test(segment)) {
        return { allowed: false, reason: rule.reason };
      }
    }

    // In strict/readonly mode, check whitelist
    if (effectiveLevel === 'strict' || effectiveLevel === 'readonly') {
      if (effectiveAllowed.length === 0) {
        return { allowed: false, reason: `安全等级为 ${effectiveLevel}，但没有配置 allowed 白名单` };
      }
      const isAllowed = effectiveAllowed.some(rule => rule.pattern.test(segment));
      if (!isAllowed) {
        return { allowed: false, reason: `安全等级为 ${effectiveLevel}，该命令不在白名单中` };
      }
    }
  }

  return { allowed: true };
}

const securityConfig = loadSecurityConfig(SECURITY_FILE);

// ── Sanitization helpers (from original ssh-mcp) ───────────────────────────

function sanitizeCommand(command: string): string {
  if (typeof command !== 'string') throw new McpError(ErrorCode.InvalidParams, 'Command must be a string');
  const trimmed = command.trim();
  if (!trimmed) throw new McpError(ErrorCode.InvalidParams, 'Command cannot be empty');
  if (Number.isFinite(MAX_CHARS) && trimmed.length > MAX_CHARS) {
    throw new McpError(ErrorCode.InvalidParams, `Command too long (max ${MAX_CHARS} chars)`);
  }
  return trimmed;
}

function sanitizePassword(password?: string): string | undefined {
  if (!password || password.length === 0) return undefined;
  return password;
}

function escapeCommandForShell(command: string): string {
  return command.replace(/'/g, "'\"'\"'");
}

// ── SSHConnectionManager (from original ssh-mcp, unchanged core logic) ─────

class SSHConnectionManager {
  private conn: Client | null = null;
  private sshConfig: Record<string, unknown>;
  private isConnecting = false;
  private connectionPromise: Promise<void> | null = null;
  private suShell: unknown = null;
  private suPromise: Promise<void> | null = null;
  private isElevated = false;
  private hostLabel: string;
  private cmdTimeout: number;

  constructor(hostLabel: string, sshConfig: Record<string, unknown>, cmdTimeout: number) {
    this.hostLabel = hostLabel;
    this.sshConfig = sshConfig;
    this.cmdTimeout = cmdTimeout;
  }

  async connect(): Promise<void> {
    if (this.conn && this.isConnected()) return;
    if (this.isConnecting && this.connectionPromise) return this.connectionPromise;

    this.isConnecting = true;
    this.connectionPromise = new Promise<void>((resolve, reject) => {
      this.conn = new Client();
      const timeoutId = setTimeout(() => {
        this.conn?.end();
        this.conn = null;
        this.isConnecting = false;
        this.connectionPromise = null;
        reject(new McpError(ErrorCode.InternalError, `[${this.hostLabel}] SSH connection timeout`));
      }, 30000);

      this.conn!.on('ready', async () => {
        clearTimeout(timeoutId);
        this.isConnecting = false;
        if ((this.sshConfig as any).suPassword) {
          try { await this.ensureElevated(); } catch (_) { /* non-fatal */ }
        }
        resolve();
      });

      this.conn!.on('error', (err: Error) => {
        clearTimeout(timeoutId);
        this.conn = null;
        this.isConnecting = false;
        this.connectionPromise = null;
        reject(new McpError(ErrorCode.InternalError, `[${this.hostLabel}] SSH error: ${err.message}`));
      });

      this.conn!.on('end', () => { this.conn = null; this.isConnecting = false; this.connectionPromise = null; });
      this.conn!.on('close', () => { this.conn = null; this.isConnecting = false; this.connectionPromise = null; });
      this.conn!.connect(this.sshConfig as any);
    });
    return this.connectionPromise;
  }

  isConnected(): boolean {
    return this.conn !== null && !!(this.conn as any)._sock && !(this.conn as any)._sock.destroyed;
  }

  getSudoPassword(): string | undefined {
    return (this.sshConfig as any).sudoPassword;
  }

  async ensureConnected(): Promise<void> {
    if (!this.isConnected()) await this.connect();
  }

  getConnection(): Client {
    if (!this.conn) throw new McpError(ErrorCode.InternalError, `[${this.hostLabel}] SSH connection not established`);
    return this.conn;
  }

  async ensureElevated(): Promise<void> {
    if (this.isElevated && this.suShell) return;
    const suPassword = (this.sshConfig as any).suPassword;
    if (!suPassword) return;
    if (this.suPromise) return this.suPromise;

    this.suPromise = new Promise<void>((resolve, reject) => {
      const conn = this.getConnection();
      const timeoutId = setTimeout(() => { this.suPromise = null; reject(new McpError(ErrorCode.InternalError, `[${this.hostLabel}] su elevation timed out`)); }, 10000);

      conn.shell({ term: 'xterm', cols: 80, rows: 24 } as any, (err, stream) => {
        if (err) { clearTimeout(timeoutId); this.suPromise = null; reject(new McpError(ErrorCode.InternalError, `su shell failed: ${err.message}`)); return; }

        let buffer = '';
        let passwordSent = false;
        const cleanup = () => { try { stream.removeAllListeners('data'); } catch (_) {} };

        const onData = (data: Buffer) => {
          buffer += data.toString();
          if (!passwordSent && /password[: ]/i.test(buffer)) {
            passwordSent = true;
            stream.write(suPassword + '\n');
          }
          if (passwordSent && /#/.test(buffer)) {
            clearTimeout(timeoutId); cleanup();
            this.suShell = stream; this.isElevated = true; this.suPromise = null;
            resolve(); return;
          }
          if (/authentication failure|incorrect password|su: .*failed|su: failure/i.test(buffer)) {
            clearTimeout(timeoutId); cleanup(); this.suPromise = null;
            reject(new McpError(ErrorCode.InternalError, `su auth failed: ${buffer}`));
          }
        };
        stream.on('data', onData);
        stream.on('close', () => { if (!this.isElevated) { this.suPromise = null; reject(new McpError(ErrorCode.InternalError, 'su shell closed before elevation')); } });
        stream.write('su -\n');
      });
    });
    return this.suPromise;
  }

  close(): void {
    if (this.suShell) { try { (this.suShell as any).end(); } catch (_) {} this.suShell = null; this.isElevated = false; }
    if (this.conn) { this.conn.end(); this.conn = null; }
  }

  getTimeout(): number { return this.cmdTimeout; }
}

// ── Connection Pool ────────────────────────────────────────────────────────

class ConnectionPool {
  private pool = new Map<string, SSHConnectionManager>();

  async get(hostLabel: string): Promise<SSHConnectionManager> {
    let mgr = this.pool.get(hostLabel);
    if (mgr && mgr.isConnected()) return mgr;

    // Reconnect or create new
    if (mgr) { mgr.close(); this.pool.delete(hostLabel); }

    const cfg = hostsConfig[hostLabel];
    if (!cfg) {
      const available = Object.keys(hostsConfig).join(', ');
      throw new McpError(ErrorCode.InvalidParams, `Unknown host "${hostLabel}". Available: ${available}`);
    }

    const sshConfig: Record<string, unknown> = { host: cfg.host, port: cfg.port ?? 22, username: cfg.user };
    if (cfg.password) sshConfig.password = cfg.password;
    if (cfg.key) {
      const keyContent = readFileSync(cfg.key, 'utf8');
      sshConfig.privateKey = keyContent;
    }
    const sp = sanitizePassword(cfg.suPassword);
    if (sp) sshConfig.suPassword = sp;
    const sudop = sanitizePassword(cfg.sudoPassword);
    if (sudop) sshConfig.sudoPassword = sudop;

    mgr = new SSHConnectionManager(hostLabel, sshConfig, cfg.timeout ?? DEFAULT_TIMEOUT);
    await mgr.connect();
    this.pool.set(hostLabel, mgr);
    return mgr;
  }

  closeAll(): void {
    for (const mgr of this.pool.values()) mgr.close();
    this.pool.clear();
  }
}

const pool = new ConnectionPool();

// ── Operation logging ──────────────────────────────────────────────────────

const LOG_DIR = isMultiHost
  ? resolve(dirname(HOSTS_FILE!), 'logs')
  : resolve('.', 'logs');

function appendLog(hostLabel: string, command: string, execMode: string, description?: string) {
  try {
    const timestamp = new Date().toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).replace(/\//g, '-');
    const line = description
      ? `[${timestamp}] ${execMode} cmd="${command}" desc="${description}"\n`
      : `[${timestamp}] ${execMode} cmd="${command}"\n`;
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(resolve(LOG_DIR, `${hostLabel}.log`), line);
  } catch (err) {
    console.error(`[log] failed to write log: ${err}`);
  }
}

// ── Command execution (from original ssh-mcp) ──────────────────────────────

async function execSshCommand(manager: SSHConnectionManager, command: string): Promise<{ content: { type: "text"; text: string }[] }> {
  return new Promise((resolve, reject) => {
    let timeoutId: NodeJS.Timeout;
    let isResolved = false;
    const timeout = manager.getTimeout();

    timeoutId = setTimeout(() => {
      if (!isResolved) { isResolved = true; reject(new McpError(ErrorCode.InternalError, `Command timed out after ${timeout}ms`)); }
    }, timeout);

    // If su shell is active, use it
    const suShell = (manager as any).suShell;
    if (suShell) {
      let buffer = '';
      const dataHandler = (data: Buffer) => {
        buffer += data.toString();
        if (/#/.test(buffer)) {
          if (!isResolved) {
            isResolved = true; clearTimeout(timeoutId);
            const lines = buffer.split('\n');
            const output = lines.slice(1, -1).join('\n');
            resolve({ content: [{ type: 'text' as const, text: output + (output ? '\n' : '') }] });
          }
          suShell.removeListener('data', dataHandler);
        }
      };
      suShell.on('data', dataHandler);
      suShell.write(command + '\n');
      return;
    }

    // Normal exec
    const conn = manager.getConnection();
    conn.exec(command, (err, stream) => {
      if (err) { if (!isResolved) { isResolved = true; clearTimeout(timeoutId); reject(new McpError(ErrorCode.InternalError, `SSH exec error: ${err.message}`)); } return; }

      let stdout = '';
      let stderr = '';
      stream.on('data', (data: Buffer) => { stdout += data.toString(); });
      stream.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
      stream.on('close', () => {
        if (!isResolved) {
          isResolved = true; clearTimeout(timeoutId);
          if (stderr) { reject(new McpError(ErrorCode.InternalError, `Error:\n${stderr}`)); }
          else { resolve({ content: [{ type: 'text' as const, text: stdout }] }); }
        }
      });
    });
  });
}

// ── MCP Server ─────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'SSH MCP Server (Multi-Host)',
  version: '2.0.0',
});

// Build the host description for tool metadata
const hostList = Object.keys(hostsConfig);
const hostDesc = isMultiHost
  ? `Target host name (required). Available hosts: ${hostList.join(', ')}`
  : `Target host name (optional, defaults to configured host).`;

// ── exec tool ──────────────────────────────────────────────────────────────

const execSchema = isMultiHost
  ? {
      host: z.string().describe(hostDesc),
      command: z.string().describe("Shell command to execute on the remote SSH server"),
      description: z.string().optional().describe("Optional description of what this command will do"),
    }
  : {
      host: z.string().optional().describe(hostDesc),
      command: z.string().describe("Shell command to execute on the remote SSH server"),
      description: z.string().optional().describe("Optional description of what this command will do"),
    };

server.tool("exec", "Execute a shell command on a remote SSH server.", execSchema, async (params: any) => {
  const sanitizedCommand = sanitizeCommand(params.command);

  const hostLabel = isMultiHost
    ? params.host
    : (params.host || '__default__');

  if (!hostLabel) {
    throw new McpError(ErrorCode.InvalidParams, 'Missing required "host" parameter.');
  }

  const secResult = checkCommandSecurity(sanitizedCommand, hostLabel, securityConfig);
  if (!secResult.allowed) {
    appendLog(hostLabel, sanitizedCommand, 'BLOCKED', params.description);
    throw new McpError(ErrorCode.InvalidParams, `Command blocked by security policy: ${secResult.reason}`);
  }

  const manager = await pool.get(hostLabel);
  await manager.ensureConnected();

  // If suPassword is set, ensure elevation
  if ((manager as any).sshConfig?.suPassword) {
    try {
      await Promise.race([
        manager.ensureElevated(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('elevation timeout')), 5000))
      ]);
    } catch (_) { /* non-fatal, fall back to non-elevated */ }
  }

  const cmdWithDesc = params.description
    ? `${sanitizedCommand} # ${params.description.replace(/#/g, '\\#')}`
    : sanitizedCommand;

  appendLog(hostLabel, sanitizedCommand, 'exec', params.description);

  return await execSshCommand(manager, cmdWithDesc);
});

// ── sudo-exec tool ─────────────────────────────────────────────────────────

if (!DISABLE_SUDO) {
  const sudoExecSchema = isMultiHost
    ? {
        host: z.string().describe(hostDesc),
        command: z.string().describe("Shell command to execute with sudo on the remote SSH server"),
        description: z.string().optional().describe("Optional description of what this command will do"),
      }
    : {
        host: z.string().optional().describe(hostDesc),
        command: z.string().describe("Shell command to execute with sudo on the remote SSH server"),
        description: z.string().optional().describe("Optional description of what this command will do"),
      };

  server.tool("sudo-exec", "Execute a shell command on a remote SSH server using sudo.", sudoExecSchema, async (params: any) => {
    const sanitizedCommand = sanitizeCommand(params.command);

    const hostLabel = isMultiHost
      ? params.host
      : (params.host || '__default__');

    if (!hostLabel) {
      throw new McpError(ErrorCode.InvalidParams, 'Missing required "host" parameter.');
    }

    const secResult = checkCommandSecurity(sanitizedCommand, hostLabel, securityConfig);
    if (!secResult.allowed) {
      appendLog(hostLabel, sanitizedCommand, 'BLOCKED', params.description);
      throw new McpError(ErrorCode.InvalidParams, `Command blocked by security policy: ${secResult.reason}`);
    }

    const manager = await pool.get(hostLabel);
    await manager.ensureConnected();

    const cmdWithDesc = params.description
      ? `${sanitizedCommand} # ${params.description.replace(/#/g, '\\#')}`
      : sanitizedCommand;

    const sudoPassword = manager.getSudoPassword();
    let wrapped: string;
    if (!sudoPassword) {
      wrapped = `sudo -n sh -c '${cmdWithDesc.replace(/'/g, "'\\''")}'`;
    } else {
      const pwdEscaped = sudoPassword.replace(/'/g, "'\\''");
      wrapped = `printf '%s\\n' '${pwdEscaped}' | sudo -p "" -S sh -c '${cmdWithDesc.replace(/'/g, "'\\''")}'`;
    }

    appendLog(hostLabel, sanitizedCommand, 'sudo', params.description);

    return await execSshCommand(manager, wrapped);
  });
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`SSH MCP Server (Multi-Host) running — ${Object.keys(hostsConfig).length} host(s) loaded`);

  const cleanup = () => {
    console.error("Shutting down...");
    pool.closeAll();
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('exit', () => { pool.closeAll(); });
}

main().catch((err) => {
  console.error("Fatal:", err);
  pool.closeAll();
  process.exit(1);
});
