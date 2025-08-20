import React, { useEffect, useState } from 'react'
import { Button } from './components/Button'
import { LogPanel } from './components/LogPanel'
import logo from '../assets/logo.svg'

type RepoCfg = import('@shared/types').RepoConfig
type LaunchStatus = import('@shared/types').LaunchStatus

declare global {
  interface Window {
    api: {
      chooseDir: () => Promise<string|null>
      startMock: (cfg: RepoCfg) => Promise<{ok: boolean, error?: string}>
      stopMock: () => Promise<{ok: boolean}>
      onStatusUpdate: (cb: (status: LaunchStatus) => void) => () => void
    }
  }
}

// 하드코딩된 설정 (필요시 여기만 수정)
const FIXED_CFG: RepoCfg = {
  server: {
    url: 'https://github.com/team-mozu/mozu-BE.git',
    branch: 'develop',
    startCommand: 'nest start',
    installCommand: 'npm install',
    cwdName: 'server',
  },
  frontend: {
    url: 'https://github.com/team-mozu/mozu-FE.git',
    branch: 'develop',
    startCommand: 'yarn dev',
    installCommand: 'yarn install',
    cwdName: 'frontend',
    devUrl: 'http://localhost:3000',
  },
}

export default function App() {
  const [logs, setLogs] = useState<string[]>([])
  const [dir, setDir] = useState<string>('')
  const [dbPassword, setDbPassword] = useState('')

  useEffect(() => {
    const off = window.api.onStatusUpdate((s) => setLogs(s.logs || []))
    return () => off()
  }, [])

  const handleChooseDir = async () => {
    const picked = await window.api.chooseDir()
    if (picked) setDir(picked)
  }

  const start = async () => {
    const payload: RepoCfg = {
      ...FIXED_CFG,
      server: {
        ...FIXED_CFG.server,
        dbPassword: dbPassword || undefined,
      },
      workspaceDir: dir || undefined,
    }
    const res = await window.api.startMock(payload)
    if (!res.ok) alert(res.error || '실행 중 오류가 발생했습니다.')
  }

  const stop = async () => {
    await window.api.stopMock()
  }

  return (
    <div className="min-h-screen bg-[#FFF7F0] text-[#151515]">
      <header className="p-6 border-b bg-white">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src={logo} alt="Mozu On-Premise App Logo" className="w-10 h-10" />
            <div>
              <h1 className="text-xl font-bold"><span className="text-carrot">모주</span> <span className="text-xs text-[#71717A]">모의주식투자</span></h1>
              <p className="text-sm text-gray-500">
                모의주식투자 환경을 원클릭으로 실행
                {dir ? <span className="ml-2 text-gray-400">(경로: {dir})</span> : null}
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={handleChooseDir}>경로 변경</Button>
            <Button onClick={start}>모의주식 시작</Button>
            <Button variant="ghost" onClick={stop}>중지</Button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-6 space-y-6">
        <section className="bg-white rounded-2xl p-6 shadow-soft">
          <h2 className="font-semibold mb-4">가이드</h2>
          <ol className="list-decimal pl-5 space-y-2 text-sm text-gray-700">
            <li><b>DB Root 비밀번호</b>를 입력하세요. (없는 경우 비워두세요)</li>
            <li><b>경로 변경</b>으로 설치 위치를 지정하세요. (미지정 시 앱 데이터 경로 사용)</li>
            <li><b>모의주식 시작</b>을 누르면 자동으로 clone → install → start 합니다.</li>
            <li>설치 후 코드는 선택 경로의 <code>server/</code>, <code>frontend/</code>에 생성됩니다.</li>
          </ol>
        </section>

        <section className="bg-white rounded-2xl p-6 shadow-soft">
          <h2 className="font-semibold mb-4">설정</h2>
          <div>
            <label htmlFor="db-password" className="block text-sm font-medium text-gray-700 mb-1">
              DB Root 비밀번호
            </label>
            <input
              type="password"
              id="db-password"
              value={dbPassword}
              onChange={(e) => setDbPassword(e.target.value)}
              className="block w-full max-w-sm px-3 py-2 bg-white border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-carrot focus:border-carrot sm:text-sm"
              placeholder="MySQL root 계정 비밀번호"
            />
            <p className="text-xs text-gray-500 mt-1">
              로컬 MySQL `root` 계정의 비밀번호를 입력하세요.
            </p>
          </div>
        </section>

        <section className="bg-white rounded-2xl p-6 shadow-soft">
          <h2 className="font-semibold mb-4">실행 로그</h2>
          <LogPanel lines={logs} />
          <p className="text-xs text-gray-500 mt-3">
            참고: 코드는 <code>{dir || '앱 데이터 경로'}</code> 아래의 <code>server/</code>, <code>frontend/</code> 폴더에 클론됩니다.
          </p>
        </section>
      </main>
    </div>
  )
}
