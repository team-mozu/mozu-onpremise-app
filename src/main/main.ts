import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import path from 'path'
import { URL } from 'url'
import { Orchestrator } from './orchestrator'
import type { RepoConfig } from '../shared/types'
import * as fs from 'fs'

const isDev = !app.isPackaged

let mainWindow: BrowserWindow | null = null
let orchestrator: Orchestrator | null = null

/** ---------- utils: 로그 전달 ---------- */
function sendStatus(status: any) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status-update', status)
  }
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
    if (!orchestrator) {
      orchestrator = new Orchestrator(app)
    }

    return await orchestrator.start(config, (status) => {
      sendStatus(status)
    })
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) }
  }
})

ipcMain.handle('start-lesson', async (_e, config: RepoConfig) => {
  try {
    if (!orchestrator) {
      orchestrator = new Orchestrator(app)
    }

    return await orchestrator.startLesson(config, (status) => {
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

ipcMain.handle('open-external', async (_e, url: string) => {
  try {
    await shell.openExternal(url)
  } catch (err) {
    console.error('Failed to open external URL:', err)
  }
})
