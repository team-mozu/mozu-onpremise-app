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

  private detectServerErrors(errorMessage: string, notify?: (s: LaunchStatus) => void) {
    const lowerMsg = errorMessage.toLowerCase()
    
    // Redis 연결 실패
    if (lowerMsg.includes('failed to start bean') && lowerMsg.includes('redis')) {
      this.update({
        step: 'error',
        message: 'Redis 연결 실패 - Redis 서버를 설치하고 실행해주세요',
        logs: [...(this.status.logs || []), 
          '해결 방법:',
          '1. Redis 설치: brew install redis', 
          '2. Redis 실행: brew services start redis',
          '3. 또는 수동 실행: redis-server',
          '다운로드: https://redis.io/download'
        ]
      }, notify)
      return
    }

    // MySQL 연결 실패
    if (lowerMsg.includes('communications link failure') || 
        lowerMsg.includes('connection refused') ||
        lowerMsg.includes('access denied for user')) {
      this.update({
        step: 'error',
        message: 'MySQL 연결 실패 - MySQL 서버 상태를 확인해주세요',
        logs: [...(this.status.logs || []),
          '해결 방법:',
          '1. MySQL 서버 상태 확인: brew services list | grep mysql',
          '2. MySQL 시작: brew services start mysql',
          '3. 비밀번호 확인: .env 파일의 DB_PASSWORD 설정 확인',
          '다운로드: https://dev.mysql.com/downloads/mysql/'
        ]
      }, notify)
      return
    }

    // 포트 충돌
    if (lowerMsg.includes('port') && (lowerMsg.includes('already in use') || lowerMsg.includes('address already in use'))) {
      this.update({
        step: 'error',
        message: '포트 충돌 - 포트가 이미 사용 중입니다',
        logs: [...(this.status.logs || []),
          '해결 방법:',
          '1. 실행 중인 프로세스 확인: lsof -i :8080',
          '2. 프로세스 종료: kill -9 <PID>',
          '3. 다른 포트 사용: application.yml에서 server.port 변경'
        ]
      }, notify)
      return
    }

    // 환경변수 오류
    if (lowerMsg.includes('failed to bind properties') || lowerMsg.includes('property')) {
      this.update({
        step: 'error',
        message: '환경변수 설정 오류 - 필수 환경변수가 설정되지 않았습니다',
        logs: [...(this.status.logs || []),
          '해결 방법:',
          '1. .env 파일 확인',
          '2. application.yml의 환경변수 참조 확인',
          '3. 서버 재시작'
        ]
      }, notify)
      return
    }

    // Java/Kotlin 버전 문제
    if (lowerMsg.includes('unsupported class file major version') || 
        lowerMsg.includes('java.lang.unsupportedclassversion') ||
        lowerMsg.includes('kotlin compilation failed') ||
        lowerMsg.includes('incompatible kotlin version')) {
      this.update({
        step: 'error',
        message: 'Java/Kotlin 버전 호환성 문제',
        logs: [...(this.status.logs || []),
          '현재 환경 요구사항:',
          '- JDK: OpenJDK 17.0.16 (Homebrew)',
          '- Kotlin: 1.9.25',
          '- Spring Boot: 3.5.4',
          '',
          '해결 방법:',
          '1. Java 버전 확인: java -version',
          '2. JAVA_HOME 확인: echo $JAVA_HOME',
          '3. Gradle JVM 설정: ./gradlew -version',
          '4. 필요시 Java 17 재설치: brew install openjdk@17',
          '5. JAVA_HOME 설정: export JAVA_HOME=/opt/homebrew/opt/openjdk@17'
        ]
      }, notify)
      return
    }

    // Gradle/Kotlin 빌드 실패
    if (lowerMsg.includes('build failed') || 
        lowerMsg.includes('compilation failed') ||
        lowerMsg.includes('gradle build failed') ||
        lowerMsg.includes('ktlint')) {
      this.update({
        step: 'error',
        message: 'Gradle/Kotlin 빌드 실패',
        logs: [...(this.status.logs || []),
          '현재 빌드 환경:',
          '- Gradle: 8.14.3',
          '- Kotlin: 1.9.25',
          '- Spring Boot: 3.5.4',
          '- Ktlint: 11.5.1',
          '',
          '해결 방법:',
          '1. Gradle 캐시 정리: ./gradlew clean',
          '2. 의존성 새로 설치: ./gradlew build --refresh-dependencies',
          '3. Kotlin 컴파일 재시도: ./gradlew compileKotlin',
          '4. Ktlint 검사 (선택): ./gradlew ktlintCheck',
          '5. 상세 로그: ./gradlew bootRun --info --stacktrace'
        ]
      }, notify)
      return
    }

    // Spring Boot 특화 에러
    if (lowerMsg.includes('spring') && (lowerMsg.includes('failed') || lowerMsg.includes('error'))) {
      this.update({
        step: 'error',
        message: 'Spring Boot 애플리케이션 오류',
        logs: [...(this.status.logs || []),
          'Spring Boot 3.5.4 환경 확인:',
          '1. application.yml 설정 확인',
          '2. 환경변수 바인딩 확인 (.env 파일)',
          '3. 데이터베이스 연결 확인 (MySQL)',
          '4. Redis 서버 상태 확인',
          '5. 포트 충돌 확인 (기본: 8080)',
          '',
          '디버그 실행: ./gradlew bootRun --debug'
        ]
      }, notify)
      return
    }
  }

  private update(partial: Partial<LaunchStatus>, notify?: (s: LaunchStatus) => void) {
    this.status = { ...this.status, ...partial, logs: partial.logs ?? this.status.logs }
    if (notify) notify(this.status)
  }

  private updateServer(step: 'idle' | 'preparing' | 'cloning' | 'installing' | 'building' | 'starting' | 'running' | 'error', message?: string, notify?: (s: LaunchStatus) => void) {
    this.status = {
      ...this.status,
      server: { step, message }
    }
    if (notify) notify(this.status)
  }

  private updateClient(step: 'idle' | 'preparing' | 'cloning' | 'installing' | 'building' | 'starting' | 'running' | 'error', message?: string, notify?: (s: LaunchStatus) => void) {
    this.status = {
      ...this.status,
      client: { step, message }
    }
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
      
      let hasOutput = false
      let errorMessages: string[] = []
      
      p.stdout?.on('data', (d) => {
        hasOutput = true
        const output = d.toString().trim()
        this.log(`[build:out] ${output}`, notify)
      })
      
      p.stderr?.on('data', (d) => {
        hasOutput = true
        const output = d.toString().trim()
        
        // 에러 메시지 수집
        if (output.toLowerCase().includes('error') || 
            output.toLowerCase().includes('failed') ||
            output.toLowerCase().includes('exception')) {
          errorMessages.push(output)
        }
        
        this.log(`[build:err] ${output}`, notify)
      })
      
      p.on('error', (err) => {
        this.log(`[exec] Process error: ${err.message}`, notify)
        reject(err)
      })
      
      p.on('exit', (code, signal) => {
        if (code === 0) {
          resolve()
        } else {
          // 에러 발생 시 상세 정보 제공
          const errorSummary = errorMessages.length > 0 
            ? `주요 에러: ${errorMessages.slice(-3).join(', ')}`
            : '상세한 에러 메시지는 위 로그를 확인하세요'
            
          if (!hasOutput) {
            this.log(`[exec] No output from command - possible permission or path issue`, notify)
          }
          
          this.log(`[exec] ❌ ${cmd} failed (code=${code}, signal=${signal})`, notify)
          this.log(`[exec] ${errorSummary}`, notify)
          
          reject(new Error(`${cmd} exited with code ${code}. ${errorSummary}`))
        }
      })
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
    
    // Java 설치 확인 (Kotlin Spring Boot용)
    try {
      await this.execChecked('java', ['--version'], { cwd: os.homedir(), env: this.envWithDefaultPath() })
      this.log('[tools] Java found.', notify)
    } catch (err) {
      this.log('[tools] Java not found. Checking for javac...', notify)
      try {
        await this.execChecked('javac', ['--version'], { cwd: os.homedir(), env: this.envWithDefaultPath() })
        this.log('[tools] Java Development Kit found.', notify)
      } catch (jdkErr) {
        throw new Error('Java가 설치되지 않았거나 PATH에 없습니다. Kotlin Spring Boot 서버 실행을 위해 JDK 17 이상을 설치하고 다시 시도하세요.')
      }
    }
    
    // Gradle 설치 확인
    try {
      await this.execChecked('gradle', ['--version'], { cwd: os.homedir(), env: this.envWithDefaultPath() })
      this.log('[tools] Gradle found.', notify)
    } catch (err) {
      this.log('[tools] Gradle not found. Will use gradlew if available.', notify)
      // Gradle이 없어도 gradlew가 있으면 실행 가능하므로 에러를 발생시키지 않음
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

  private async createFrontendEnvFiles(frontDir: string, notify?: (s: LaunchStatus) => void) {
    this.log('[env] Creating .env files for frontend from root .env...', notify)

    const getVar = (key: string, defaultValue: string = ''): string => {
      return process.env[key] || defaultValue
    }

    const envFileContents: Record<string, string> = {
      'packages/admin/.env': [
        `VITE_SERVER_URL=${getVar('VITE_SERVER_URL')}`,
        `VITE_ADMIN_URL=${getVar('ADMIN_VITE_ADMIN_URL')}`,
        `VITE_ADMIN_AUTH_URL=${getVar('ADMIN_VITE_ADMIN_AUTH_URL')}`,
        `VITE_ADMIN_COOKIE_DOMAIN=${getVar('ADMIN_VITE_ADMIN_COOKIE_DOMAIN')}`,
        `BRANCH=${getVar('BRANCH')}`,
        `TEST_ID=${getVar('TEST_ID')}`,
        `TEST_PW=${getVar('TEST_PW')}`
      ].join('\n'),

      'packages/student/.env': [
        `VITE_SERVER_URL=${getVar('VITE_SERVER_URL')}`,
        `VITE_STUDENT_URL=${getVar('STUDENT_VITE_STUDENT_URL')}`,
        `VITE_STUDENT_AUTH_URL=${getVar('STUDENT_VITE_STUDENT_AUTH_URL')}`,
        `VITE_STUDENT_COOKIE_DOMAIN=${getVar('STUDENT_VITE_STUDENT_COOKIE_DOMAIN')}`,
        `BRANCH=${getVar('BRANCH')}`
      ].join('\n'),

      'packages/ui/.env': [
        `VITE_SERVER_URL=${getVar('VITE_SERVER_URL')}`,
        `VITE_ADMIN_URL=${getVar('UI_VITE_ADMIN_URL')}`,
        `VITE_ADMIN_AUTH_URL=${getVar('UI_VITE_ADMIN_AUTH_URL')}`,
        `VITE_ADMIN_COOKIE_DOMAIN=${getVar('UI_VITE_ADMIN_COOKIE_DOMAIN')}`,
        `VITE_STUDENT_URL=${getVar('UI_VITE_STUDENT_URL')}`,
        `VITE_STUDENT_AUTH_URL=${getVar('UI_VITE_STUDENT_AUTH_URL')}`,
        `VITE_STUDENT_COOKIE_DOMAIN=${getVar('UI_VITE_STUDENT_COOKIE_DOMAIN')}`
      ].join('\n'),

      'packages/util-config/.env': [
        `VITE_SERVER_URL=${getVar('VITE_SERVER_URL')}`,
        `VITE_COOKIE_DOMAIN=${getVar('UTIL_VITE_COOKIE_DOMAIN')}`,
        `VITE_ADMIN_COOKIE_DOMAIN=${getVar('UTIL_VITE_ADMIN_COOKIE_DOMAIN')}`,
        `VITE_STUDENT_COOKIE_DOMAIN=${getVar('UTIL_VITE_STUDENT_COOKIE_DOMAIN')}`
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
  private async installDeps(targetDir: string, installCommand?: string, notify?: (s: LaunchStatus) => void) {
    let cmd = installCommand
    
    // Gradle 프로젝트 감지
    const hasGradleBuild = fs.existsSync(path.join(targetDir, 'build.gradle')) || 
                          fs.existsSync(path.join(targetDir, 'build.gradle.kts'))
    
    if (hasGradleBuild) {
      // Gradle 프로젝트인 경우
      if (!cmd) {
        const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew'
        cmd = fs.existsSync(path.join(targetDir, 'gradlew')) ? `${gradlew} build` : 'gradle build'
      }
      
      // ./gradlew 명령어 처리
      if (cmd.startsWith('./gradlew')) {
        // gradlew 파일이 실제로 존재하는지 확인
        const gradlewExists = fs.existsSync(path.join(targetDir, 'gradlew'))
        if (gradlewExists) {
          const gradlewPath = process.platform === 'win32' ? 'gradlew.bat' : './gradlew'
          const baseArgs = cmd.replace('./gradlew', '').trim().split(' ').filter(Boolean)
          
          // 빌드 명령어인 경우 상세 로그 옵션 추가
          const args = baseArgs.includes('build') || baseArgs.includes('bootRun')
            ? [...baseArgs, '--info', '--stacktrace']
            : baseArgs
          
          this.log(`[deps] ${gradlewPath} ${args.join(' ')} @ ${path.basename(targetDir)}`, notify)
          this.log(`[deps] 빌드 시작 - 상세 로그가 표시됩니다...`, notify)
          
          try {
            await this.execStream(gradlewPath, args, targetDir, notify, true)
            this.log(`[deps] ✅ 빌드 완료`, notify)
          } catch (error) {
            this.log(`[deps] ❌ 빌드 실패: ${error}`, notify)
            throw error
          }
          return
        } else {
          // gradlew가 없으면 gradle 명령어로 대체
          this.log(`[deps] gradlew not found, falling back to gradle command`, notify)
          const baseArgs = cmd.replace('./gradlew', '').trim().split(' ').filter(Boolean)
          
          // gradle도 설치되어 있는지 확인
          try {
            await this.execChecked('gradle', ['--version'], { cwd: targetDir, env: this.envWithDefaultPath() })
          } catch (gradleErr) {
            throw new Error('gradlew 파일이 없고 Gradle도 설치되지 않았습니다. Gradle을 설치하거나 gradlew wrapper가 포함된 프로젝트를 사용해주세요.')
          }
          
          // 빌드 명령어인 경우 상세 로그 옵션 추가
          const args = baseArgs.includes('build') || baseArgs.includes('bootRun')
            ? [...baseArgs, '--info', '--stacktrace']
            : baseArgs
            
          this.log(`[deps] gradle ${args.join(' ')} @ ${path.basename(targetDir)}`, notify)
          this.log(`[deps] 빌드 시작 - 상세 로그가 표시됩니다...`, notify)
          
          try {
            await this.execStream('gradle', args, targetDir, notify, true)
            this.log(`[deps] ✅ 빌드 완료`, notify)
          } catch (error) {
            this.log(`[deps] ❌ 빌드 실패: ${error}`, notify)
            throw error
          }
          return
        }
      }
    } else {
      // Node.js 프로젝트인 경우
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
    }
    
    const [c, ...args] = cmd.split(' ')
    this.log(`[deps] ${cmd} @ ${path.basename(targetDir)}`, notify)
    this.log(`[deps] 의존성 설치 시작...`, notify)
    
    try {
      await this.execStream(c, args, targetDir, notify, true)
      this.log(`[deps] ✅ 의존성 설치 완료`, notify)
    } catch (error) {
      this.log(`[deps] ❌ 의존성 설치 실패: ${error}`, notify)
      throw error
    }
  }

  // 서버 환경별 추가 설정
  private async ensureServerExtras(serverDir: string, notify?: (s: LaunchStatus) => void) {
    // Gradle 프로젝트인지 확인
    const hasGradleBuild = fs.existsSync(path.join(serverDir, 'build.gradle')) || 
                          fs.existsSync(path.join(serverDir, 'build.gradle.kts'))
    
    if (hasGradleBuild) {
      this.log('[deps-extra] Gradle 프로젝트 감지됨. 추가 의존성 설치는 build.gradle에서 관리됩니다.', notify)
      
      // Gradle wrapper 실행 권한 부여 (Unix 계열)
      if (process.platform !== 'win32') {
        const gradlewPath = path.join(serverDir, 'gradlew')
        if (fs.existsSync(gradlewPath)) {
          try {
            await this.execChecked('chmod', ['+x', gradlewPath], { cwd: serverDir })
            this.log('[deps-extra] gradlew 실행 권한 부여 완료', notify)
          } catch (e) {
            this.log('[deps-extra] gradlew 권한 설정 실패 (무시하고 계속)', notify)
          }
        }
      }
      return
    }
    
    // Node.js 프로젝트인 경우 기존 로직
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
            await execElevated('choco', ['install', 'mysql', '-y', '--params', '"/Password:"""']);
            // 설치 성공 여부를 직접 확인
            try {
              await this.execChecked('where', ['mysql'], { env: this.envWithDefaultPath() });
              hasMysql = true;
              this.log(`[mysql] Successfully installed via choco.`, notify);
            } catch {
              // 'where mysql' 명령이 실패하면, choco 설치가 실제로는 실패한 것으로 간주
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

    // 서비스 시작 시도 (관리자 권한으로)
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
    const env = { ...process.env }
    
    // 비밀번호가 있으면 환경변수로 전달 (더 안전)
    if (db.password) {
      env.MYSQL_PWD = db.password
    }
    
    const sql = `CREATE DATABASE IF NOT EXISTS \`${db.database}\` DEFAULT CHARACTER SET utf8mb4;`
    try {
      const p = spawn('mysql', [...args, '-e', sql], { 
        cwd: process.cwd(), 
        env: this.envWithDefaultPath(env as Record<string, string>),
        stdio: ['ignore', 'pipe', 'pipe']
      })
      
      let output = ''
      p.stdout?.on('data', (d) => {
        output += d.toString()
        this.log(`[mysql] ${d.toString().trim()}`, notify)
      })
      p.stderr?.on('data', (d) => {
        output += d.toString()
        this.log(`[mysql] ${d.toString().trim()}`, notify)
      })
      
      await new Promise<void>((resolve, reject) => {
        p.on('exit', (code) => {
          if (code === 0) {
            this.log(`[mysql] ensured database "${db.database}"`, notify)
            resolve()
          } else {
            reject(new Error(`mysql exited with code ${code}`))
          }
        })
        p.on('error', reject)
      })
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
    // Gradle 프로젝트 감지
    const hasGradleBuild = fs.existsSync(path.join(targetDir, 'build.gradle')) || 
                          fs.existsSync(path.join(targetDir, 'build.gradle.kts'))
    
    if (hasGradleBuild) {
      // Gradle 프로젝트인 경우
      if (requested && requested.trim()) {
        if (requested.startsWith('./gradlew')) {
          // gradlew 파일이 존재하는지 확인
          const gradlewExists = fs.existsSync(path.join(targetDir, 'gradlew'))
          if (gradlewExists) {
            const gradlewPath = process.platform === 'win32' ? 'gradlew.bat' : './gradlew'
            const args = requested.replace('./gradlew', '').trim().split(' ').filter(Boolean)
            return { cmd: gradlewPath, args, label: 'gradlew (requested)' }
          } else {
            // gradlew가 없으면 gradle 명령어로 대체
            const args = requested.replace('./gradlew', '').trim().split(' ').filter(Boolean)
            
            // gradle 설치 확인
            try {
              await this.execChecked('gradle', ['--version'], { cwd: targetDir, env: this.envWithDefaultPath() })
              return { cmd: 'gradle', args, label: 'gradle (fallback)' }
            } catch (gradleErr) {
              throw new Error('gradlew 파일이 없고 Gradle도 설치되지 않았습니다. Gradle을 설치하거나 gradlew wrapper가 포함된 프로젝트를 사용해주세요.')
            }
          }
        }
        const [c, ...args] = requested.split(' ')
        return { cmd: c, args, label: 'requested' }
      }
      
      // 기본 Gradle 시작 명령어 (디버그 옵션 추가)
      const gradlewPath = process.platform === 'win32' ? 'gradlew.bat' : './gradlew'
      if (fs.existsSync(path.join(targetDir, 'gradlew'))) {
        return { cmd: gradlewPath, args: ['bootRun', '--info', '--stacktrace', '--debug'], label: 'gradlew bootRun --info --stacktrace --debug' }
      } else {
        return { cmd: 'gradle', args: ['bootRun', '--info', '--stacktrace', '--debug'], label: 'gradle bootRun --info --stacktrace --debug' }
      }
    }
    
    // Node.js 프로젝트인 경우 (기존 로직)
    if (requested && /^nest(\.cmd)?\s+start(\b|$)/.test(requested)) {
      const localNest = this.localBin(targetDir, 'nest')
      if (localNest) return { cmd: localNest, args: ['start', '--watch'], label: 'local nest' }
      return { cmd: 'npx', args: ['nest', 'start', '--watch'], label: 'npx nest' }
    }
    
    const pkg = this.readJsonIfExists(path.join(targetDir, 'package.json'))
    if (pkg) {
      if (requested && requested.trim()) {
        const [c, ...args] = requested.split(' ')
        return { cmd: c, args, label: 'requested' }
      }
      const pm = this.detectPM(targetDir).pm;
      if (pkg.scripts?.['start:dev']) return { cmd: pm, args: ['run', 'start:dev'], label: `${pm} run start:dev` }
      if (pkg.scripts?.['start']) return { cmd: pm, args: ['run', 'start'], label: `${pm} run start` }
    }
    
    // fallback: 로컬 nest → npx nest
    const localNest = this.localBin(targetDir, 'nest')
    if (localNest) return { cmd: localNest, args: ['start', '--watch'], label: 'local nest (fallback)' }
    return { cmd: 'npx', args: ['nest', 'start', '--watch'], label: 'npx nest (fallback)' }
  }

  // ---------- main flow ----------
  async start(config: RepoConfig, notify?: (s: LaunchStatus) => void) {
    try {

      const rootEnvPath = path.join(this.app.getAppPath(), '.env');

      // Load .env file from app root
      if (fs.existsSync(rootEnvPath)) {
        const envConfig = this.parseDotEnv(fs.readFileSync(rootEnvPath, 'utf-8'));
        for (const k in envConfig) {
          if (!Object.prototype.hasOwnProperty.call(process.env, k)) {
            process.env[k] = envConfig[k];
          }
        }
        this.log(`[env] Loaded root .env file into process environment.`, notify);
      }

      this.update({ step: 'checking-tools', message: 'Checking git and npm...' }, notify)
      await this.ensureTools()

      this.update({ step: 'preparing', message: 'Preparing workspace...' }, notify)
      const { serverDir, frontDir } = await this.ensureWorkspace(config.workspaceDir)

      this.update({ step: 'cloning', message: 'Syncing repositories...' }, notify)
      await this.cloneOrPull(serverDir, config.server.url, config.server.branch, notify)
      await this.cloneOrPull(frontDir, config.frontend.url, config.frontend.branch, notify)

      await this.createFrontendEnvFiles(frontDir, notify)

      this.update({ step: 'installing', message: 'Installing dependencies...' }, notify)

      // Clean up node_modules to ensure a clean install, especially for PnP projects
      this.log('[deps] Cleaning up existing node_modules directories...', notify);
      fs.rmSync(path.join(serverDir, 'node_modules'), { recursive: true, force: true });
      fs.rmSync(path.join(frontDir, 'node_modules'), { recursive: true, force: true });
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

      // .env 병합/기록 (TypeORM + Spring Boot 환경변수)
      
      // Gradle 프로젝트인지 확인 (Spring Boot)
      const hasGradleBuild = fs.existsSync(path.join(serverDir, 'build.gradle')) || 
                            fs.existsSync(path.join(serverDir, 'build.gradle.kts'))
      
      const envVars: Record<string, string> = {
        DB_HOST: dbHost,
        DB_PORT: String(dbPort),
        DB_NAME: dbName,
        DB_USERNAME: dbUser,
        DB_PASSWORD: dbPass,
      }
      
      // Spring Boot 프로젝트인 경우 추가 환경변수
      if (hasGradleBuild) {
        Object.assign(envVars, {
          // JPA/Hibernate 설정
          JPA_SHOW_SQL: 'true',
          JPA_FORMAT_SQL: 'true',
          JPA_HIBERNATE_DDL_AUTO: 'update',
          
          // Redis 설정 (기본값)
          REDIS_HOST: 'localhost',
          REDIS_PORT: '6379',
          
          // JWT 설정 (개발용 기본값)
          HEADER: 'Authorization',
          PREFIX: 'Bearer ',
          JWT_SECRET: 'mozu-development-secret-key-change-in-production',
          ACCESS_EXP: '3600',
          REFRESH_EXP: '86400',
          STUDENT_ACCESS_EXP: '7200',
          
          // AWS S3 설정 (개발용 더미값)
          BUCKET_NAME: 'mozu-dev-bucket',
          MOZU_IMAGE_FOLDER: 'images/',
          AWS_REGION: 'ap-northeast-2',
          AWS_ACCESS_KEY_ID: 'dummy-access-key',
          AWS_SECRET_ACCESS_KEY: 'dummy-secret-key',
          
        })
      }
      
      this.mergeWriteEnv(serverDir, envVars, notify)

      this.update({ step: 'starting', message: 'Starting processes...' }, notify)

      // 서버 시작 - 업데이트된 환경변수 다시 로드
      const updatedEnvFromFiles = this.loadServerEnv(serverDir)
      this.log(`[env] Loaded environment variables: ${Object.keys(updatedEnvFromFiles).join(', ')}`, notify)
      
      // Spring Boot 필수 환경변수 확인
      if (hasGradleBuild) {
        const springEnvKeys = ['JPA_SHOW_SQL', 'SPRING_DATASOURCE_URL', 'SPRING_JPA_SHOW_SQL']
        const missingKeys = springEnvKeys.filter(key => !updatedEnvFromFiles[key])
        if (missingKeys.length > 0) {
          this.log(`[env] Warning: Missing Spring Boot environment variables: ${missingKeys.join(', ')}`, notify)
        } else {
          this.log(`[env] Spring Boot environment variables loaded successfully`, notify)
        }
      }
      
      // 서버 시작 전 빌드 단계 추가
      const serverHasGradleBuild = fs.existsSync(path.join(serverDir, 'build.gradle')) || 
                                  fs.existsSync(path.join(serverDir, 'build.gradle.kts'))
      
      if (serverHasGradleBuild) {
        this.log(`[build] 서버 빌드 시작...`, notify)
        this.updateServer('building', '서버를 빌드하고 있습니다...', notify)
        
        try {
          // 먼저 시스템에 설치된 Gradle 사용 시도
          let useSystemGradle = false
          try {
            await this.execChecked('gradle', ['--version'], { cwd: serverDir, env: this.envWithDefaultPath() })
            useSystemGradle = true
            this.log('[build] 시스템 설치된 Gradle 사용', notify)
          } catch (e) {
            this.log('[build] 시스템 Gradle 없음, gradlew 사용 시도', notify)
          }
          
          if (useSystemGradle) {
            this.log(`[build] gradle build --info --stacktrace @ ${path.basename(serverDir)}`, notify)
            await this.execStream('gradle', ['build', '--info', '--stacktrace'], serverDir, notify, false, updatedEnvFromFiles)
          } else {
            const gradlewPath = process.platform === 'win32' ? 'gradlew.bat' : './gradlew'
            
            if (fs.existsSync(path.join(serverDir, 'gradlew'))) {
              this.log(`[build] ${gradlewPath} build --info --stacktrace @ ${path.basename(serverDir)}`, notify)
              this.log('[build] Gradle wrapper 다운로드 중... (최대 5분 소요 가능)', notify)
              await this.execStream(gradlewPath, ['build', '--info', '--stacktrace', '-Dorg.gradle.internal.network.timeout=300000'], serverDir, notify, false, updatedEnvFromFiles)
            } else {
              throw new Error('gradlew 파일이 없고 시스템 Gradle도 설치되지 않았습니다.')
            }
          }
          
          this.log(`[build] ✅ 서버 빌드 완료`, notify)
          this.updateServer('building', '서버 빌드 완료', notify)
        } catch (buildError) {
          this.log(`[build] ❌ 서버 빌드 실패: ${buildError}`, notify)
          this.updateServer('error', '서버 빌드 실패', notify)
          throw buildError
        }
      }

      this.log(`[start] 빌드 완료, 서버 시작 중...`, notify)
      this.updateServer('starting', '서버를 시작하고 있습니다...', notify)
      
      const srv = await this.resolveStartCommand(serverDir, config.server.startCommand)
      this.log(`[start] server via ${srv.label}`, notify)
      this.server = {
        proc: spawn(srv.cmd, srv.args, { cwd: serverDir, shell: process.platform === 'win32', env: this.envWithDefaultPath(updatedEnvFromFiles) }),
        cwd: serverDir
      }
      this.server.proc?.stdout?.on('data', (d) => this.log(`[server] ${d.toString().trim()}`, notify))
      this.server.proc?.stderr?.on('data', (d) => {
        const errMsg = d.toString().trim()
        this.log(`[server:err] ${errMsg}`, notify)
        
        // 에러 패턴 감지 및 해결방안 제공
        this.detectServerErrors(errMsg, notify)
      })
      this.server.proc?.on('exit', (code, signal) => {
        const exitMsg = `[server] exited (code=${code}, signal=${signal})`
        this.log(exitMsg, notify)
        
        // 종료 코드가 0이 아닌 경우 에러로 처리
        if (code !== 0) {
          this.updateServer('error', '서버가 예상치 못하게 종료되었습니다', notify)
        } else {
          this.updateServer('idle', '서버 종료됨', notify)
        }
      })

      // 프론트 시작
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

      // 서버와 클라이언트 모두 실행 상태로 업데이트
      this.updateServer('running', '서버 실행 중', notify)
      this.updateClient('running', '클라이언트 실행 중', notify)
      
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
