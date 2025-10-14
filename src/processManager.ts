import { spawn, SpawnOptions } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

type P = ReturnType<typeof spawn>;
type Tag = 'frontend' | 'sys';

export interface StartOptions {
  frontendRepoPath: string;
  env?: Record<string, string>;
  onLog?: (tag: Tag, line: string) => void;
}

function spawnSafe(cmd: string, args: string[], opts: SpawnOptions & { tag: Tag; onLog?: StartOptions['onLog'] }): P {
  const p = spawn(cmd, args, { ...opts, shell: false });
  p.stdout?.on('data', d => opts.onLog?.(opts.tag, d.toString()));
  p.stderr?.on('data', d => opts.onLog?.(opts.tag, d.toString()));
  p.on('exit', (c, s) => opts.onLog?.(opts.tag, `[exit] code=${c} signal=${s}\n`));
  return p;
}

function detectPM(repoPath: string) {
  const isWin = process.platform === 'win32';
  if (fs.existsSync(path.join(repoPath, 'pnpm-lock.yaml'))) return { cli: isWin ? 'pnpm.cmd' : 'pnpm', runArgs: ['run'], yarn: false };
  if (fs.existsSync(path.join(repoPath, 'yarn.lock'))) {
    return { cli: isWin ? 'yarn.cmd' : 'yarn', runArgs: [], yarn: true };
  }
  if (fs.existsSync(path.join(repoPath, 'bun.lockb'))) return { cli: 'bun', runArgs: ['run'], yarn: false };
  return { cli: isWin ? 'npm.cmd' : 'npm', runArgs: ['run'], yarn: false };
}

function mergeEnv(extra?: Record<string,string>): NodeJS.ProcessEnv {
  return { ...process.env, ...(extra||{}) };
}

export class ProcessManager {
  private ps: Partial<Record<Tag, P>> = {};

  installDeps(repoPath: string, onLog?: StartOptions['onLog']) {
    const cwd = path.resolve(repoPath);
    const { cli, runArgs, yarn } = detectPM(cwd);
    const args = yarn ? [...runArgs, 'install'] : ['install'];
    return new Promise<void>((res, rej) => {
      const p = spawnSafe(cli, args, { cwd, env: mergeEnv(), stdio: 'pipe', tag: 'sys', onLog });
      p.on('exit', code => code === 0 ? res() : rej(new Error(`${cli} install failed: ${code}`)));
    });
  }

  startFrontend(opts: StartOptions) {
    const cwd = path.resolve(opts.frontendRepoPath);
    const { cli, runArgs } = detectPM(cwd);
    
    // package.json에서 적절한 스크립트 찾기
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    const scripts = pkg.scripts || {};
    
    // 일반적인 개발 스크립트 순서로 찾기
    const devScripts = ['dev', 'start', 'serve'];
    let script: string | null = null;
    
    for (const s of devScripts) {
      if (scripts[s]) {
        script = s;
        break;
      }
    }
    
    if (!script) {
      throw new Error('프론트엔드에 dev/start/serve 스크립트가 없습니다.');
    }
    
    const args = runArgs.length > 0 ? [...runArgs, script] : [script];
    this.ps.frontend = spawnSafe(cli, args, { 
      cwd, 
      env: mergeEnv(opts.env), 
      stdio: 'pipe', 
      tag: 'frontend', 
      onLog: opts.onLog 
    });
  }

  stopAll() {
    (Object.keys(this.ps) as Tag[]).forEach(k => { 
      const p = this.ps[k]; 
      if (p && !p.killed) {
        try { 
          if (process.platform === 'win32') {
            spawn('taskkill', ['/PID', String(p.pid), '/T', '/F']);
          } else {
            p.kill('SIGINT');
          }
        } catch {}
      }
    });
  }

  async startAll(opts: StartOptions) {
    // 프론트엔드 의존성 설치
    await this.installDeps(opts.frontendRepoPath, opts.onLog);
    
    // 프론트엔드 시작
    this.startFrontend(opts);
  }
}