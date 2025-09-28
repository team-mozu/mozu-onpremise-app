import { contextBridge, ipcRenderer } from 'electron'
import type { RepoConfig, LaunchStatus } from '../shared/types'

// 화이트리스트 채널 (메인에서 실제로 쓰는 채널만 노출)
const INVOKE_CHANNELS = new Set(['choose-dir', 'start-mock', 'stop-mock'] as const)
const ON_CHANNELS = new Set(['status-update'] as const)

function safeInvoke<T = any>(channel: string, ...args: any[]): Promise<T> {
  if (!INVOKE_CHANNELS.has(channel as any)) {
    return Promise.reject(new Error(`Blocked invoke channel: ${channel}`))
  }
  return ipcRenderer.invoke(channel, ...args)
}

function onStatusUpdate(cb: (status: LaunchStatus) => void): () => void {
  const channel = 'status-update'
  if (!ON_CHANNELS.has(channel as any)) {
    // 이 경우는 거의 없지만, 방어적으로 처리
    return () => {}
  }
  const handler = (_: Electron.IpcRendererEvent, payload: LaunchStatus) => {
    try {
      cb(payload)
    } catch (e) {
      // 렌더러 콜백 에러가 메인 프로세스까지 전파되지 않도록
      // eslint-disable-next-line no-console
      console.error('[preload] onStatusUpdate callback error:', e)
    }
  }
  ipcRenderer.on(channel, handler)
  // 호출자 측에서 해제할 수 있도록 언바인더 반환
  return () => {
    ipcRenderer.off(channel, handler)
  }
}

contextBridge.exposeInMainWorld('api', {
  chooseDir: (): Promise<string | null> => safeInvoke('choose-dir'),
  startMock: (config: RepoConfig): Promise<{ ok: boolean; error?: string }> => safeInvoke('start-mock', config),
  stopMock: (): Promise<{ ok: boolean }> => safeInvoke('stop-mock'),
  onStatusUpdate
})

// (선택) 전역 타입 보강: TS에서 window.api 호출 시 타입 완성도↑
declare global {
  interface Window {
    api: {
      chooseDir: () => Promise<string | null>
      startMock: (config: RepoConfig) => Promise<{ ok: boolean; error?: string }>
      stopMock: () => Promise<{ ok: boolean }>
      onStatusUpdate: (cb: (status: LaunchStatus) => void) => () => void
    }
  }
}
export {}