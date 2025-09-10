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
  private server: Proc | null = null
  private frontend: Proc | null = null

  constructor(app: App) {
    this.app = app
    this.workspace = path.join(this.app.getPath('userData'), 'workspace')
  }

  // ---------- utils ----------
  private envWithDefaultPath(extraEnv: Record<string,string> = {}) {
    const extraPath = process.platform === 'darwin'
      ? ['/opt/homebrew/bin', '/usr/local/bin']
      : process.platform === 'linux'
      ? ['/usr/local/bin', '/usr/bin']
      : process.platform === 'win32'
      ? [process.env['ProgramFiles'] ? path.join(process.env['ProgramFiles'], 'MySQL', 'MySQL Server 8.0', 'bin') : '']
      : []
    const mergedPath = [...extraPath, process.env.PATH || ''].filter(Boolean).join(path.delimiter)
    return { ...process.env, PATH: mergedPath, ...extraEnv }
  }

  private update(partial: Partial<LaunchStatus>, notify?: (s: LaunchStatus) => void) {
    this.status = { ...this.status, ...partial, logs: partial.logs ?? this.status.logs }
    if (notify) notify(this.status)
  }

  private npmCmd(): string {
    return process.platform === 'win32' ? 'npm.cmd' : 'npm'
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
      p.stdout?.on('data', (d) => this.log(d.toString().trim(), notify))
      p.stderr?.on('data', (d) => this.log(d.toString().trim(), notify))
      p.on('error', reject)
      p.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`)))
    })
  }

  private readJsonIfExists(p: string): any | null {
    if (!fs.existsSync(p)) return null
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')) } catch { return null }
  }

  // ---------- preflight ----------
  private async ensureTools(notify?: (s: LaunchStatus) => void) {
    try {
      await this.execChecked('git', ['--version'], { cwd: os.homedir(), env: this.envWithDefaultPath() })
    } catch (err) {
      throw new Error('git이 설치되지 않았거나 PATH에 없습니다. git을 설치하고 다시 시도하세요.')
    }
    try {
      await this.execChecked(this.npmCmd(), ['--version'], { cwd: os.homedir(), shell: true, env: this.envWithDefaultPath() })
    } catch (err) {
      throw new Error('npm이 설치되지 않았거나 PATH에 없습니다. Node.js와 npm을 설치하고 다시 시도하세요.')
    }
    try {
      await this.execChecked('yarn', ['--version'], { cwd: os.homedir(), shell: true, env: this.envWithDefaultPath() });
    } catch (err) {
      this.log('[tools] yarn not found. Attempting to install globally via npm...', notify);
      try {
        await this.execStream(this.npmCmd(), ['install', '-g', 'yarn'], os.homedir(), notify, true);
        this.log('[tools] yarn has been installed globally.', notify);
      } catch (installErr) {
        this.log('[tools] Failed to install yarn globally.', notify);
        throw new Error('yarn을 찾을 수 없으며, npm을 통해 전역으로 설치하는 데에도 실패했습니다. 수동으로 yarn을 설치하고 다시 시도하세요.');
      }
    }
  }

  private async ensureWorkspace(custom?: string) {
    if (custom) this.workspace = custom
    if (!fs.existsSync(this.workspace)) fs.mkdirSync(this.workspace, { recursive: true })
    const serverDir = path.join(this.workspace, 'server')
    const frontDir = path.join(this.workspace, 'frontend')
    if (!fs.existsSync(serverDir)) fs.mkdirSync(serverDir, { recursive: true })
    if (!fs.existsSync(frontDir)) fs.mkdirSync(frontDir, { recursive: true })
    return { serverDir, frontDir }
  }

  // ---------- git ----------
  private async cloneOrPull(targetDir: string, url: string, branch?: string, notify?: (s: LaunchStatus) => void) {
    const hasGit = fs.existsSync(path.join(targetDir, '.git'))
    if (hasGit) {
      this.log(`[git] pull in ${path.basename(targetDir)}...`, notify)
      await this.execStream('git', ['pull'], targetDir, notify)
    } else {
      this.log(`[git] clone ${url} -> ${path.basename(targetDir)}...`, notify)
      const args = ['clone', url, '.']
      if (branch) args.splice(1, 0, '-b', branch)
      await this.execStream('git', args, targetDir, notify)
    }
  }

  // ---------- env util ----------
  private parseDotEnv(text: string): Record<string,string> {
    const out: Record<string,string> = {}
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq === -1) continue
      const key = line.slice(0, eq).trim()
      let val = line.slice(eq + 1).trim()
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      out[key] = val
    }
    return out
  }
  private stringifyDotEnv(obj: Record<string,string>): string {
    return Object.entries(obj).map(([k,v]) => `${k}=${/[\s#'"`]/.test(v) ? JSON.stringify(v) : v}`).join('\n') + '\n'
  }
  private loadServerEnv(serverDir: string): Record<string,string> {
    // 우선순위: launcher.env.json(workspace) > .env.local > .env.development > .env
    const env: Record<string,string> = {}
    const candidates = [
      path.join(this.workspace, 'launcher.env.json'),
      path.join(serverDir, '.env.local'),
      path.join(serverDir, '.env.development'),
      path.join(serverDir, '.env'),
    ]
    for (const fp of candidates) {
      if (fp.endsWith('.json')) {
        const j = this.readJsonIfExists(fp)
        if (j && typeof j === 'object') {
          for (const [k, v] of Object.entries(j)) env[String(k)] = String(v as any)
        }
      } else if (fs.existsSync(fp)) {
        Object.assign(env, this.parseDotEnv(fs.readFileSync(fp, 'utf-8')))
      }
    }
    return env
  }
  private mergeWriteEnv(serverDir: string, patch: Record<string,string>, notify?: (s: LaunchStatus)=>void) {
    const envPath = path.join(serverDir, '.env')
    const base = fs.existsSync(envPath) ? this.parseDotEnv(fs.readFileSync(envPath,'utf-8')) : {}
    const merged = { ...base, ...patch }
    fs.writeFileSync(envPath, this.stringifyDotEnv(merged), 'utf-8')
    this.log(`[env] wrote ${path.relative(serverDir, envPath)}`, notify)
  }

  // ---------- package manager detection ----------
  private detectPM(targetDir: string): { pm: 'npm'|'yarn'|'pnpm', addCmd: (dev?: boolean)=>[string,string[]] } {
    const hasYarn = fs.existsSync(path.join(targetDir, 'yarn.lock'))
    const hasPnpm = fs.existsSync(path.join(targetDir, 'pnpm-lock.yaml'))
    if (hasYarn) return { pm: 'yarn', addCmd: (dev=false)=>['yarn', dev?['add','-D']:['add']] }
    if (hasPnpm) return { pm: 'pnpm', addCmd: (dev=false)=>['pnpm', dev?['add','-D']:['add']] }
    return { pm: 'npm', addCmd: (dev=false)=>[this.npmCmd(), dev?['install','-D']:['install','--save']] }
  }

  // ---------- deps ----------
  private async installDeps(targetDir: string, installCommand?: string, notify?: (s: LaunchStatus) => void) {
    let cmd = installCommand
    if (cmd?.trim().startsWith('yarn')) {
      cmd = 'npx yarn install';
    }
    if (!cmd) {
      const hasYarn = fs.existsSync(path.join(targetDir, 'yarn.lock'))
      const hasPnpm = fs.existsSync(path.join(targetDir, 'pnpm-lock.yaml'))
      const hasNpmLock = fs.existsSync(path.join(targetDir, 'package-lock.json'))
      if (hasYarn) cmd = 'npx yarn install'
      else if (hasPnpm) cmd = 'pnpm install'
      else if (hasNpmLock) cmd = 'npm ci'
      else cmd = 'npm install'
    }
    const [c, ...args] = cmd.split(' ')
    this.log(`[deps] ${cmd} @ ${path.basename(targetDir)}`, notify)
    await this.execStream(c, args, targetDir, notify, true)
  }

  // 추가 의존성: Nest/TypeORM/mysql2, Nest CLI
  private async ensureServerExtras(serverDir: string, notify?: (s: LaunchStatus) => void) {
    const pkg = this.readJsonIfExists(path.join(serverDir, 'package.json')) || { dependencies:{}, devDependencies:{} }
    const deps = pkg.dependencies || {}
    const devDeps = pkg.devDependencies || {}
    const needRuntime = ['@nestjs/typeorm','typeorm','mysql2'].filter(lib => !deps[lib] && !devDeps[lib])
    const needDev = ['@nestjs/cli'].filter(lib => !deps[lib] && !devDeps[lib])
    const pm = this.detectPM(serverDir)
    if (needRuntime.length) {
      const [bin, base] = pm.addCmd(false)
      this.log(`[deps-extra] ${needRuntime.join(' ')} @ server`, notify)
      await this.execStream(bin, [...base, ...needRuntime], serverDir, notify, true)
    } else {
      this.log('[deps-extra] runtime OK (@nestjs/typeorm, typeorm, mysql2)', notify)
    }
    if (needDev.length) {
      const [bin, base] = pm.addCmd(true)
      this.log(`[deps-extra] -D ${needDev.join(' ')} @ server`, notify)
      await this.execStream(bin, [...base, ...needDev], serverDir, notify, true)
    } else {
      this.log('[deps-extra] dev OK (@nestjs/cli)', notify)
    }
  }

  // ---------- Windows: MySQL 설치 / 서비스 시작 ----------
  private async ensureMySQLOnWindows(notify?: (s: LaunchStatus)=>void) {
    if (process.platform !== 'win32') return

    const execElevated = async (cmd: string, args: string[]) => {
      const argString = args.map(arg => `'${arg.replace(/'/g, "''")}'`).join(',');
      // -PassThru는 프로세스 객체를 반환합니다. 이 객체의 ExitCode를 받아와서 스크립트의 종료 코드로 사용합니다.
      // 이를 통해 관리자 권한으로 실행된 프로세스의 실패 여부를 정확히 알 수 있습니다.
      const psCommand = `$p = Start-Process -Verb RunAs -Wait -PassThru -FilePath "${cmd}" -ArgumentList @(${argString}); exit $p.ExitCode`;
      
      await this.execStream('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCommand], process.cwd(), notify, true);
    }

    // mysql 클라이언트 존재 확인
    let hasMysql = false
    try { await this.execChecked('where', ['mysql'], { env: this.envWithDefaultPath() }); hasMysql = true } catch {}
    if (hasMysql) {
      this.log('[mysql] MySQL is already installed.', notify)
    } else {
      this.log('[mysql] not found. trying to install via winget with elevation...', notify)
      // winget
      let wingetOk = false
      try { await this.execChecked('winget', ['--version'], { env: this.envWithDefaultPath() }); wingetOk = true } catch {}
      if (wingetOk) {
        const candidates = [
          ['Oracle.MySQL', []],
          ['Oracle.MySQLServer', []],
        ] as const
        for (const [id, extra] of candidates) {
          try {
            this.log(`[mysql] Attempting to install ${id} via winget...`, notify);
            await execElevated('winget', ['install', '-e', '--id', id, '--silent', '--accept-package-agreements', ...extra]);
            // 설치 후 다시 확인
            try { await this.execChecked('where', ['mysql'], { env: this.envWithDefaultPath() }); hasMysql = true } catch {}
            if (hasMysql) {
              this.log(`[mysql] Successfully installed ${id} via winget.`, notify);
              break;
            }
          } catch (e: any) {
            this.log(`[mysql] winget install for ${id} failed. Error: ${e?.message || e}`, notify);
          }
        }
      }
      // choco fallback
      if (!hasMysql) {
        this.log('[mysql] winget failed. Trying Chocolatey with elevation...', notify)
        let chocoOk = false
        try { await this.execChecked('choco', ['--version'], { env: this.envWithDefaultPath() }); chocoOk = true } catch {}
        if (chocoOk) {
          try {
            // choco로 mysql 설치 시 root 비밀번호를 빈 문자열로 설정 ('/Password:""')
            await execElevated('choco', ['install', 'mysql', '-y', '--params', `"/Password:''"`]);
            try { await this.execChecked('where', ['mysql'], { env: this.envWithDefaultPath() }); hasMysql = true } catch {}
            if (hasMysql) this.log(`[mysql] Successfully installed via choco.`, notify);
          } catch (e: any) {
            this.log(`[mysql] choco install failed. Error: ${e?.message || e}`, notify);
          }
        }
      }
      if (!hasMysql) {
        this.log('[mysql] 자동 설치 실패. 수동 설치가 필요할 수 있습니다. (MySQL Server 8.x)', notify)
      }
    }

    // 서비스 시작 시도 (관리자 권한으로)
    if (hasMysql) {
      try {
        this.log('[mysql] Attempting to start MySQL service with elevation...', notify);
        const startSvc = `Get-Service -Name 'MySQL*' | Where-Object { $_.Status -ne 'Running' } | Start-Service -PassThru`;
        await execElevated('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', startSvc]);
        this.log('[mysql] service start command issued (if installed and not running).', notify)
      } catch (e: any) {
        this.log(`[mysql] 서비스 시작 실패. 이미 실행 중이거나, 설치에 문제가 있을 수 있습니다. Error: ${e?.message || e}`, notify)
      }
    }
  }

  // ---------- DB 준비 (MySQL) ----------
  private async createDatabaseIfNeeded(db: {host:string;port:number;user:string;password:string;database:string}, notify?: (s: LaunchStatus)=>void) {
    const args = ['-h', db.host, '-P', String(db.port), '-u', db.user]
    if (db.password) args.push(`-p${db.password}`)
    const sql = `CREATE DATABASE IF NOT EXISTS \`${db.database}\` DEFAULT CHARACTER SET utf8mb4;`
    try {
      await this.execStream('mysql', [...args, '-e', sql], process.cwd(), notify, false)
      this.log(`[mysql] ensured database "${db.database}"`, notify)
    } catch (e:any) {
      if (e?.message?.includes('ENOENT')) {
        throw new Error('`mysql` 명령어를 찾을 수 없습니다. MySQL을 설치하고, 설치 경로의 `bin` 폴더를 시스템 환경 변수 PATH에 추가했는지 확인하세요.')
      }
      this.log(`[mysql] DB 생성 실패: ${e?.message || e}`, notify)
      // 계속 진행은 하지만 서버가 접속 실패할 수 있음
    }
  }

  // ---------- start commands ----------
  private localBin(cwd: string, binName: string) {
    const name = process.platform === 'win32' ? `${binName}.cmd` : binName
    const p = path.join(cwd, 'node_modules', '.bin', name)
    return fs.existsSync(p) ? p : null
  }

  private async resolveStartCommand(targetDir: string, requested?: string): Promise<{ cmd: string; args: string[]; label: string }> {
    // 사용자가 nest start를 원한다면: 로컬 nest → npx nest
    if (requested && /^nest(\.cmd)?\s+start(\b|$)/.test(requested)) {
      const localNest = this.localBin(targetDir, 'nest')
      if (localNest) return { cmd: localNest, args: ['start', '--watch'], label: 'local nest' }
      return { cmd: 'npx', args: ['nest', 'start', '--watch'], label: 'npx nest' }
    }
    // package.json scripts
    const pkg = this.readJsonIfExists(path.join(targetDir, 'package.json'))
    if (pkg) {
      if (requested && requested.trim()) {
        const [c, ...args] = requested.split(' ')
        return { cmd: c, args, label: 'requested' }
      }
      if (pkg.scripts?.['start:dev']) return { cmd: this.npmCmd(), args: ['run', 'start:dev'], label: 'npm run start:dev' }
      if (pkg.scripts?.['start']) return { cmd: this.npmCmd(), args: ['run', 'start'], label: 'npm run start' }
    }
    // fallback: 로컬 nest → npx nest
    const localNest = this.localBin(targetDir, 'nest')
    if (localNest) return { cmd: localNest, args: ['start', '--watch'], label: 'local nest (fallback)' }
    return { cmd: 'npx', args: ['nest', 'start', '--watch'], label: 'npx nest (fallback)' }
  }

  // ---------- main flow ----------
  async start(config: RepoConfig, notify?: (s: LaunchStatus) => void) {
    try {
      this.update({ step: 'checking-tools', message: 'Checking git and npm...' }, notify)
      await this.ensureTools()

      this.update({ step: 'preparing', message: 'Preparing workspace...' }, notify)
      const { serverDir, frontDir } = await this.ensureWorkspace(config.workspaceDir)

      this.update({ step: 'cloning', message: 'Syncing repositories...' }, notify)
      await this.cloneOrPull(serverDir, config.server.url, config.server.branch, notify)
      await this.cloneOrPull(frontDir, config.frontend.url, config.frontend.branch, notify)

      this.update({ step: 'installing', message: 'Installing dependencies...' }, notify)
      await this.installDeps(serverDir, config.server.installCommand, notify)
      await this.installDeps(frontDir, config.frontend.installCommand, notify)

      // 서버 런타임/CLI 보강
      await this.ensureServerExtras(serverDir, notify)

      // Windows: MySQL 설치/서비스
      await this.ensureMySQLOnWindows(notify)

      // 환경 변수 수집
      const envFromFiles = this.loadServerEnv(serverDir)
      const dbHost = envFromFiles.DB_HOST || envFromFiles.MYSQL_HOST || '127.0.0.1'
      const dbPort = Number(envFromFiles.DB_PORT || envFromFiles.MYSQL_PORT || 3306)
      const dbUser = envFromFiles.DB_USERNAME || envFromFiles.MYSQL_USER || 'root'
      // UI에서 받은 비밀번호를 최우선으로 사용하고, 그 다음 .env 파일, 마지막으로 빈 문자열을 사용
      const dbPass = config.server.dbPassword || envFromFiles.DB_PASSWORD || envFromFiles.DB_ROOT_PASSWORD || envFromFiles.MYSQL_ROOT_PASSWORD || ''
      const dbName = envFromFiles.DB_DATABASE || envFromFiles.MYSQL_DATABASE || 'mozu'

      // DB 생성 시도
      await this.createDatabaseIfNeeded({ host: dbHost, port: dbPort, user: dbUser, password: dbPass, database: dbName }, notify)

      // .env 병합/기록 (TypeORM에서 자주 쓰는 키 + DATABASE_URL)
      const databaseUrl = `mysql://${encodeURIComponent(dbUser)}:${encodeURIComponent(dbPass)}@${dbHost}:${dbPort}/${dbName}`
      this.mergeWriteEnv(serverDir, {
        DB_HOST: dbHost,
        DB_PORT: String(dbPort),
        DB_NAME: dbUser,
        DB_PASSWORD: dbPass,
        DB_DATABASE: dbName,
      }, notify)

      this.update({ step: 'starting', message: 'Starting processes...' }, notify)

      // 서버 시작
      const srv = await this.resolveStartCommand(serverDir, config.server.startCommand)
      this.log(`[start] server via ${srv.label}`, notify)
      this.server = {
        proc: spawn(srv.cmd, srv.args, { cwd: serverDir, shell: false, env: this.envWithDefaultPath(envFromFiles) }),
        cwd: serverDir
      }
      this.server.proc?.stdout?.on('data', (d) => this.log(`[server] ${d.toString().trim()}`, notify))
      this.server.proc?.stderr?.on('data', (d) => this.log(`[server:err] ${d.toString().trim()}`, notify))
      this.server.proc?.on('exit', (code, signal) => this.log(`[server] exited (code=${code}, signal=${signal})`, notify))

      // 프론트 시작
      const fe = await this.resolveStartCommand(frontDir, config.frontend.startCommand)
      this.log(`[start] frontend via ${fe.label}`, notify)
      this.frontend = {
        proc: spawn(fe.cmd, fe.args, { cwd: frontDir, shell: false, env: this.envWithDefaultPath() }),
        cwd: frontDir
      }
      this.frontend.proc?.stdout?.on('data', (d) => this.log(`[frontend] ${d.toString().trim()}`, notify))
      this.frontend.proc?.stderr?.on('data', (d) => this.log(`[frontend:err] ${d.toString().trim()}`, notify))
      this.frontend.proc?.on('exit', (code, signal) => this.log(`[frontend] exited (code=${code}, signal=${signal})`, notify))

      this.update({
        step: 'running',
        message: 'Running',
        serverPid: this.server.proc?.pid ?? null,
        frontendPid: this.frontend.proc?.pid ?? null
      }, notify)

      return { ok: true }
    } catch (err: any) {
      this.update({ step: 'error', message: err?.message || String(err) }, notify)
      return { ok: false, error: err?.message || String(err) }
    }
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
    await kill(this.server)
    await kill(this.frontend)
    this.server = null
    this.frontend = null
    this.status = { step: 'idle', logs: [] }
  }

  dispose() {
    this.stop()
  }
}
