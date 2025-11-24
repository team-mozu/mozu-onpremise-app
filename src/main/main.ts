import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import path from 'path'
import { URL } from 'url'
import { spawn } from 'child_process'
import type { RepoConfig, LaunchStatus } from '../shared/types'
import * as fs from 'fs'
import * as os from 'os'

const isDev = !app.isPackaged

let mainWindow: BrowserWindow | null = null

// Orchestrator functionality moved to main process
type Proc = { proc: ReturnType<typeof spawn> | null, cwd: string }
let workspace: string
let status: LaunchStatus = { step: 'idle', logs: [] }
let frontend: Proc | null = null

// Initialize workspace
if (process.platform === 'win32') {
  workspace = 'C:\\mozu-onpremise-workspace'
} else {
  workspace = path.join(app.getPath('userData'), 'workspace')
}

/** ---------- utils: 로그 전달 ---------- */
function sendStatus(statusUpdate: any) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status-update', statusUpdate)
  }
}

/** ---------- Orchestrator functions moved to main ---------- */
function envWithDefaultPath(extraEnv: Record<string,string> = {}) {
  if (process.platform === 'win32') {
    // Windows에서 일반적인 경로들을 PATH에 추가
    const commonPaths = [
      'C:\\Program Files\\Git\\bin',
      'C:\\Program Files\\Git\\cmd',
      'C:\\Program Files\\nodejs',
      'C:\\Windows\\System32',
      'C:\\Windows'
    ]
    const currentPath = process.env.PATH || ''
    const newPath = [...commonPaths, currentPath].join(';')

    return {
      ...process.env,
      PATH: newPath,
      ...extraEnv
    }
  }

  return { ...process.env, ...extraEnv }
}

function updateStatus(partial: Partial<LaunchStatus>, notify?: (s: LaunchStatus) => void) {
  status = { ...status, ...partial, logs: partial.logs ?? status.logs }
  if (notify) notify(status)
}

function updateClient(step: 'idle' | 'preparing' | 'cloning' | 'installing' | 'building' | 'starting' | 'running' | 'error', message?: string, notify?: (s: LaunchStatus) => void) {
  status = {
    ...status,
    client: { step, message }
  }
  if (notify) notify(status)
}

function logMessage(line: string, notify?: (s: LaunchStatus) => void) {
  const logs = status.logs ? [...status.logs, line] : [line]
  updateStatus({ logs }, notify)
}

