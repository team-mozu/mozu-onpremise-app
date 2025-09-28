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
    if (process.platform === 'win32') {
      this.workspace = 'C:\\mozu-onpremise-workspace'
    } else {
      this.workspace = path.join(this.app.getPath('userData'), 'workspace')
    }
  }

  private toSpringEnv(env: Record<string, string>): Record<string, string> {
    const springEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        const newKey = key.toUpperCase().replace(/[.-]/g, '_');
        springEnv[newKey] = value;
    }
    return springEnv;
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
      // Java(JDK) 설치 여부 확인
      await this.execChecked('java', ['-version'], { cwd: os.homedir(), env: this.envWithDefaultPath() })
    } catch (err) {
      throw new Error('Java(JDK)가 설치되지 않았거나 PATH에 없습니다. Java를 설치하고 다시 시도하세요.')
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
    for (const raw of text.split(/\\r?\\n/)) {
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
    return Object.entries(obj).map(([k,v]) => `${k}=${/[\\s#'"`]/.test(v) ? JSON.stringify(v) : v}`).join('\\n') + '\\n'
  }
  private loadServerEnv(serverDir: string): Record<string,string> {
    // 우선순위: launcher.env.json(workspace) > .env.local > .env.development > .env
    const env: Record<string,string> = {}
    const candidates = [
      path.join(serverDir, 'src', 'main', 'resources', 'application.properties'),
      path.join(serverDir, '.env'),
      path.join(this.workspace, 'launcher.env.json'),
      path.join(this.app.getAppPath(), '.env'),
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

  private async createFrontendEnvFiles(frontDir: string, notify?: (s: LaunchStatus) => void) {
    this.log('[env] Creating .env files for frontend from root .env...', notify)

    const getVar = (key: string, defaultValue: string = ''): string => {
      return process.env[key] || defaultValue
    }

    const envFileContents: Record<string, string> = {
      'packages/admin/.env': [
        `VITE_SERVER_URL=${getVar('VITE_SERVER_URL', 'https://mozu-v2-stag.dsmhs.kr')}`,
        `VITE_ADMIN_URL=${getVar('ADMIN_VITE_ADMIN_URL', 'http://localhost:3002/class-management')}`,
        `VITE_ADMIN_AUTH_URL=${getVar('ADMIN_VITE_ADMIN_AUTH_URL', 'http://localhost:3002/signin')}`,
        `VITE_ADMIN_COOKIE_DOMAIN=${getVar('ADMIN_VITE_ADMIN_COOKIE_DOMAIN', 'admin.localhost')}`,
        `BRANCH=${getVar('BRANCH', 'develop')}`,
        `TEST_ID=${getVar('TEST_ID', 'tyler0922')}`,
        `TEST_PW=${getVar('TEST_PW', '12341234')}`
      ].join('\n'),

      'packages/student/.env': [
        `VITE_SERVER_URL=${getVar('VITE_SERVER_URL', 'https://mozu-v2-stag.dsmhs.kr')}`,
        `VITE_STUDENT_URL=${getVar('STUDENT_VITE_STUDENT_URL', 'http://localhost:3001')}`,
        `VITE_STUDENT_AUTH_URL=${getVar('STUDENT_VITE_STUDENT_AUTH_URL', 'http://localhost:3001/signin')}`,
        `VITE_STUDENT_COOKIE_DOMAIN=${getVar('STUDENT_VITE_STUDENT_COOKIE_DOMAIN', 'student.localhost')}`,
        `BRANCH=${getVar('BRANCH', 'develop')}`
      ].join('\n'),

      'packages/ui/.env': [
        `VITE_SERVER_URL=${getVar('VITE_SERVER_URL', 'https://mozu-v2-stag.dsmhs.kr')}`,
        `VITE_ADMIN_URL=${getVar('UI_VITE_ADMIN_URL', 'http://localhost:3002')}`,
        `VITE_ADMIN_AUTH_URL=${getVar('UI_VITE_ADMIN_AUTH_URL', 'http://localhost:3002/class-management')}`,
        `VITE_ADMIN_COOKIE_DOMAIN=${getVar('UI_VITE_ADMIN_COOKIE_DOMAIN', 'localhost')}`,
        `VITE_STUDENT_URL=${getVar('UI_VITE_STUDENT_URL', 'http://192.168.1.6:3001')}`,
        `VITE_STUDENT_AUTH_URL=${getVar('UI_VITE_STUDENT_AUTH_URL', 'http://192.168.1.6:3001/signin/wait')}`,
        `VITE_STUDENT_COOKIE_DOMAIN=${getVar('UI_VITE_STUDENT_COOKIE_DOMAIN', '192.168.1.6')}`
      ].join('\n'),

      'packages/util-config/.env': [
        `VITE_SERVER_URL=${getVar('VITE_SERVER_URL', 'https://mozu-v2-stag.dsmhs.kr')}`,
        `VITE_COOKIE_DOMAIN=${getVar('UTIL_VITE_COOKIE_DOMAIN', 'localhost')}`,
        `VITE_ADMIN_COOKIE_DOMAIN=${getVar('UTIL_VITE_ADMIN_COOKIE_DOMAIN', 'localhost')}`,
        `VITE_STUDENT_COOKIE_DOMAIN=${getVar('UTIL_VITE_STUDENT_COOKIE_DOMAIN', '192.168.1.6')}`
      ].join('\n')
    }

    for (const [relativePath, content] of Object.entries(envFileContents)) {
      try {
        const fullPath = path.join(frontDir, relativePath)
        const dirName = path.dirname(fullPath)
        if (!fs.existsSync(dirName)) {
          fs.mkdirSync(dirName, { recursive: true })
        }
        fs.writeFileSync(fullPath, content, 'utf-8')
        this.log(`[env] Created .env file at ${relativePath}`, notify)
      } catch (error) {
        this.log(`[env] Failed to create .env file at ${relativePath}: ${error}`, notify)
        throw new Error(`Failed to create .env file at ${relativePath}`)
      }
    }
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
  private async installServerDeps(targetDir: string, notify?: (s: LaunchStatus) => void) {
    const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew'
    // gradlew에 실행 권한 부여 (macOS/Linux)
    if (process.platform !== 'win32') {
      try {
        await this.execStream('chmod', ['+x', 'gradlew'], targetDir, notify)
      } catch (err) {
        this.log(`[warn] Failed to chmod +x gradlew: ${err}`, notify)
      }
    }
    this.log(`[deps] ${gradlew} build @ server`, notify)
    await this.execStream(gradlew, ['build', '--no-daemon'], targetDir, notify, true)
  }

  private async installFrontendDeps(targetDir: string, installCommand?: string, notify?: (s: LaunchStatus) => void) {
    let cmd = installCommand
    if (cmd?.trim().startsWith('yarn')) {
      cmd = 'corepack yarn install';
    }
    if (!cmd) {
      const hasYarn = fs.existsSync(path.join(targetDir, 'yarn.lock'))
      const hasPnpm = fs.existsSync(path.join(targetDir, 'pnpm-lock.yaml'))
      const hasNpmLock = fs.existsSync(path.join(targetDir, 'package-lock.json'))
      if (hasYarn) cmd = 'corepack yarn install'
      else if (hasPnpm) cmd = 'pnpm install'
      else if (hasNpmLock) cmd = 'npm ci'
      else cmd = 'npm install'
    }
    const [c, ...args] = cmd.split(' ')
    this.log(`[deps] ${cmd} @ ${path.basename(targetDir)}`, notify)
    await this.execStream(c, args, targetDir, notify, true)
  }

  // ---------- Windows: MySQL 설치 / 서비스 시작 ----------
  private async ensureMySQLOnWindows(notify?: (s: LaunchStatus)=>void) {
    if (process.platform !== 'win32') return

    const execElevated = async (cmd: string, args: string[]) => {
      const argString = args.map(arg => `'${arg.replace(/'/g, "''")}'`).join(',');
      const psCommand = `$p = Start-Process -Verb RunAs -Wait -PassThru -FilePath "${cmd}" -ArgumentList @(${argString}); exit $p.ExitCode`;
      await this.execStream('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCommand], process.cwd(), notify, true);
    }

    let hasMysql = false
    try { await this.execChecked('where', ['mysql'], { env: this.envWithDefaultPath() }); hasMysql = true } catch {}
    if (hasMysql) {
      this.log('[mysql] MySQL is already installed.', notify)
    } else {
      this.log('[mysql] not found. trying to install via winget with elevation...', notify)
      let wingetOk = false
      try { await this.execChecked('winget', ['--version'], { env: this.envWithDefaultPath() }); wingetOk = true } catch {}
      if (wingetOk) {
        const candidates = [['Oracle.MySQL', []], ['Oracle.MySQLServer', []]] as const
        for (const [id, extra] of candidates) {
          try {
            this.log(`[mysql] Attempting to install ${id} via winget...`, notify);
            await execElevated('winget', ['install', '-e', '--id', id, '--silent', '--accept-package-agreements', ...extra]);
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
      if (!hasMysql) {
        this.log('[mysql] winget failed. Trying Chocolatey with elevation...', notify)
        let chocoOk = false
        try { await this.execChecked('choco', ['--version'], { env: this.envWithDefaultPath() }); chocoOk = true } catch {}
        if (chocoOk) {
          try {
            await execElevated('choco', ['install', 'mysql', '-y', '--params', '"/Password:"""']);
            try {
              await this.execChecked('where', ['mysql'], { env: this.envWithDefaultPath() });
              hasMysql = true;
              this.log(`[mysql] Successfully installed via choco.`, notify);
            } catch {
              throw new Error("'choco install' command finished, but 'mysql.exe' was not found in PATH.");
            }
          } catch (e: any) {
            this.log(`[mysql] choco install failed. Error: ${e?.message || e}`, notify);
          }
        }
      }
      if (!hasMysql) {
        this.log('[mysql] 자동 설치 실패. 수동 설치가 필요할 수 있습니다. (MySQL Server 8.x)', notify)
      }
    }

    if (hasMysql) {
      try {
        this.log('[mysql] Attempting to start MySQL service with elevation...', notify);
        const startSvc = `Get-Service -Name 'MySQL*' | Where-Object { $_.Status -ne 'Running' } | Start-Service -PassThru`;
        const encodedStartSvc = Buffer.from(startSvc, 'utf16le').toString('base64');
        await execElevated('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedStartSvc]);
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
    }
  }

  // ---------- start commands ----------
  private async resolveStartCommand(
    targetDir: string,
    type: 'server' | 'frontend',
    requested?: string
  ): Promise<{ cmd: string; args: string[]; label: string }> {
    if (type === 'server') {
      const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew'
      return { cmd: gradlew, args: ['bootRun'], label: 'gradlew bootRun' }
    }

    // Frontend (Node.js based)
    const pkg = this.readJsonIfExists(path.join(targetDir, 'package.json'))
    if (pkg) {
      if (requested && requested.trim()) {
        const [c, ...args] = requested.split(' ')
        return { cmd: c, args, label: 'requested' }
      }
      const pm = this.detectPM(targetDir).pm;
      if (pkg.scripts?.['start:dev']) return { cmd: pm, args: ['run', 'start:dev'], label: `${pm} run start:dev` }
      if (pkg.scripts?.['dev']) return { cmd: pm, args: ['run', 'dev'], label: `${pm} run dev` }
      if (pkg.scripts?.['start']) return { cmd: pm, args: ['run', 'start'], label: `${pm} run start` }
    }
    // Fallback for frontend
    return { cmd: 'npm', args: ['run', 'dev'], label: 'npm run dev (fallback)' }
  }



  // ---------- main flow ----------
  async start(config: RepoConfig, notify?: (s: LaunchStatus) => void) {
    try {
      this.update({ step: 'checking-tools', message: 'Checking git and java...' }, notify)
      await this.ensureTools()

      this.update({ step: 'preparing', message: 'Preparing workspace...' }, notify)
      const { serverDir, frontDir } = await this.ensureWorkspace(config.workspaceDir)

      this.update({ step: 'cloning', message: 'Syncing repositories...' }, notify)
      await this.cloneOrPull(serverDir, config.server.url, config.server.branch, notify)
      await this.cloneOrPull(frontDir, config.frontend.url, config.frontend.branch, notify)

      await this.createFrontendEnvFiles(frontDir, notify)

      this.update({ step: 'installing', message: 'Installing dependencies...' }, notify)

      // Clean up node_modules for frontend to ensure a clean install
      this.log('[deps] Cleaning up existing node_modules directory for frontend...', notify);
      fs.rmSync(path.join(frontDir, 'node_modules'), { recursive: true, force: true });

      await this.installServerDeps(serverDir, notify)
      await this.installFrontendDeps(frontDir, config.frontend.installCommand, notify)

      // Windows: MySQL 설치/서비스
      await this.ensureMySQLOnWindows(notify)

      // DB 정보는 이제 process.env에서 직접 읽어옵니다.
      const jdbcUrl = process.env.SPRING_DATASOURCE_URL || '';
      const dbHost = jdbcUrl.match(/\/\/([^:/]+)/)?.[1] || '127.0.0.1';
      const dbPort = Number(jdbcUrl.match(/:(\d+)\//)?.[1] || 3306);
      const dbUser = process.env.SPRING_DATASOURCE_USERNAME || 'root';
      const dbPass = config.server.dbPassword || process.env.SPRING_DATASOURCE_PASSWORD || '';
      let dbName = 'mozu';
      const pathPart = jdbcUrl.split('?')[0];
      const lastSlash = pathPart.lastIndexOf('/');
      if (lastSlash !== -1 && lastSlash < pathPart.length -1) {
          dbName = pathPart.substring(lastSlash + 1);
      }
      
      // DB 생성 시도
      await this.createDatabaseIfNeeded({ host: dbHost, port: dbPort, user: dbUser, password: dbPass, database: dbName }, notify)

      // 루트 .env 파일을 서버 디렉토리로 복사
      const rootEnvPath = path.join(this.app.getAppPath(), '.env');
      if (fs.existsSync(rootEnvPath)) {
        fs.copyFileSync(rootEnvPath, path.join(serverDir, '.env'));
        this.log(`[env] Copied root .env to server directory.`, notify);
      }

      this.update({ step: 'starting', message: 'Starting processes...' }, notify)

      // 서버 시작 (환경변수 주입 없이)
      const srv = await this.resolveStartCommand(serverDir, 'server', config.server.startCommand)
      this.log(`[start] server via ${srv.label}`, notify)
      this.server = {
        proc: spawn(srv.cmd, srv.args, { cwd: serverDir, shell: true, env: this.envWithDefaultPath() }),
        cwd: serverDir
      }
      this.server.proc?.stdout?.on('data', (d) => this.log(`[server] ${d.toString().trim()}`, notify))
      this.server.proc?.stderr?.on('data', (d) => this.log(`[server:err] ${d.toString().trim()}`, notify))
      this.server.proc?.on('exit', (code, signal) => this.log(`[server] exited (code=${code}, signal=${signal})`, notify))

      // 프론트 시작
      const fe = await this.resolveStartCommand(frontDir, 'frontend', config.frontend.startCommand)
      this.log(`[start] frontend via ${fe.label}`, notify)
      this.frontend = {
        proc: spawn(fe.cmd, fe.args, { cwd: frontDir, shell: true, env: this.envWithDefaultPath() }),
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
