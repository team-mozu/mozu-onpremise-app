import { spawn, SpawnOptions } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';

type P = ReturnType<typeof spawn>;
type Tag = 'server'|'frontend'|'migrations'|'mysql'|'sys';

export interface StartOptions {
  serverRepoPath: string;
  frontendRepoPath?: string;
  env?: Record<string, string>;
  dataSourcePathOverride?: string;
  mysql?: {
    host?: string; port?: number; user?: string; password?: string;
    database?: string; charset?: string; createIfNotExists?: boolean;
  };
  onLog?: (tag: Tag, line: string) => void;
}

function spawnSafe(cmd: string, args: string[], opts: SpawnOptions & { tag: Tag; onLog?: StartOptions['onLog'] }): P {
  const p = spawn(cmd, args, { ...opts, shell: false });
  p.stdout?.on('data', d => opts.onLog?.(opts.tag, d.toString()));
  p.stderr?.on('data', d => opts.onLog?.(opts.tag, d.toString()));
  p.on('exit', (c, s) => opts.onLog?.(opts.tag, `[exit] code=${c} signal=${s}\n`));
  return p;
}
const hasSpace = (p: string) => /\s/.test(p);
function symlinkNoSpace(target: string): string {
  if (!hasSpace(target)) return target;
  const base = path.join(os.tmpdir(), 'electron-links');
  fs.mkdirSync(base, { recursive: true });
  const link = path.join(base, 'ln_' + crypto.createHash('md5').update(target).digest('hex').slice(0, 10));
  try {
    if (!fs.existsSync(link)) fs.symlinkSync(target, link, 'dir');
    return link;
  } catch { return target; }
}
function detectPM(repoPath: string) {
  if (fs.existsSync(path.join(repoPath, 'pnpm-lock.yaml'))) return { cli: 'pnpm', runArgs: ['run'] as string[], yarn: false };
  if (fs.existsSync(path.join(repoPath, 'yarn.lock')))      return { cli: 'yarn', runArgs: [] as string[], yarn: true };
  if (fs.existsSync(path.join(repoPath, 'bun.lockb')))      return { cli: 'bun',  runArgs: ['run'] as string[], yarn: false };
  return { cli: 'npm', runArgs: ['run'] as string[], yarn: false };
}
function resolveDataSource(repoPath: string): string | null {
  const cands = [
    'src/data-source.ts','src/ormconfig.ts','src/ormconfig/data-source.ts',
    'ormconfig.ts','data-source.ts','dist/data-source.js','dist/ormconfig.js'
  ];
  for (const rel of cands) {
    const abs = path.join(repoPath, rel);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}
function mergeEnv(extra?: Record<string,string>): NodeJS.ProcessEnv {
  return { ...process.env, ...(extra||{}) };
}

export class ProcessManager {
  private ps: Partial<Record<Tag, P>> = {};

  async createDatabase(opts: StartOptions) {
    const c = {
      host: opts.mysql?.host ?? '127.0.0.1',
      port: opts.mysql?.port ?? 3306,
      user: opts.mysql?.user ?? 'root',
      password: opts.mysql?.password,
      database: opts.mysql?.database ?? 'mozu',
      charset: opts.mysql?.charset ?? 'utf8mb4',
      createIfNotExists: opts.mysql?.createIfNotExists ?? true,
    };
    if (!c.createIfNotExists) return;
    const args = ['-h', c.host, '-P', String(c.port), '-u', c.user,
      '-e', `CREATE DATABASE IF NOT EXISTS ${c.database} DEFAULT CHARACTER SET ${c.charset};`];
    const env = mergeEnv(opts.env);
    if (c.password) env.MYSQL_PWD = c.password;
    this.ps.mysql = spawnSafe('mysql', args, { cwd: process.cwd(), env, stdio: 'pipe', tag: 'mysql', onLog: opts.onLog });
    await new Promise<void>((res, rej) => this.ps.mysql!.on('exit', code => code === 0 ? res() : rej(new Error(`mysql exited ${code}`))));
  }

  async runMigrations(opts: StartOptions) {
    const repoCwdRaw = path.resolve(opts.serverRepoPath);
    const repoCwd = symlinkNoSpace(repoCwdRaw);
    const ds = opts.dataSourcePathOverride ?? resolveDataSource(repoCwdRaw);
    if (!ds) throw new Error('data-source 파일을 찾지 못했습니다. (예: src/data-source.ts / dist/data-source.js)');

    const isTS = ds.endsWith('.ts');
    const args = isTS
      ? ['ts-node', '-r', 'tsconfig-paths/register', 'node_modules/typeorm/cli.js', 'migration:run', '-d', ds]
      : ['typeorm', 'migration:run', '-d', ds];

    this.ps.migrations = spawnSafe('npx', args, { cwd: repoCwd, env: mergeEnv(opts.env), stdio: 'pipe', tag: 'migrations', onLog: opts.onLog });
    await new Promise<void>((res, rej) => this.ps.migrations!.on('exit', code => code === 0 ? res() : rej(new Error(`migrations exit ${code}`))));
  }

  installDeps(repoPath: string, onLog?: StartOptions['onLog']) {
    const cwd = symlinkNoSpace(path.resolve(repoPath));
    const { cli } = detectPM(cwd);
    return new Promise<void>((res, rej) => {
      const p = spawnSafe(cli, ['install'], { cwd, env: mergeEnv(), stdio: 'pipe', tag: 'sys', onLog });
      p.on('exit', code => code === 0 ? res() : rej(new Error(`${cli} install failed: ${code}`)));
    });
  }

  startServer(opts: StartOptions) {
    const cwd = symlinkNoSpace(path.resolve(opts.serverRepoPath));
    const { cli, runArgs, yarn } = detectPM(cwd);
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    const script = pkg.scripts?.['start:dev'] ? 'start:dev' : pkg.scripts?.['start'] ? 'start' : null;
    if (!script) throw new Error('서버 레포에 start/start:dev 스크립트가 없습니다.');
    const args = yarn ? [script] : [...runArgs, script];
    this.ps.server = spawnSafe(cli, args, { cwd, env: mergeEnv(opts.env), stdio: 'pipe', tag: 'server', onLog: opts.onLog });
  }

  startFrontend(opts: StartOptions) {
    if (!opts.frontendRepoPath) return;
    const cwd = symlinkNoSpace(path.resolve(opts.frontendRepoPath));
    const { cli, runArgs, yarn } = detectPM(cwd);
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    const script = pkg.scripts?.['dev'] ? 'dev' : pkg.scripts?.['start'] ? 'start' : null;
    if (!script) throw new Error('프론트 레포에 dev/start 스크립트가 없습니다.');
    const args = yarn ? [script] : [...runArgs, script];
    this.ps.frontend = spawnSafe(cli, args, { cwd, env: mergeEnv(opts.env), stdio: 'pipe', tag: 'frontend', onLog: opts.onLog });
  }

  stopAll() {
    (Object.keys(this.ps) as Tag[]).forEach(k => { const p = this.ps[k]; if (p && !p.killed) try { p.kill(); } catch {} });
  }

  async startAll(opts: StartOptions) {
    await this.installDeps(opts.serverRepoPath, opts.onLog);
    if (opts.frontendRepoPath) await this.installDeps(opts.frontendRepoPath, opts.onLog);
    await this.createDatabase(opts);
    await this.runMigrations(opts);
    this.startServer(opts);
    if (opts.frontendRepoPath) this.startFrontend(opts);
  }
}