async function execChecked(cmd: string, args: string[], opts: any) {
  return new Promise<void>((resolve, reject) => {
    // Windows에서 .cmd 파일 실행 시 shell 옵션 설정
    const isWindows = process.platform === 'win32'
    const needsShell = isWindows && cmd.endsWith('.cmd')

    const p = spawn(cmd, args, { stdio: 'ignore', ...opts, shell: needsShell })
    p.on('error', reject)
    p.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`)))
  })
}

async function execStream(
  cmd: string,
  args: string[],
  cwd: string,
  notify?: (s: LaunchStatus) => void,
  shell: boolean = false,
  env: Record<string,string> = {}
) {
  return new Promise<void>((resolve, reject) => {
    // Windows에서 인코딩 문제 해결을 위한 환경변수 설정
    const processEnv = process.platform === 'win32'
      ? { ...envWithDefaultPath(env), CHCP: '65001' } // UTF-8 설정
      : envWithDefaultPath(env)

    // Windows에서 .cmd 파일 실행 시 shell 옵션 자동 설정
    const isWindows = process.platform === 'win32'
    const needsShell = isWindows && (cmd.endsWith('.cmd') || shell)

    const p = spawn(cmd, args, { cwd, shell: needsShell, env: processEnv })
    logMessage(`[exec] ${cmd} ${args.join(' ')} @ ${path.basename(cwd)}`, notify)

    p.stdout?.on('data', (d) => {
      const output = d.toString()
      // Windows에서 인코딩 문제가 있는 경우 처리
      if (process.platform === 'win32' && output.includes('��')) {
        logMessage(`[out] ${output.replace(/��/g, '').trim()}`, notify)
      } else {
        logMessage(`[out] ${output.trim()}`, notify)
      }
    })

    p.stderr?.on('data', (d) => {
      const error = d.toString()
      // Windows에서 인코딩 문제가 있는 경우 처리
      if (process.platform === 'win32' && error.includes('��')) {
        logMessage(`[err] ${error.replace(/��/g, '').trim()}`, notify)
      } else {
        logMessage(`[err] ${error.trim()}`, notify)
      }
    })

    p.on('error', (e) => {
      logMessage(`[error] ${e.message}`, notify)
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

/** ---------- window ---------- */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Mozu On-Premise App',
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false
    }
  })

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
  } else {
    const indexPath = path.join(__dirname, '../renderer/index.html')
    mainWindow.loadURL(new URL(`file://${indexPath}`).toString())
  }

  mainWindow.on('closed', () => {
    mainWindow = null
    // Clean up frontend process when window closes
    stopMockEnvironment()
  })
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/** ---------- IPC ---------- */
ipcMain.handle('choose-dir', async () => {
  const result = await dialog.showOpenDialog({ 
    properties: ['openDirectory', 'createDirectory'],
    title: '프로젝트 저장 폴더 선택',
    message: 'mozu 프로젝트 파일들이 저장될 폴더를 선택해주세요',
    buttonLabel: '선택'
  })
  if (result.canceled || result.filePaths.length === 0) return null
  
  const selectedPath = result.filePaths[0]
  
  // 선택된 폴더의 접근 권한 확인
  try {
    await fs.promises.access(selectedPath, fs.constants.R_OK | fs.constants.W_OK)
    return selectedPath
  } catch (err) {
    console.error('Selected directory is not accessible:', err)
    return null
  }
})

ipcMain.handle('start-mock', async (_e, config: RepoConfig) => {
  try {
    return await startMockEnvironment(config, (status) => {
      sendStatus(status)
    })
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) }
  }
})

ipcMain.handle('start-lesson', async (_e, config: RepoConfig) => {
  try {
    return await startMockEnvironment(config, (status) => {
      sendStatus(status)
    })
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) }
  }
})

ipcMain.handle('stop-mock', async () => {
  await stopMockEnvironment()
  return { ok: true }
})

