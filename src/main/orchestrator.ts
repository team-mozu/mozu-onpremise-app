import { App } from 'electron'
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'
import type { RepoConfig, LaunchStatus } from '../shared/types'

type Proc = { proc: ReturnType<typeof spawn> | null, cwd: string }

export class Orchestrator {
  private app: App
  private workspace: string
  private status: LaunchStatus = { step: 'idle', logs: [] }
  private frontend: Proc | null = null

  constructor(app: App) {
    this.app = app
    if (process.platform === 'win32') {
      this.workspace = 'C:\\mozu-onpremise-workspace'
    } else {
      this.workspace = path.join(this.app.getPath('userData'), 'workspace')
    }
  }

  private envWithDefaultPath(extraEnv: Record<string,string> = {}) {
    const extraPath = process.platform === 'darwin'
      ? ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.yarn', 'bin')]
      : process.platform === 'linux'
      ? ['/usr/local/bin', '/usr/bin', path.join(os.homedir(), '.yarn', 'bin')]
      : process.platform === 'win32'
      ? [
          path.join(os.homedir(), 'AppData', 'Roaming', 'npm'),
          path.join(os.homedir(), '.yarn', 'bin')
        ]
      : []
    const mergedPath = [...extraPath, process.env.PATH || ''].filter(Boolean).join(path.delimiter)
    return { ...process.env, PATH: mergedPath, ...extraEnv }
  }

  private update(partial: Partial<LaunchStatus>, notify?: (s: LaunchStatus) => void) {
    this.status = { ...this.status, ...partial, logs: partial.logs ?? this.status.logs }
    if (notify) notify(this.status)
  }

  private updateClient(step: 'idle' | 'preparing' | 'cloning' | 'installing' | 'building' | 'starting' | 'running' | 'error', message?: string, notify?: (s: LaunchStatus) => void) {
    this.status = {
      ...this.status,
      client: { step, message }
    }
    if (notify) notify(this.status)
  }

  private log(line: string, notify?: (s: LaunchStatus) => void) {
    const logs = this.status.logs ? [...this.status.logs, line] : [line]
    this.update({ logs }, notify)
  }

