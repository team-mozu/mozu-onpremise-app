import { useEffect, useState } from 'react'
import { Button } from './components/Button'
import { LogPanel } from './components/LogPanel'
import logo from '../assets/logo.svg'

type RepoCfg = import('@shared/types').RepoConfig
type LaunchStatus = import('@shared/types').LaunchStatus

declare global {
  interface Window {
    api: {
      chooseDir: () => Promise<string | null>
      startMock: (cfg: RepoCfg) => Promise<{ ok: boolean, error?: string }>
      startLesson: (cfg: RepoCfg) => Promise<{ ok: boolean, error?: string }>
      stopMock: () => Promise<{ ok: boolean }>
      openExternal: (url: string) => Promise<void>
      getLocalIP: () => Promise<string>
      onStatusUpdate: (cb: (status: LaunchStatus) => void) => () => void
    }
  }
}

// 하드코딩된 설정 (필요시 여기만 수정)
const FIXED_CFG: RepoCfg = {
  frontend: {
    url: 'https://github.com/team-mozu/mozu-FE.git',
    branch: 'main',
    installCommand: 'yarn install',
    startCommand: 'yarn dev:ip',
    cwdName: 'frontend',
    devUrl: 'http://localhost:3001',
  }
}

function getErrorSolution(error: string): { title: string; message: string; solutions: string[]; links?: { text: string; url: string }[] } {
  // Git 관련 오류
  if (error.includes('git') || error.includes('설치되지 않았거나') || error.includes('Git이 설치되지 않았습니다')) {
    return {
      title: '필요한 프로그램이 없습니다',
      message: '모의주식 사이트를 실행하기 위한 Git 프로그램이 설치되어 있지 않습니다. 파일을 다운로드하기 위해 필요합니다.',
      solutions: [
        '1. 아래 링크에서 Git 프로그램을 다운로드하여 설치해주세요',
        '2. 설치 후 반드시 컴퓨터를 재시작해주세요',
        '3. 재시작 후 다시 수업 시작을 눌러주세요'
      ],
      links: [
        { text: 'Git 다운로드 (Windows/Mac)', url: 'https://git-scm.com' }
      ]
    }
  }

  // Node.js/npm/yarn 관련 오류
  if (error.includes('yarn') || error.includes('npm') || error.includes('Node.js를 설치하세요')) {
    return {
      title: 'Node.js가 설치되지 않았습니다',
      message: '모의주식 사이트를 실행하기 위한 Node.js가 설치되어 있지 않습니다. 웹사이트 실행에 필요한 프로그램입니다.',
      solutions: [
        '1. 아래 링크에서 Node.js LTS 버전을 다운로드하여 설치해주세요',
        '2. 설치 시 모든 옵션을 기본값으로 두고 설치하세요',
        '3. 설치 후 반드시 컴퓨터를 재시작해주세요',
        '4. 재시작 후 다시 수업 시작을 눌러주세요'
      ],
      links: [
        { text: 'Node.js 다운로드 (LTS 버전)', url: 'https://nodejs.org' }
      ]
    }
  }

  // 의존성 설치 관련 오류
  if (error.includes('install') || error.includes('의존성') || error.includes('failed') || error.includes('ENOTFOUND')) {
    return {
      title: '인터넷 연결 또는 설치 오류',
      message: '필요한 파일들을 다운로드하는 중 문제가 발생했습니다.',
      solutions: [
        '1. 인터넷 연결 상태를 확인해주세요 (WiFi 또는 유선 연결)',
        '2. 방화벽이나 보안 프로그램이 차단하고 있지 않은지 확인해주세요',
        '3. 5분 후 다시 시도해주세요',
        '4. 문제가 계속되면 다른 네트워크에서 시도해보세요'
      ]
    }
  }

  // 권한 관련 오류
  if (error.includes('permission') || error.includes('권한') || error.includes('EACCES') || error.includes('access')) {
    return {
      title: '폴더 접근 권한 문제',
      message: '선택하신 폴더에 파일을 생성할 권한이 없습니다.',
      solutions: [
        '1. 다른 폴더를 선택해주세요 (바탕화면, 문서 폴더 등)',
        '2. 시스템 폴더(Program Files, Windows 등)는 선택하지 마세요',
        '3. 관리자 권한으로 프로그램을 실행해보세요',
        '4. 사용자 폴더 내의 일반적인 위치를 선택해주세요'
      ]
    }
  }

  // 포트 관련 오류  
  if (error.includes('port') || error.includes('EADDRINUSE') || error.includes('already in use')) {
    return {
      title: '다른 프로그램이 실행 중입니다',
      message: '모의주식 사이트가 사용하는 포트를 다른 프로그램이 사용하고 있습니다.',
      solutions: [
        '1. 다른 웹 서버나 개발 프로그램을 종료해주세요',
        '2. 웹 브라우저를 모두 닫고 다시 시도해주세요',
        '3. 컴퓨터를 재시작 후 다시 시도해주세요',
        '4. 실행 중인 다른 프로그램들을 확인하고 종료해주세요'
      ]
    }
  }

  return {
    title: '실행 중 예상치 못한 오류가 발생했습니다',
    message: '모의주식 사이트 실행 과정에서 알 수 없는 문제가 발생했습니다.',
    solutions: [
      '1. 프로그램을 완전히 종료하고 다시 실행해주세요',
      '2. 다른 실행 중인 프로그램들을 모두 종료해주세요',
      '3. 컴퓨터를 재시작 후 다시 시도해주세요',
      '4. 문제가 지속되면 IT 담당자에게 문의해주세요'
    ]
  }
}