ipcMain.handle('open-external', async (_e, url: string) => {
  try {
    console.log('Attempting to open URL:', url)

    // URL 유효성 검사
    if (!url || typeof url !== 'string') {
      throw new Error('Invalid URL provided')
    }

    // URL 형식 검증 - http 또는 https로 시작해야 함
    if (!url.match(/^https?:\/\//)) {
      throw new Error('URL must start with http:// or https://')
    }

    // 윈도우에서는 localhost 대신 127.0.0.1 사용 (admin.localhost는 제외)
    if (process.platform === 'win32' && url.includes('localhost') && !url.includes('admin.localhost')) {
      url = url.replace(/localhost/g, '127.0.0.1')
      console.log('Windows: replaced localhost with 127.0.0.1:', url)
    }

    // Windows에서는 직접 cmd start 사용이 더 안정적
    if (process.platform === 'win32') {
      console.log('Using Windows cmd start method...')

      // admin.localhost가 포함된 경우 Windows hosts 파일 확인
      if (url.includes('admin.localhost')) {
        console.log('Checking Windows hosts file for admin.localhost configuration...')
        try {
          const hostsPath = 'C:\\Windows\\System32\\drivers\\etc\\hosts'
          const hostsContent = fs.readFileSync(hostsPath, 'utf-8')

          if (!hostsContent.includes('admin.localhost')) {
            console.log('Warning: admin.localhost not found in hosts file')
            console.log('Admin site may not be accessible. You may need to add:')
            console.log('127.0.0.1 admin.localhost')
            console.log('to your hosts file at: ' + hostsPath)
          } else {
            console.log('admin.localhost found in hosts file - should work correctly')
          }
        } catch (error) {
          console.log('Could not check hosts file:', error)
          console.log('If admin.localhost does not work, please add to hosts file: 127.0.0.1 admin.localhost')
        }
      }

      const { spawn } = await import('child_process')
      // Windows에서 URL을 브라우저에서 열기 위해 start 명령 사용
      // shell: true 옵션으로 URL 파라미터 처리 개선
      spawn('start', ['""', url], {
        detached: true,
        shell: true,
        stdio: 'ignore'
      })
      console.log('Successfully launched URL with cmd start:', url)
    } else {
      await shell.openExternal(url)
      console.log('Successfully opened URL with shell.openExternal:', url)
    }
  } catch (err) {
    console.error('Failed to open external URL:', err)
    throw err // 에러를 다시 던져서 UI에서 처리할 수 있도록
  }
})

ipcMain.handle('get-local-ip', async () => {
  const interfaces = os.networkInterfaces()
  
  // Wi-Fi나 이더넷 인터페이스에서 IPv4 주소 찾기
  for (const name of Object.keys(interfaces)) {
    const iface = interfaces[name]
    if (!iface) continue
    
    for (const alias of iface) {
      // IPv4이고, 내부 네트워크가 아니고, loopback이 아닌 주소
      if (alias.family === 'IPv4' && !alias.internal) {
        return alias.address
      }
    }
  }
  
  return 'localhost' // 찾지 못한 경우 기본값
})

/** ---------- Mock Environment Functions ---------- */
async function ensureTools(notify?: (s: LaunchStatus) => void) {
  const isWindows = process.platform === 'win32'

  // Windows에서는 where 명령어로 확인, Unix에서는 which 명령어로 확인
  async function checkTool(toolName: string): Promise<boolean> {
    try {
      if (isWindows) {
        await execStream('where', [toolName], os.homedir(), notify)
      } else {
        await execStream('which', [toolName], os.homedir(), notify)
      }
      return true
    } catch {
      return false
    }
  }

  // Git 확인
  logMessage('[tools] Checking Git installation...', notify)
  const gitFound = await checkTool('git')
  if (gitFound) {
    logMessage('[tools] ✓ Git found and working.', notify)
    // 버전 확인
    try {
      await execStream('git', ['--version'], os.homedir(), notify)
    } catch {
      // 버전 확인 실패해도 git은 있다고 판단
    }
  } else {
    logMessage('[tools] ✗ Git not found.', notify)
    throw new Error('Git이 설치되지 않았습니다. https://git-scm.com 에서 다운로드하세요.')
  }

  // Node.js 확인
  logMessage('[tools] Checking Node.js installation...', notify)
  const nodeFound = await checkTool('node')
  if (nodeFound) {
    logMessage('[tools] ✓ Node.js found and working.', notify)
    // 버전 확인
    try {
      await execStream('node', ['--version'], os.homedir(), notify)
    } catch {
      // 버전 확인 실패해도 node는 있다고 판단
    }
  } else {
    logMessage('[tools] ✗ Node.js not found.', notify)
    throw new Error('Node.js가 설치되지 않았습니다. https://nodejs.org 에서 다운로드하세요.')
  }

  // yarn 확인 (필수)
  logMessage('[tools] Checking yarn installation...', notify)
  const yarnFound = await checkTool('yarn')
  if (yarnFound) {
    logMessage('[tools] ✓ Yarn found and working.', notify)
    try {
      const yarnCmd = isWindows ? 'yarn.cmd' : 'yarn'
      await execStream(yarnCmd, ['--version'], os.homedir(), notify)
    } catch {
      // 버전 확인 실패해도 yarn은 있다고 판단
    }
  } else {
    logMessage('[tools] ✗ Yarn not found.', notify)
    const isWindows = process.platform === 'win32'
    const installMsg = isWindows
      ? 'Yarn이 설치되지 않았습니다. 다음 중 하나의 방법으로 설치하세요:\n\n1. npm: npm install -g yarn\n2. 공식 설치파일: https://yarnpkg.com/getting-started/install\n3. Chocolatey: choco install yarn'
      : 'Yarn이 설치되지 않았습니다. 다음 명령으로 설치하세요:\nnpm install -g yarn'
    throw new Error(installMsg)
  }

  logMessage('[tools] All required tools are available!', notify)
}

async function installDeps(targetDir: string, command: string, notify?: (s: LaunchStatus) => void) {
  const [cmd, ...args] = command.split(' ')
  const isWindows = process.platform === 'win32'

  logMessage(`[deps] Installing dependencies using ${command}...`, notify)

  if (cmd === 'yarn') {
    const yarnCmd = isWindows ? 'yarn.cmd' : 'yarn'
    if (args.length === 0 || (args.length === 1 && args[0] === 'install')) {
      logMessage('[deps] Running: yarn install', notify)
      await execStream(yarnCmd, ['install'], targetDir, notify)
      return
    }
    logMessage(`[deps] Running: yarn ${args.join(' ')}`, notify)
    await execStream(yarnCmd, args, targetDir, notify)
  } else if (cmd === 'npm') {
    const npmCmd = isWindows ? 'npm.cmd' : 'npm'
    if (args.length === 0 || (args.length === 1 && args[0] === 'install')) {
      logMessage('[deps] Running: npm install', notify)
      await execStream(npmCmd, ['install'], targetDir, notify)
      return
    }
    logMessage(`[deps] Running: npm ${args.join(' ')}`, notify)
    await execStream(npmCmd, args, targetDir, notify)
  }

  logMessage('[deps] Dependencies installation completed.', notify)
}

async function getLocalIP(): Promise<string> {
  const interfaces = os.networkInterfaces()

  for (const name of Object.keys(interfaces)) {
    const iface = interfaces[name]
    if (!iface) continue

    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal) {
        return alias.address
      }
    }
  }

  return 'localhost'
}

