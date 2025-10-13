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
  const isWin = process.platform === 'win32';
  if (fs.existsSync(path.join(repoPath, 'pnpm-lock.yaml'))) return { cli: isWin ? 'pnpm.cmd' : 'pnpm', runArgs: ['run'], yarn: false };
  if (fs.existsSync(path.join(repoPath, 'yarn.lock'))) {
    return { cli: isWin ? 'npx.cmd' : 'npx', runArgs: ['yarn'], yarn: true };
  }
  if (fs.existsSync(path.join(repoPath, 'bun.lockb')))      return { cli: 'bun',  runArgs: ['run'], yarn: false };
  return { cli: isWin ? 'npm.cmd' : 'npm', runArgs: ['run'], yarn: false };
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

// Helper function to execute a command and log its output
function executeCommand(
  command: string,
  args: string[],
  options: SpawnOptions & { tag: Tag; onLog?: StartOptions['onLog'] }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawnSafe(command, args, options);
    p.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command "${command} ${args.join(' ')}" failed with exit code ${code}`));
      }
    });
    p.on('error', (err) => {
      reject(err);
    });
  });
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
    const { cli, runArgs, yarn } = detectPM(cwd);
    const args = yarn ? [...runArgs, 'install'] : ['install'];
    return new Promise<void>((res, rej) => {
      const p = spawnSafe(cli, args, { cwd, env: mergeEnv(), stdio: 'pipe', tag: 'sys', onLog });
      p.on('exit', code => code === 0 ? res() : rej(new Error(`${cli} install failed: ${code}`)));
    });
  }

  async startServer(opts: StartOptions) {
    const { onLog, serverRepoPath } = opts;

    // 1. Windows-only logic
    if (process.platform !== 'win32') {
      onLog?.('server', 'Skipping Spring Boot server start on non-Windows platform.');
      return;
    }

    if (!serverRepoPath) {
      throw new Error('serverRepoPath is not provided for Spring Boot server.');
    }
    const springProjectPath = path.resolve(serverRepoPath);

    try {
      // 2. Check for Java, install if necessary via Chocolatey
      onLog?.('server', 'Checking for Java...');
      try {
        await executeCommand('java', ['-version'], { tag: 'sys', onLog, stdio: 'pipe' });
        onLog?.('server', 'Java is already installed.');
      } catch {
        onLog?.('server', 'Java not found. Checking for Chocolatey...');
        try {
          await executeCommand('choco', ['--version'], { tag: 'sys', onLog, stdio: 'pipe' });
          onLog?.('server', 'Chocolatey found. Installing OpenJDK 17...');
          await executeCommand('choco', ['install', 'openjdk17', '-y'], { tag: 'sys', onLog, stdio: 'pipe' });
          onLog?.('server', 'OpenJDK 17 installation complete. Please restart the application to use the new Java environment.');
          // We throw an error to stop the process, as a restart is required for the new PATH to be effective.
          throw new Error('Java has been installed. Please restart the application.');
        } catch {
          throw new Error('Java is not installed and Chocolatey is not found. Please install Java 17 or Chocolatey first.');
        }
      }

      // 3. Verify it's a Gradle project
      onLog?.('server', `Using Spring project path: ${springProjectPath}`);
      const gradlewPath = path.join(springProjectPath, 'gradlew.bat');
      try {
        await fs.promises.access(gradlewPath);
      } catch {
        throw new Error(`"gradlew.bat" not found in the provided serverRepoPath: ${springProjectPath}`);
      }

      // 4. Create .env file for Spring project
      onLog?.('server', 'Creating .env file for Spring project...');
      try {
        const rootEnvPath = path.resolve(process.cwd(), '.env');
        const rootEnvContent = await fs.promises.readFile(rootEnvPath, 'utf-8');
        const lines = rootEnvContent.split('\n');
        const separator = '# 프론트 공통 변수';
        const separatorIndex = lines.findIndex(line => line.trim() === separator);
        
        const springEnvContent = separatorIndex !== -1 
          ? lines.slice(0, separatorIndex).join('\n')
          : rootEnvContent; // Fallback to full content if separator not found

        const springEnvPath = path.join(springProjectPath, '.env');
        await fs.promises.writeFile(springEnvPath, springEnvContent);
        onLog?.('server', `Successfully created .env file at ${springEnvPath}`);
      } catch (error: any) {
        throw new Error(`Failed to create .env file for Spring project: ${error.message}`);
      }

      // 5. Build the project with Gradle
      onLog?.('server', 'Building Spring Boot project with Gradle...');
      await executeCommand(gradlewPath, ['clean', 'build'], { cwd: springProjectPath, tag: 'server', onLog, stdio: 'pipe' });
      onLog?.('server', 'Gradle build finished.');

      // 6. Find the built JAR file
      const libsDir = path.join(springProjectPath, 'build', 'libs');
      const jarFiles = (await fs.promises.readdir(libsDir)).filter(f => f.endsWith('.jar') && !f.endsWith('-plain.jar'));
      if (jarFiles.length === 0) {
        throw new Error('No executable JAR file found in build/libs directory.');
      }
      const jarFile = jarFiles[0];
      const jarPath = path.join(libsDir, jarFile);
      onLog?.('server', `Found JAR file: ${jarFile}`);

      // 7. Run the Spring Boot application
      onLog?.('server', 'Starting Spring Boot application...');
      this.ps.server = spawnSafe('java', ['-jar', jarPath], { cwd: springProjectPath, env: mergeEnv(opts.env), stdio: 'pipe', tag: 'server', onLog });

    } catch (error: any) {
      onLog?.('server', `[ERROR] ${error.message}`);
      throw error;
    }
  }

  startFrontend(opts: StartOptions) {
    if (!opts.frontendRepoPath) return;
    const cwd = symlinkNoSpace(path.resolve(opts.frontendRepoPath));
    const { cli, runArgs } = detectPM(cwd);
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    const script = pkg.scripts?.['dev'] ? 'dev' : pkg.scripts?.['start'] ? 'start' : null;
    if (!script) throw new Error('프론트 레포에 dev/start 스크립트가 없습니다.');
    const args = [...runArgs, script];
    this.ps.frontend = spawnSafe(cli, args, { cwd, env: mergeEnv(opts.env), stdio: 'pipe', tag: 'frontend', onLog: opts.onLog });
  }

  stopAll() {
    (Object.keys(this.ps) as Tag[]).forEach(k => { const p = this.ps[k]; if (p && !p.killed) try { p.kill(); } catch {} });
  }

  async startAll(opts: StartOptions) {
    // No longer need to install dependencies for the Node.js server
    // await this.installDeps(opts.serverRepoPath, opts.onLog);
    if (opts.frontendRepoPath) await this.installDeps(opts.frontendRepoPath, opts.onLog);
    
    await this.createDatabase(opts);
    
    // Migrations were for the Node.js TypeORM setup. The Spring project will handle its own migrations.
    // await this.runMigrations(opts);
    
    await this.startServer(opts);
    if (opts.frontendRepoPath) this.startFrontend(opts);
  }
}