const PROGRESS_STEPS = [
  { key: 'idle', name: '대기 중', icon: '⏸️' },
  { key: 'checking-tools', name: '환경 확인', icon: '🔍' },
  { key: 'preparing', name: '준비 중', icon: '📁' },
  { key: 'cloning', name: '파일 다운로드', icon: '⬇️' },
  { key: 'installing', name: '설치 중', icon: '⚙️' },
  { key: 'starting', name: '시작 중', icon: '🚀' },
  { key: 'running', name: '수업 진행 중', icon: '✅' },
  { key: 'error', name: '문제 발생', icon: '❌' }
]

export default function App() {
  const [logs, setLogs] = useState<string[]>([])
  const [dir, setDir] = useState<string>(() => {
    // 초기값으로 localStorage에서 이전에 선택한 폴더 불러오기
    return localStorage.getItem('mozu-workspace-dir') || ''
  })
  const [isRunning, setIsRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [currentStep, setCurrentStep] = useState<string>('idle')
  const [clientStatus, setClientStatus] = useState<{ step: string; message?: string }>({ step: 'idle' })
  const [localIP, setLocalIP] = useState<string>('localhost')

  useEffect(() => {
    const off = window.api.onStatusUpdate((s) => {
      setLogs(s.logs || [])
      setCurrentStep(s.step)
      setIsRunning(s.step === 'running')

      // 클라이언트 개별 상태 업데이트
      if (s.client) {
        setClientStatus(s.client)
      }

      if (s.step === 'error') {
        setError(s.message || '알 수 없는 오류가 발생했습니다.')
        setIsRunning(false)
      }
    })

    // IP 주소 가져오기
    window.api.getLocalIP().then(setLocalIP).catch(() => setLocalIP('localhost'))

    return () => off()
  }, [])

  const handleChooseDir = async () => {
    const picked = await window.api.chooseDir()
    if (picked) {
      setDir(picked)
      // 선택된 폴더를 localStorage에 저장하여 다음에 기본값으로 사용
      localStorage.setItem('mozu-workspace-dir', picked)
    }
    // 사용자가 취소한 경우(picked === null)는 아무 처리하지 않음
  }

  const start = async () => {
    // 입력 검증 강화
    if (dir && dir.trim()) {
      // 윈도우 경로 검증 (콜론은 드라이브 문자 다음에만 허용)
      const invalidChars = /[<>"|?*]/
      const hasInvalidChars = invalidChars.test(dir)
      const hasInvalidColon = dir.includes(':') && !(/^[A-Za-z]:\\/.test(dir) || dir.match(/^[A-Za-z]:[^:]*$/))

      if (hasInvalidChars || hasInvalidColon) {
        setError(JSON.stringify({
          title: '잘못된 폴더 경로',
          message: '폴더 경로에 사용할 수 없는 문자가 포함되어 있습니다.',
          solutions: [
            '1. 다른 폴더를 선택해주세요',
            '2. 폴더명에 특수문자(<, >, ", |, ?, *)가 없는 폴더를 선택해주세요',
            '3. 바탕화면이나 문서 폴더 같은 일반적인 위치를 선택해주세요'
          ]
        }))
        return
      }

      // 길이 검증 (Windows 경로 제한)
      if (dir.length > 260) {
        setError(JSON.stringify({
          title: '폴더 경로가 너무 깁니다',
          message: '선택하신 폴더 경로가 너무 깁니다.',
          solutions: [
            '1. 더 짧은 경로의 폴더를 선택해주세요',
            '2. 바탕화면이나 문서 폴더처럼 경로가 짧은 곳을 선택해주세요'
          ]
        }))
        return
      }
    }

    setError(null)
    setIsRunning(true)

    const payload: RepoCfg = {
      ...FIXED_CFG,
      workspaceDir: dir && dir.trim() ? dir.trim() : undefined,
    }

    const res = await window.api.startMock(payload)
    if (!res.ok) {
      const errorInfo = getErrorSolution(res.error || '')
      setError(JSON.stringify(errorInfo))
      setIsRunning(false)
    }
  }

  const startLesson = async () => {
    // 입력 검증 강화
    if (dir && dir.trim()) {
      // 윈도우 경로 검증 (콜론은 드라이브 문자 다음에만 허용)
      const invalidChars = /[<>"|?*]/
      const hasInvalidChars = invalidChars.test(dir)
      const hasInvalidColon = dir.includes(':') && !(/^[A-Za-z]:\\/.test(dir) || dir.match(/^[A-Za-z]:[^:]*$/))

      if (hasInvalidChars || hasInvalidColon) {
        setError(JSON.stringify({
          title: '잘못된 폴더 경로',
          message: '폴더 경로에 사용할 수 없는 문자가 포함되어 있습니다.',
          solutions: [
            '1. 다른 폴더를 선택해주세요',
            '2. 폴더명에 특수문자(<, >, ", |, ?, *)가 없는 폴더를 선택해주세요',
            '3. 바탕화면이나 문서 폴더 같은 일반적인 위치를 선택해주세요'
          ]
        }))
        return
      }

      // 길이 검증 (Windows 경로 제한)
      if (dir.length > 260) {
        setError(JSON.stringify({
          title: '폴더 경로가 너무 깁니다',
          message: '선택하신 폴더 경로가 너무 깁니다.',
          solutions: [
            '1. 더 짧은 경로의 폴더를 선택해주세요',
            '2. 바탕화면이나 문서 폴더처럼 경로가 짧은 곳을 선택해주세요'
          ]
        }))
        return
      }
    }

    setError(null)
    setIsRunning(true)

    const payload: RepoCfg = {
      ...FIXED_CFG,
      workspaceDir: dir && dir.trim() ? dir.trim() : undefined,
    }

    const res = await window.api.startLesson(payload)
    if (!res.ok) {
      const errorInfo = getErrorSolution(res.error || '')
      setError(JSON.stringify(errorInfo))
      setIsRunning(false)
    }
  }

  const stop = async () => {
    setIsRunning(false)
    setCurrentStep('idle')
    setError(null)
    setClientStatus({ step: 'idle' })
    await window.api.stopMock()
  }

  return (
    <div className="min-h-screen bg-[#FFF7F0] text-[#151515]">
      <header className="p-6 border-b bg-white">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src={logo} alt="Mozu On-Premise App Logo" className="w-10 h-10" />
            <div>
              <h1 className="text-xl font-bold">
                <span className="text-carrot">모주</span>
                <span className="text-xs text-[#71717A]">모의주식투자</span>
              </h1>
              <p className="text-sm text-gray-500">
                모의주식투자 환경을 원클릭으로 실행
                {dir ? <span className="ml-2 text-gray-400">(경로: {dir})</span> : null}
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={handleChooseDir} disabled={isRunning}>
              📁 {dir ? '저장 위치 변경' : '저장 위치 선택'}
            </Button>
            <Button
              onClick={startLesson}
              disabled={isRunning && currentStep !== 'error'}
              className={isRunning ? 'opacity-50 cursor-not-allowed' : ''}
            >
              {isRunning ?
                (currentStep === 'running' ? '✅ 실행 중' : '⏳ 준비 중...') :
                '🎓 수업 시작'
              }
            </Button>
            <Button
              variant="ghost"
              onClick={stop}
              disabled={!isRunning && currentStep === 'idle'}
              className={(!isRunning && currentStep === 'idle') ? 'opacity-50 cursor-not-allowed' : ''}
            >
              ⏹️ 수업 종료
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-6 space-y-6">
        {error && (() => {
          try {
            const errorInfo = JSON.parse(error)
            return (
              <section className="bg-red-50 border border-red-200 rounded-2xl p-6">
                <div className="flex items-start gap-3">
                  <div className="text-red-500 text-xl">⚠️</div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-red-800 mb-2">{errorInfo.title}</h3>
                    <p className="text-sm text-red-700 mb-3">{errorInfo.message}</p>

                    <div className="mb-3">
                      <h4 className="font-medium text-red-800 mb-2">해결 방법:</h4>
                      <ul className="text-sm text-red-700 space-y-1">
                        {errorInfo.solutions.map((solution: string, index: number) => (
                          <li key={index}>{solution}</li>
                        ))}
                      </ul>
                    </div>

                    {errorInfo.links && errorInfo.links.length > 0 && (
                      <div className="mb-3">
                        <h4 className="font-medium text-red-800 mb-2">다운로드 링크:</h4>
                        <div className="flex flex-wrap gap-2">
                          {errorInfo.links.map((link: { text: string; url: string }, index: number) => (
                            <button
                              key={index}
                              onClick={() => window.api.openExternal(link.url)}
                              className="px-3 py-1 bg-red-600 hover:bg-red-700 text-white rounded text-sm transition-colors"
                            >
                              {link.text}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    <button
                      onClick={() => setError(null)}
                      className="px-4 py-2 bg-red-100 hover:bg-red-200 text-red-800 rounded-md text-sm transition-colors"
                    >
                      확인
                    </button>
                  </div>
                </div>
              </section>
            )
          } catch {
            // JSON 파싱 실패 시 기존 방식으로 표시ㅣ
            return (
              <section className="bg-red-50 border border-red-200 rounded-2xl p-6">
                <div className="flex items-start gap-3">
                  <div className="text-red-500 text-xl">⚠️</div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-red-800 mb-2">문제가 발생했습니다</h3>
                    <pre className="text-sm text-red-700 whitespace-pre-wrap font-sans">{error}</pre>
                    <button
                      onClick={() => setError(null)}
                      className="mt-3 px-4 py-2 bg-red-100 hover:bg-red-200 text-red-800 rounded-md text-sm transition-colors"
                    >
                      확인
                    </button>
                  </div>
                </div>
              </section>
            )
          }
        })()}

        {currentStep !== 'idle' && (
          <section className="bg-white rounded-2xl p-6 shadow-soft">
            <h2 className="font-semibold mb-4">진행 상태</h2>
            <div className="flex items-center justify-between mb-4">
              {PROGRESS_STEPS.slice(1, -1).map((step, index) => {
                const isActive = step.key === currentStep
                const isCompleted = PROGRESS_STEPS.findIndex(s => s.key === currentStep) > index + 1
                const isError = currentStep === 'error'

                return (
                  <div key={step.key} className="flex flex-col items-center flex-1">
                    <div className={`
                      w-12 h-12 rounded-full flex items-center justify-center text-lg mb-2 transition-colors
                      ${isCompleted ? 'bg-green-100 text-green-600' :
                        isActive ? (isError ? 'bg-red-100 text-red-600' : 'bg-blue-100 text-blue-600') :
                          'bg-gray-100 text-gray-400'}
                    `}>
                      {isError && isActive ? '❌' : step.icon}
                    </div>
                    <span className={`text-xs text-center ${isCompleted ? 'text-green-600' :
                      isActive ? (isError ? 'text-red-600' : 'text-blue-600') :
                        'text-gray-400'
                      }`}>
                      {step.name}
                    </span>
                    {index < PROGRESS_STEPS.slice(1, -1).length - 1 && (
                      <div className={`
                        absolute h-0.5 w-16 mt-6 transition-colors
                        ${isCompleted ? 'bg-green-300' : 'bg-gray-200'}
                      `} style={{ marginLeft: '4rem' }} />
                    )}
                  </div>
                )
              })}
            </div>

            {currentStep === 'running' && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                <div className="flex items-center gap-2 mb-4">
                  <span className="text-green-600">✅</span>
                  <span className="font-bold text-green-800 text-lg">모의주식 수업이 시작되었습니다!</span>
                </div>

                <div className="bg-white rounded-lg p-4 mb-4">
                  <div className="text-green-800 font-semibold mb-3 text-center">📋 학생들에게 알려줄 웹사이트 주소</div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* 학생용 사이트 */}
                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-blue-600">👨‍🎓</span>
                        <span className="font-bold text-blue-800">학생용 사이트</span>
                      </div>
                      <div className="bg-white rounded border p-3 mb-2">
                        <code className="text-blue-700 font-mono text-sm break-all">{localIP}:3001</code>
                      </div>
                      <button
                        onClick={() => window.api.openExternal(`http://${localIP}:3001/signin`)}
                        className="w-full bg-blue-600 hover:bg-blue-700 text-white px-3 py-2 rounded text-sm font-medium transition-colors"
                      >
                        학생용 사이트 열기
                      </button>
                      <div className="text-xs text-blue-600 mt-2 text-center">
                        학생들이 모의주식 거래를 할 수 있는 사이트입니다
                      </div>
                    </div>

                    {/* 선생님용 관리자 사이트 */}
                    <div className="bg-purple-50 border border-purple-200 rounded-lg p-4">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-purple-600">👨‍🏫</span>
                        <span className="font-bold text-purple-800">선생님용 관리</span>
                      </div>
                      <div className="bg-white rounded border p-3 mb-2">
                        <code className="text-purple-700 font-mono text-sm break-all">admin.localhost:3002</code>
                      </div>
                      <button
                        onClick={() => window.api.openExternal('http://admin.localhost:3002/signin')}
                        className="w-full bg-purple-600 hover:bg-purple-700 text-white px-3 py-2 rounded text-sm font-medium transition-colors"
                      >
                        관리자 사이트 열기
                      </button>
                      <div className="text-xs text-purple-600 mt-2 text-center">
                        수업 현황과 학생 활동을 관리할 수 있는 사이트입니다
                      </div>
                    </div>
                  </div>
                </div>

                <div className="bg-green-100 border border-green-300 rounded-lg p-4">
                  <div className="flex items-start gap-2">
                    <span className="text-green-600 text-lg">💡</span>
                    <div className="flex-1">
                      <div className="font-semibold text-green-800 mb-2">수업 진행 안내</div>
                      <ul className="text-sm text-green-700 space-y-1">
                        <li>• <strong>학생용 주소</strong>를 칠판에 적어 학생들에게 알려주세요</li>
                        <li>• <strong>선생님용 관리 사이트</strong>에서 학생들의 거래 현황을 실시간으로 확인하세요</li>
                        <li>• 수업이 끝나면 반드시 <strong>"수업 종료"</strong> 버튼을 눌러주세요</li>
                        <li>• 학생들이 접속하는데 문제가 있으면 Wi-Fi 연결을 확인해주세요</li>
                      </ul>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </section>
        )}

        <section className="bg-white rounded-2xl p-6 shadow-soft">
          <h2 className="font-semibold mb-4">사용 방법</h2>
          <ol className="list-decimal pl-5 space-y-2 text-sm text-gray-700">
            <li><b>📁 저장 위치 선택</b> 버튼을 눌러 수업 파일이 저장될 폴더를 선택하세요.</li>
            <li><b>🎓 수업 시작</b> 버튼을 누르면 자동으로 모의주식 사이트가 준비됩니다.</li>
            <li>준비가 완료되면 학생들에게 웹사이트 주소를 알려주세요.</li>
            <li>수업이 끝나면 <b>⏹️ 수업 종료</b> 버튼을 눌러 마무리하세요.</li>
          </ol>
        </section>


        <section className="bg-white rounded-2xl p-6 shadow-soft">
          <div className="flex justify-between items-center mb-4">
            <h2 className="font-semibold">진행 상황</h2>
            <div className="flex gap-4 text-sm">
              <div className="flex items-center gap-2">
                <div className={`w-3 h-3 rounded-full ${clientStatus.step === 'running' ? 'bg-green-500' :
                  clientStatus.step === 'error' ? 'bg-red-500' :
                    clientStatus.step === 'building' || clientStatus.step === 'starting' ? 'bg-yellow-500' :
                      'bg-gray-300'
                  }`}></div>
                <span className="text-gray-700">
                  상태: {clientStatus.step === 'idle' ? '대기중' :
                    clientStatus.step === 'building' ? '웹사이트 준비중' :
                      clientStatus.step === 'starting' ? '모의주식 사이트 시작중' :
                        clientStatus.step === 'running' ? '✅ 수업 진행중 (학생 접속 가능)' :
                          clientStatus.step === 'error' ? '❌ 문제발생 - 재시작 필요' : clientStatus.step}
                  {clientStatus.message && (
                    <span className="block text-xs text-gray-500 mt-1">
                      📝 {clientStatus.message}
                    </span>
                  )}
                </span>
              </div>
            </div>
          </div>
          <LogPanel lines={logs} />
          <p className="text-xs text-gray-500 mt-3">
            {dir ? (
              <>
                수업 파일 저장 위치: <code className="bg-gray-100 px-2 py-1 rounded text-sm break-all">{dir}</code>
                <br />
                <span className="text-xs text-gray-600">
                  💾 이 위치에 수업용 파일들이 저장됩니다
                </span>
              </>
            ) : (
              <span className="text-amber-600">
                ⚠️ 저장 위치를 선택해주세요 (선택하지 않으면 기본 위치에 저장됩니다)
              </span>
            )}
          </p>
        </section>
      </main>
    </div>
  )
}