async function resolveStartCommand(targetDir: string, requested?: string): Promise<{ cmd: string; args: string[]; label: string }> {
  const isWindows = process.platform === 'win32'

  if (requested) {
    const [cmd, ...args] = requested.split(' ')
    if (cmd === 'yarn') {
      const yarnCmd = isWindows ? 'yarn.cmd' : 'yarn'
      return { cmd: yarnCmd, args, label: requested }
    } else if (cmd === 'npm') {
      const npmCmd = isWindows ? 'npm.cmd' : 'npm'
      return { cmd: npmCmd, args, label: requested }
    }
    return { cmd, args, label: requested }
  }

  const pkgPath = path.join(targetDir, 'package.json')
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
    const scripts = pkg.scripts || {}

    const devScripts = ['dev', 'start', 'serve']
    for (const script of devScripts) {
      if (scripts[script]) {
        const yarnCmd = isWindows ? 'yarn.cmd' : 'yarn'
        return { cmd: yarnCmd, args: [script], label: `yarn ${script}` }
      }
    }
  }

  const yarnCmd = isWindows ? 'yarn.cmd' : 'yarn'
  return { cmd: yarnCmd, args: ['dev'], label: 'yarn dev (default)' }
}

async function startMockEnvironment(config: RepoConfig, notify?: (s: LaunchStatus) => void) {
  try {
    updateStatus({ step: 'checking-tools', message: '환경 확인 중...' }, notify)
    await ensureTools(notify)

    updateStatus({ step: 'preparing', message: '준비 중...' }, notify)

    // 작업 디렉토리 설정
    const { app } = await import('electron')
    const workspaceDir = config.workspaceDir || path.join(app.getPath('userData'), 'workspace')
    const frontDir = path.join(workspaceDir, config.frontend.cwdName || 'frontend')

    logMessage(`[workspace] Using workspace directory: ${workspaceDir}`, notify)
    logMessage(`[frontend] Frontend directory: ${frontDir}`, notify)

    // 작업 디렉토리 생성
    fs.mkdirSync(workspaceDir, { recursive: true })

    // Git 클론 또는 업데이트
    if (fs.existsSync(frontDir)) {
      logMessage('[git] Frontend directory exists, pulling latest changes...', notify)
      updateStatus({ step: 'cloning', message: 'Git 저장소 업데이트 중...' }, notify)
      await execStream('git', ['pull'], frontDir, notify)
    } else {
      logMessage(`[git] Cloning frontend repository: ${config.frontend.url}`, notify)
      updateStatus({ step: 'cloning', message: 'Git 저장소 클론 중...' }, notify)
      await execStream('git', ['clone', config.frontend.url, frontDir], workspaceDir, notify)

      // 브랜치 변경
      if (config.frontend.branch && config.frontend.branch !== 'main' && config.frontend.branch !== 'master') {
        logMessage(`[git] Switching to branch: ${config.frontend.branch}`, notify)
        await execStream('git', ['checkout', config.frontend.branch], frontDir, notify)
      }
    }

    updateStatus({ step: 'installing', message: '의존성 설치 중...' }, notify)
    logMessage('[deps] Cleaning up frontend node_modules...', notify)
    fs.rmSync(path.join(frontDir, 'node_modules'), { recursive: true, force: true })
    await installDeps(frontDir, config.frontend.installCommand || 'yarn install', notify)

    // 환경변수 설정 - packages 구조에 맞게 각각 생성
    logMessage('[config] Creating .env.local files for packages structure...', notify)
    const localIP = await getLocalIP()

    // packages 디렉토리들 확인 및 생성
    const packagesDir = path.join(frontDir, 'packages')
    const adminDir = path.join(packagesDir, 'admin')
    const studentDir = path.join(packagesDir, 'student')
    const utilConfigDir = path.join(packagesDir, 'util-config')

    // Admin package .env.local
    if (fs.existsSync(adminDir)) {
      const adminEnvPath = path.join(adminDir, '.env.local')
      const adminEnvContent = `# Admin package configuration
VITE_SERVER_URL=https://mozu-v2-stag.dsmhs.kr
VITE_ADMIN_URL=http://admin.localhost:3002
VITE_ADMIN_AUTH_URL=http://admin.localhost:3002/signin
VITE_ADMIN_COOKIE_DOMAIN=admin.localhost
BRANCH=main
`
      fs.writeFileSync(adminEnvPath, adminEnvContent, 'utf-8')
      logMessage('[config] Admin .env.local created', notify)
    }

    // Student package .env.local
    if (fs.existsSync(studentDir)) {
      const studentEnvPath = path.join(studentDir, '.env.local')
      const studentEnvContent = `# Student package configuration
VITE_SERVER_URL=https://mozu-v2-stag.dsmhs.kr
VITE_STUDENT_URL=http://${localIP}:3001
VITE_STUDENT_AUTH_URL=http://${localIP}:3001/signin
VITE_STUDENT_COOKIE_DOMAIN=${localIP}
BRANCH=main
`
      fs.writeFileSync(studentEnvPath, studentEnvContent, 'utf-8')
      logMessage('[config] Student .env.local created', notify)
    }

    // Util-config package .env.local
    if (fs.existsSync(utilConfigDir)) {
      const utilEnvPath = path.join(utilConfigDir, '.env.local')
      const utilEnvContent = `# Util-config package configuration
VITE_SERVER_URL=https://mozu-v2-stag.dsmhs.kr
VITE_COOKIE_DOMAIN=localhost
VITE_ADMIN_COOKIE_DOMAIN=admin.localhost
VITE_STUDENT_COOKIE_DOMAIN=${localIP}
BRANCH=main
`
      fs.writeFileSync(utilEnvPath, utilEnvContent, 'utf-8')
      logMessage('[config] Util-config .env.local created', notify)
    }

    // 루트 .env.local도 생성 (fallback)
    const rootEnvPath = path.join(frontDir, '.env.local')
    const rootEnvContent = `# Root fallback configuration
VITE_SERVER_URL=https://mozu-v2-stag.dsmhs.kr
VITE_STUDENT_URL=http://${localIP}:3001
VITE_STUDENT_AUTH_URL=http://${localIP}:3001/signin
VITE_STUDENT_COOKIE_DOMAIN=${localIP}
VITE_ADMIN_URL=http://admin.localhost:3002
VITE_ADMIN_AUTH_URL=http://admin.localhost:3002/signin
VITE_ADMIN_COOKIE_DOMAIN=admin.localhost
VITE_COOKIE_DOMAIN=localhost
BRANCH=main
`
    fs.writeFileSync(rootEnvPath, rootEnvContent, 'utf-8')

    logMessage('[config] Environment variables configured for packages structure', notify)

    updateStatus({ step: 'starting', message: '프론트엔드 시작 중...' }, notify)

    updateClient('starting', '개발 서버를 시작하고 있습니다...', notify)
    const fe = await resolveStartCommand(frontDir, config.frontend.startCommand)
    logMessage(`[start] frontend via ${fe.label}`, notify)

    const frontendEnv = envWithDefaultPath({
      HOST: '0.0.0.0',
      PORT: '3001'
    })

    // Windows에서 .cmd 파일 실행 시 shell 옵션 설정
    const isWindows = process.platform === 'win32'
    const needsShell = isWindows && fe.cmd.endsWith('.cmd')

    frontend = {
      proc: spawn(fe.cmd, fe.args, { cwd: frontDir, shell: needsShell, env: frontendEnv }),
      cwd: frontDir
    }

    frontend.proc?.stdout?.on('data', (d) => logMessage(`[frontend] ${d.toString().trim()}`, notify))
    frontend.proc?.stderr?.on('data', (d) => logMessage(`[frontend:err] ${d.toString().trim()}`, notify))
    frontend.proc?.on('exit', (code, signal) => {
      logMessage(`[frontend] exited (code=${code}, signal=${signal})`, notify)
      if (code !== 0) {
        updateClient('error', '클라이언트가 예상치 못하게 종료되었습니다', notify)
      } else {
        updateClient('idle', '클라이언트 종료됨', notify)
      }
    })

    updateClient('running', '클라이언트 실행 중', notify)

    updateStatus({
      step: 'running',
      message: 'Frontend Running',
      serverPid: null,
      frontendPid: frontend?.proc?.pid ?? null
    }, notify)

    return { ok: true }
  } catch (err: any) {
    updateStatus({ step: 'error', message: err?.message || String(err) }, notify)
    return { ok: false, error: err?.message || String(err) }
  }
}

async function stopMockEnvironment() {
  if (frontend?.proc) {
    return new Promise<void>((resolve) => {
      if (!frontend?.proc) {
        resolve()
        return
      }

      const cleanup = () => {
        resolve()
      }

      frontend.proc.once('exit', cleanup)
      frontend.proc.once('close', cleanup)

      const timeout = setTimeout(cleanup, 5000)

      try {
        if (process.platform === 'win32') {
          const killProc = spawn('taskkill.exe', ['/PID', String(frontend.proc.pid), '/T', '/F'], { stdio: 'ignore', shell: false })
          killProc.on('exit', () => {
            clearTimeout(timeout)
            cleanup()
          })
        } else {
          frontend.proc.kill('SIGTERM')
          setTimeout(() => {
            if (frontend?.proc && !frontend.proc.killed) {
              frontend.proc.kill('SIGKILL')
            }
          }, 3000)
        }
      } catch (err) {
        clearTimeout(timeout)
        cleanup()
      }
    })
  }

  frontend = null
  status = { step: 'idle', logs: [] }
}

// Clean up on app close
app.on('before-quit', async () => {
  await stopMockEnvironment()
})