  private async execChecked(cmd: string, args: string[], opts: any) {
    return new Promise<void>((resolve, reject) => {
      const p = spawn(cmd, args, { stdio: 'ignore', ...opts })
      p.on('error', reject)
      p.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`)))
    })
  }

  private async execStream(
    cmd: string,
    args: string[],
    cwd: string,
    notify?: (s: LaunchStatus) => void,
    shell: boolean = false,
    env: Record<string,string> = {}
  ) {
    return new Promise<void>((resolve, reject) => {
      const p = spawn(cmd, args, { cwd, shell, env: this.envWithDefaultPath(env) })
      this.log(`[exec] ${cmd} ${args.join(' ')} @ ${path.basename(cwd)}`, notify)
      
      p.stdout?.on('data', (d) => {
        this.log(`[out] ${d.toString().trim()}`, notify)
      })
      
      p.stderr?.on('data', (d) => {
        this.log(`[err] ${d.toString().trim()}`, notify)
      })
      
      p.on('error', (e) => {
        this.log(`[error] ${e.message}`, notify)
        reject(e)
      })
      
      p.on('exit', (code) => {
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`Command failed with exit code ${code}`))
        }
      })
    })
  }

  private async ensureTools(notify?: (s: LaunchStatus) => void) {
    // Git 확인
    try {
      await this.execChecked('git', ['--version'], { cwd: os.homedir(), env: this.envWithDefaultPath() })
      this.log('[tools] Git found.', notify)
    } catch {
      throw new Error('Git이 설치되지 않았습니다. https://git-scm.com 에서 다운로드하세요.')
    }

    // npm/yarn 확인
    try {
      await this.execChecked('yarn', ['--version'], { cwd: os.homedir(), shell: true, env: this.envWithDefaultPath() })
      this.log('[tools] Yarn found.', notify)
    } catch {
      try {
        await this.execChecked('npm', ['--version'], { cwd: os.homedir(), shell: true, env: this.envWithDefaultPath() })
        this.log('[tools] npm found.', notify)
      } catch {
        throw new Error('yarn 또는 npm이 설치되지 않았습니다. Node.js를 설치하세요.')
      }
    }
  }

  private async ensureWorkspace(custom?: string) {
    if (custom) this.workspace = custom
    if (!fs.existsSync(this.workspace)) fs.mkdirSync(this.workspace, { recursive: true })
    const frontDir = path.join(this.workspace, 'frontend')
    if (!fs.existsSync(frontDir)) fs.mkdirSync(frontDir, { recursive: true })
    return { frontDir }
  }

  private async cloneOrPull(targetDir: string, url: string, branch?: string, notify?: (s: LaunchStatus) => void) {
    const hasGit = fs.existsSync(path.join(targetDir, '.git'))
    
    if (hasGit) {
      this.log(`[git] Pull ${url}`, notify)
      await this.execStream('git', ['pull', 'origin', branch || 'main'], targetDir, notify)
    } else {
      this.log(`[git] Clone ${url}`, notify)
      if (branch) {
        await this.execStream('git', ['clone', '--branch', branch, url, '.'], targetDir, notify)
      } else {
        await this.execStream('git', ['clone', url, '.'], targetDir, notify)
      }
    }
  }

  private async installDeps(targetDir: string, command: string, notify?: (s: LaunchStatus) => void) {
    // yarn dev -> yarn, dev 형태로 분리
    const [cmd, ...args] = command.split(' ')
    
    // 설치 명령어 확인
    if (cmd === 'yarn') {
      // yarn install인 경우
      if (args.length === 0 || (args.length === 1 && args[0] === 'install')) {
        await this.execStream('yarn', ['install'], targetDir, notify, true)
        return
      }
      // yarn으로 다른 명령어인 경우 그대로 실행
      await this.execStream(cmd, args, targetDir, notify, true)
    } else if (cmd === 'npm') {
      // npm install인 경우
      if (args.length === 0 || (args.length === 1 && args[0] === 'install')) {
        await this.execStream('npm', ['install'], targetDir, notify, true)
        return
      }
      // npm으로 다른 명령어인 경우 그대로 실행
      await this.execStream(cmd, args, targetDir, notify, true)
    }
  }

  private async resolveStartCommand(targetDir: string, requested?: string): Promise<{ cmd: string; args: string[]; label: string }> {
    if (requested) {
      const [cmd, ...args] = requested.split(' ')
      return { cmd, args, label: requested }
    }

    // package.json에서 scripts 확인
    const pkgPath = path.join(targetDir, 'package.json')
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
      const scripts = pkg.scripts || {}
      
      // 일반적인 개발 서버 스크립트 찾기
      const devScripts = ['dev', 'start', 'serve']
      for (const script of devScripts) {
        if (scripts[script]) {
          return { cmd: 'yarn', args: [script], label: `yarn ${script}` }
        }
      }
    }

    // 기본값
    return { cmd: 'yarn', args: ['dev'], label: 'yarn dev (default)' }
  }

  async start(config: RepoConfig, notify?: (s: LaunchStatus) => void) {
    try {
      this.update({ step: 'checking-tools', message: '환경 확인 중...' }, notify)
      await this.ensureTools(notify)

      this.update({ step: 'preparing', message: '준비 중...' }, notify)
      const { frontDir } = await this.ensureWorkspace(config.workspaceDir)

      this.update({ step: 'cloning', message: '프론트엔드 다운로드 중...' }, notify)
      await this.cloneOrPull(frontDir, config.frontend.url, config.frontend.branch, notify)

      this.update({ step: 'installing', message: '의존성 설치 중...' }, notify)
      this.log('[deps] Cleaning up frontend node_modules...', notify);
      fs.rmSync(path.join(frontDir, 'node_modules'), { recursive: true, force: true });
      await this.installDeps(frontDir, config.frontend.installCommand || 'yarn install', notify)

      this.update({ step: 'starting', message: '프론트엔드 시작 중...' }, notify)
      
      // 프론트엔드 시작
      this.updateClient('starting', '클라이언트를 시작하고 있습니다...', notify)
      const fe = await this.resolveStartCommand(frontDir, config.frontend.startCommand)
      this.log(`[start] frontend via ${fe.label}`, notify)
      this.frontend = {
        proc: spawn(fe.cmd, fe.args, { cwd: frontDir, shell: process.platform === 'win32', env: this.envWithDefaultPath() }),
        cwd: frontDir
      }
      this.frontend.proc?.stdout?.on('data', (d) => this.log(`[frontend] ${d.toString().trim()}`, notify))
      this.frontend.proc?.stderr?.on('data', (d) => this.log(`[frontend:err] ${d.toString().trim()}`, notify))
      this.frontend.proc?.on('exit', (code, signal) => {
        this.log(`[frontend] exited (code=${code}, signal=${signal})`, notify)
        if (code !== 0) {
          this.updateClient('error', '클라이언트가 예상치 못하게 종료되었습니다', notify)
        } else {
          this.updateClient('idle', '클라이언트 종료됨', notify)
        }
      })

      // 프론트엔드만 실행 상태로 업데이트
      this.updateClient('running', '클라이언트 실행 중', notify)
      
      this.update({
        step: 'running',
        message: 'Frontend Running',
        serverPid: null,
        frontendPid: this.frontend?.proc?.pid ?? null
      }, notify)

      return { ok: true }
    } catch (err: any) {
      this.update({ step: 'error', message: err?.message || String(err) }, notify)
      return { ok: false, error: err?.message || String(err) }
    }
  }

  async startLesson(config: RepoConfig, notify?: (s: LaunchStatus) => void) {
    // startLesson은 start와 동일하게 동작
    return this.start(config, notify)
  }

  async stop() {
    const kill = async (p: Proc | null) => {
      if (!p?.proc) return
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/PID', String(p.proc.pid), '/T', '/F'])
        } else {
          p.proc.kill('SIGINT')
        }
      } catch {}
    }
    await kill(this.frontend)
    this.frontend = null
    this.status = { step: 'idle', logs: [] }
  }

  dispose() {
    this.stop()
  }
}