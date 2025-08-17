import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import path from 'path'
import { URL } from 'url'
import { Orchestrator } from './orchestrator'
import type { RepoConfig } from '../shared/types'
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as crypto from 'crypto'

const isDev = !app.isPackaged

let mainWindow: BrowserWindow | null = null
let orchestrator: Orchestrator | null = null

/** ---------- utils: 로그 전달 ---------- */
function sendStatus(status: any) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status-update', status)
  }
}

/** ---------- utils: 공백 경로 우회(심볼릭 링크) ---------- */
const hasSpace = (p: string) => /\s/.test(p)
function symlinkNoSpace(targetAbs: string): string {
  try {
    if (!targetAbs || !hasSpace(targetAbs)) return targetAbs
    const base = path.join(os.tmpdir(), 'mockstock-links')
    fs.mkdirSync(base, { recursive: true })
    const key = crypto.createHash('md5').update(targetAbs).digest('hex').slice(0, 10)
    const link = path.join(base, `ln_${key}`)
    if (fs.existsSync(link)) return link
    // dir 또는 파일일 수 있으나, 여기선 레포 경로(디렉토리)만 대상
    fs.symlinkSync(targetAbs, link, 'dir')
    return link
  } catch {
    // 권한 등으로 실패 시 원본 경로 반환 (최소 침습)
    return targetAbs
  }
}

/** ---------- utils: 안전한 DB 생성 ---------- */
type MysqlOpts = {
  host?: string
  port?: number
  user?: string
  password?: string
  database?: string
  charset?: string
  createIfNotExists?: boolean
}
function createDatabase(opts?: MysqlOpts, extraEnv?: Record<string, string>): Promise<void> {
  const c = {
    host: opts?.host ?? '127.0.0.1',  // ← localhost 대신 IP 사용 (소켓 이슈 회피)
    port: opts?.port ?? 3306,
    user: opts?.user ?? 'root',
    password: opts?.password,
    database: opts?.database ?? 'mozu',
    charset: opts?.charset ?? 'utf8mb4',
    createIfNotExists: opts?.createIfNotExists ?? true
  }
  if (!c.createIfNotExists) return Promise.resolve()

  // ⚠️ 쉘/클라이언트 혼동 방지를 위해 위험 문자 제거
  const db = String(c.database).replace(/[`"'$\\\s]/g, '')
  const cs = String(c.charset).replace(/[`"'$\\\s]/g, '')

  return new Promise((resolve, reject) => {
    const args = [
      '--protocol=TCP',          // 안전하게 TCP 강제
      '-h', c.host,
      '-P', String(c.port),
      '-u', c.user,
      '-e', `CREATE DATABASE IF NOT EXISTS ${db} DEFAULT CHARACTER SET ${cs};`
    ]
    const env = { ...process.env, ...(extraEnv || {}) } as NodeJS.ProcessEnv
    if (c.password) (env as any).MYSQL_PWD = c.password // 비번은 env로 전달

    const p = spawn('mysql', args, { shell: false, env })
    p.stdout.on('data', d => sendStatus({ tag: 'mysql', line: d.toString() }))
    p.stderr.on('data', d => sendStatus({ tag: 'mysql', line: d.toString() }))
    p.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`mysql exited with code ${code}`))
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
    if (orchestrator) {
      orchestrator.dispose()
      orchestrator = null
    }
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
  const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

ipcMain.handle('start-mock', async (_e, config: RepoConfig) => {
  try {
    if (!orchestrator) {
      orchestrator = new Orchestrator(app)
    }

    // 1) 공백 경로 안전화(레포/워크스페이스 등)
    // RepoConfig 구조가 프로젝트마다 다를 수 있어 가장 흔한 키만 처리 + 존재하면 치환
    const cfgAny: any = { ...config }

    if (cfgAny.serverRepoPath) cfgAny.serverRepoPath = symlinkNoSpace(path.resolve(cfgAny.serverRepoPath))
    if (cfgAny.frontendRepoPath) cfgAny.frontendRepoPath = symlinkNoSpace(path.resolve(cfgAny.frontendRepoPath))
    if (cfgAny.workspaceDir) cfgAny.workspaceDir = symlinkNoSpace(path.resolve(cfgAny.workspaceDir))

    // 2) DB 생성 (옵션: config.mysql 제공 시에만)
    // RepoConfig에 mysql이 없을 수도 있으니 any로 안전 처리
    const mysqlOpts: MysqlOpts | undefined = (cfgAny.mysql ? { ...cfgAny.mysql } : undefined)
    if (mysqlOpts) {
      await createDatabase(mysqlOpts, cfgAny.env)
    }

    // 3) 오케스트레이터 시작 (공백 우회된 경로/ENV 전달)
    return await orchestrator.start(cfgAny, (status) => {
      sendStatus(status)
    })
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) }
  }
})

ipcMain.handle('stop-mock', async () => {
  if (!orchestrator) return { ok: true }
  await orchestrator.stop()
  return { ok: true }
})
