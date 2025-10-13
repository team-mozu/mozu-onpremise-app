import React, { useEffect, useState } from 'react'
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
      stopMock: () => Promise<{ ok: boolean }>
      openExternal: (url: string) => Promise<void>
      onStatusUpdate: (cb: (status: LaunchStatus) => void) => () => void
    }
  }
}

// 하드코딩된 설정 (필요시 여기만 수정)
const FIXED_CFG: RepoCfg = {
  server: {
    url: 'https://github.com/team-mozu/mozu-BE-v2.git',
    branch: 'develop',
    startCommand: './gradlew bootRun',
    installCommand: './gradlew build',
    cwdName: 'server',
  },
  frontend: {
    url: 'https://github.com/team-mozu/mozu-FE.git',
    branch: 'main',
    startCommand: 'yarn dev',
    installCommand: 'yarn install',
    cwdName: 'frontend',
    devUrl: 'http://localhost:3000',
  },
}

function getErrorSolution(error: string): { title: string; message: string; solutions: string[]; links?: { text: string; url: string }[] } {
  if (error.includes('Access denied') || error.includes('password')) {
    return {
      title: '데이터베이스 접속 실패',
      message: '데이터베이스에 접속할 수 없습니다.',
      solutions: [
        '1. 데이터베이스 비밀번호를 다시 확인해주세요',
        '2. 비밀번호를 설정하지 않았다면 입력창을 비워두세요',
        '3. MySQL이 실행 중인지 확인해주세요'
      ]
    }
  }

  if (error.includes('git') || error.includes('설치되지 않았거나')) {
    return {
      title: '필요한 프로그램이 없습니다',
      message: '모의주식 환경을 실행하기 위한 프로그램이 설치되어 있지 않습니다.',
      solutions: [
        '1. Git 프로그램을 설치해주세요',
        '2. Node.js를 설치해주세요',
        '3. Java JDK 17 이상을 설치해주세요',
        '4. 설치 후 컴퓨터를 재시작해주세요'
      ],
      links: [
        { text: 'Git 다운로드', url: 'https://git-scm.com' },
        { text: 'Node.js 다운로드', url: 'https://nodejs.org' },
        { text: 'Java JDK 다운로드', url: 'https://adoptium.net' }
      ]
    }
  }

  if (error.includes('Java') || error.includes('JDK')) {
    return {
      title: 'Java 개발 환경이 필요합니다',
      message: 'Kotlin Spring Boot 서버 실행을 위해 Java가 필요합니다.',
      solutions: [
        '1. Java JDK 17 이상을 설치해주세요',
        '2. JAVA_HOME 환경변수가 올바르게 설정되어 있는지 확인해주세요',
        '3. 터미널에서 "java --version" 명령어가 작동하는지 확인해주세요'
      ],
      links: [
        { text: 'Java JDK 다운로드', url: 'https://adoptium.net' }
      ]
    }
  }

  if (error.includes('gradle') || error.includes('Gradle')) {
    return {
      title: 'Gradle 빌드 오류',
      message: 'Kotlin Spring Boot 프로젝트 빌드 중 오류가 발생했습니다.',
      solutions: [
        '1. Java JDK가 올바르게 설치되어 있는지 확인해주세요',
        '2. 인터넷 연결을 확인하고 다시 시도해주세요',
        '3. 프로젝트 폴더를 삭제하고 다시 다운로드해보세요'
      ]
    }
  }

  if (error.includes('mysql') || error.includes('MySQL')) {
    return {
      title: 'MySQL 데이터베이스 오류',
      message: '데이터베이스 시스템에 문제가 있습니다.',
      solutions: [
        '1. MySQL이 설치되어 있는지 확인해주세요',
        '2. MySQL 서비스가 실행 중인지 확인해주세요',
        '3. 관리자 권한으로 프로그램을 실행해보세요'
      ]
    }
  }

  return {
    title: '실행 중 오류 발생',
    message: '예상치 못한 오류가 발생했습니다.',
    solutions: [
      '1. 프로그램을 종료 후 다시 실행해주세요',
      '2. 다른 프로그램들을 종료 후 재시도해주세요',
      '3. 컴퓨터를 재시작 후 다시 시도해주세요'
    ]
  }
}

const PROGRESS_STEPS = [
  { key: 'idle', name: '대기 중', icon: '⏸️' },
  { key: 'checking-tools', name: '환경 확인', icon: '🔍' },
  { key: 'preparing', name: '준비 중', icon: '📁' },
  { key: 'cloning', name: '파일 다운로드', icon: '⬇️' },
  { key: 'installing', name: '빌드 및 설치', icon: '⚙️' },
  { key: 'starting', name: '서버 시작', icon: '🚀' },
  { key: 'running', name: '실행 중', icon: '✅' },
  { key: 'error', name: '오류 발생', icon: '❌' }
]

export default function App() {
  const [logs, setLogs] = useState<string[]>([])
  const [dir, setDir] = useState<string>(() => {
    // 초기값으로 localStorage에서 이전에 선택한 폴더 불러오기
    return localStorage.getItem('mozu-workspace-dir') || ''
  })
  const [dbPassword, setDbPassword] = useState('')
  const [isRunning, setIsRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [currentStep, setCurrentStep] = useState<string>('idle')
  const [serverStatus, setServerStatus] = useState<{ step: string; message?: string }>({ step: 'idle' })
  const [clientStatus, setClientStatus] = useState<{ step: string; message?: string }>({ step: 'idle' })
  const [showMysqlHelp, setShowMysqlHelp] = useState(false)

  useEffect(() => {
    const off = window.api.onStatusUpdate((s) => {
      setLogs(s.logs || [])
      setCurrentStep(s.step)
      setIsRunning(s.step === 'running')

      // 서버와 클라이언트 개별 상태 업데이트
      if (s.server) {
        setServerStatus(s.server)
      }
      if (s.client) {
        setClientStatus(s.client)
      }

      if (s.step === 'error') {
        setError(s.message || '알 수 없는 오류가 발생했습니다.')
        setIsRunning(false)
      }
    })
    return () => off()
  }, [])

  const handleChooseDir = async () => {
    const picked = await window.api.chooseDir()
    if (picked) {
      setDir(picked)
      // 선택된 폴더를 localStorage에 저장하여 다음에 기본값으로 사용
      localStorage.setItem('mozu-workspace-dir', picked)
    } else {
      // 권한 문제나 취소 시 사용자에게 알림
      setError(JSON.stringify({
        title: '폴더 선택 실패',
        message: '폴더를 선택할 수 없습니다.',
        solutions: [
          '1. 다른 폴더를 선택해주세요',
          '2. 폴더에 읽기/쓰기 권한이 있는지 확인해주세요',
          '3. 시스템 폴더가 아닌 일반 폴더를 선택해주세요'
        ]
      }))
    }
  }

  const start = async () => {
    setError(null)
    setIsRunning(true)

    const payload: RepoCfg = {
      ...FIXED_CFG,
      server: {
        ...FIXED_CFG.server,
        dbPassword: dbPassword || undefined,
      },
      workspaceDir: dir || undefined,
    }

    const res = await window.api.startMock(payload)
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
            <Button variant="ghost" onClick={handleChooseDir} disabled={isRunning}>
              📁 {dir ? '저장 위치 변경' : '저장 위치 선택'}
            </Button>
            <Button
              onClick={start}
              disabled={isRunning && currentStep !== 'error'}
              className={isRunning ? 'opacity-50 cursor-not-allowed' : ''}
            >
              {isRunning ?
                (currentStep === 'running' ? '✅ 실행 중' : '⏳ 준비 중...') :
                '🚀 모의주식 실습환경 시작'
              }
            </Button>
            <Button
              variant="ghost"
              onClick={stop}
              disabled={!isRunning && currentStep === 'idle'}
              className={(!isRunning && currentStep === 'idle') ? 'opacity-50 cursor-not-allowed' : ''}
            >
              🛑 실습환경 중지
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
            // JSON 파싱 실패 시 기존 방식으로 표시
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
                <div className="flex items-center gap-2">
                  <span className="text-green-600">🟢</span>
                  <span className="font-medium text-green-800">모의주식 환경이 실행되었습니다!</span>
                </div>
                <div className="mt-3 space-y-2 text-sm text-green-700">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="bg-white bg-opacity-60 rounded p-3">
                      <div className="font-medium text-green-800 mb-1">👨‍🏫 선생님용 (관리자)</div>
                      <a
                        href="http://admin.localhost:3002"
                        onClick={(e) => { e.preventDefault(); window.api.openExternal('http://admin.localhost:3002'); }}
                        className="text-blue-600 hover:text-blue-800 underline font-mono text-xs"
                      >
                        http://admin.localhost:3002
                      </a>
                      <div className="text-xs text-gray-600 mt-1">수업 관리, 학생 모니터링</div>
                    </div>
                    <div className="bg-white bg-opacity-60 rounded p-3">
                      <div className="font-medium text-green-800 mb-1">🎓 학생용</div>
                      <a
                        href="http://student.localhost:3001"
                        onClick={(e) => { e.preventDefault(); window.api.openExternal('http://student.localhost:3001'); }}
                        className="text-blue-600 hover:text-blue-800 underline font-mono text-xs"
                      >
                        http://student.localhost:3001
                      </a>
                      <div className="text-xs text-gray-600 mt-1">모의주식 거래 실습</div>
                    </div>
                  </div>
                  <div className="text-xs text-gray-600 bg-white bg-opacity-40 rounded p-2 mt-2">
                    💡 <strong>팁:</strong> 위 링크를 클릭하면 자동으로 브라우저에서 열립니다.
                    학생들에게는 <strong>http://student.localhost:3001</strong> 주소를 안내해주세요.
                  </div>
                </div>
              </div>
            )}
          </section>
        )}

        <section className="bg-white rounded-2xl p-6 shadow-soft">
          <h2 className="font-semibold mb-4">사용 가이드</h2>
          <ol className="list-decimal pl-5 space-y-2 text-sm text-gray-700">
            <li><b>데이터베이스 비밀번호</b>를 입력하세요. (설정하지 않았다면 비워두세요)</li>
            <li><b>📁 저장 위치 선택</b> 버튼으로 프로젝트가 저장될 폴더를 선택하세요.</li>
            <li><b>🚀 모의주식 실습환경 시작</b>을 누르면 자동으로 다운로드 → 설치 → 실행됩니다.</li>
            <li>실행 후 학생들이 접속할 수 있는 웹사이트가 자동으로 열립니다.</li>
          </ol>
        </section>

        <section className="bg-white rounded-2xl p-6 shadow-soft">
          <h2 className="font-semibold mb-4">환경 설정</h2>
          <div>
            <label htmlFor="db-password" className="block text-sm font-medium text-gray-700 mb-1">
              데이터베이스 관리자 비밀번호
            </label>
            <input
              type="password"
              id="db-password"
              value={dbPassword}
              onChange={(e) => setDbPassword(e.target.value)}
              className="block w-full max-w-sm px-3 py-2 bg-white border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-carrot focus:border-carrot sm:text-sm"
              placeholder="컴퓨터에 설정된 데이터베이스 비밀번호"
            />
            <div className="flex items-center justify-between mt-1">
              <p className="text-xs text-gray-500">
                컴퓨터에 설치된 MySQL 데이터베이스의 관리자 비밀번호를 입력하세요. 처음 설치했다면 비워두셔도 됩니다.
              </p>
              <button
                onClick={() => setShowMysqlHelp(!showMysqlHelp)}
                className="text-xs text-blue-600 hover:text-blue-800 ml-4"
              >
                {showMysqlHelp ? '도움말 닫기' : 'MySQL 도움말'}
              </button>
            </div>

            {showMysqlHelp && (
              <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
                <h4 className="font-medium text-blue-900 mb-2">💡 MySQL이 설치되지 않았나요?</h4>
                <div className="text-sm text-blue-800 space-y-2">
                  <p><strong>macOS 사용자:</strong></p>
                  <ol className="list-decimal pl-5 space-y-1">
                    <li>터미널을 열고 <code className="bg-blue-100 px-1 rounded">brew install mysql</code> 실행</li>
                    <li><code className="bg-blue-100 px-1 rounded">brew services start mysql</code> 로 MySQL 시작</li>
                    <li>비밀번호는 비워두고 실행해보세요</li>
                  </ol>

                  <p className="mt-3"><strong>Windows 사용자:</strong></p>
                  <ol className="list-decimal pl-5 space-y-1">
                    <li>이 앱이 자동으로 MySQL을 설치하려고 시도합니다</li>
                    <li>관리자 권한 요청이 나오면 '예'를 클릭해주세요</li>
                    <li>설치 완료 후 비밀번호는 비워두고 실행해보세요</li>
                  </ol>

                  <p className="mt-3"><strong>추가 요구사항:</strong></p>
                  <ol className="list-decimal pl-5 space-y-1">
                    <li>Java JDK 17 이상 설치 (Kotlin Spring Boot 서버용)</li>
                    <li>macOS: <code className="bg-blue-100 px-1 rounded">brew install openjdk@17</code></li>
                    <li>Windows: <button onClick={() => window.api.openExternal('https://adoptium.net')} className="text-blue-600 underline hover:text-blue-800">adoptium.net</button>에서 다운로드</li>
                  </ol>

                  <p className="mt-3 text-blue-600">
                    <strong>💡 팁:</strong> 대부분의 경우 처음 설치 시 비밀번호는 비워두셔도 됩니다.
                  </p>
                </div>
              </div>
            )}
          </div>
        </section>

        <section className="bg-white rounded-2xl p-6 shadow-soft">
          <div className="flex justify-between items-center mb-4">
            <h2 className="font-semibold">실행 상태</h2>
            <div className="flex gap-4 text-sm">
              <div className="flex items-center gap-2">
                <div className={`w-3 h-3 rounded-full ${serverStatus.step === 'running' ? 'bg-green-500' :
                  serverStatus.step === 'error' ? 'bg-red-500' :
                    serverStatus.step === 'building' || serverStatus.step === 'starting' ? 'bg-yellow-500' :
                      'bg-gray-300'
                  }`}></div>
                <span className="text-gray-700">
                  서버: {serverStatus.step === 'idle' ? '대기중' :
                    serverStatus.step === 'building' ? '빌드중' :
                      serverStatus.step === 'starting' ? '시작중' :
                        serverStatus.step === 'running' ? '실행중' :
                          serverStatus.step === 'error' ? '오류' : serverStatus.step}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <div className={`w-3 h-3 rounded-full ${clientStatus.step === 'running' ? 'bg-green-500' :
                  clientStatus.step === 'error' ? 'bg-red-500' :
                    clientStatus.step === 'building' || clientStatus.step === 'starting' ? 'bg-yellow-500' :
                      'bg-gray-300'
                  }`}></div>
                <span className="text-gray-700">
                  클라이언트: {clientStatus.step === 'idle' ? '대기중' :
                    clientStatus.step === 'building' ? '빌드중' :
                      clientStatus.step === 'starting' ? '시작중' :
                        clientStatus.step === 'running' ? '실행중' :
                          clientStatus.step === 'error' ? '오류' : clientStatus.step}
                </span>
              </div>
            </div>
          </div>
          <LogPanel lines={logs} />
          <p className="text-xs text-gray-500 mt-3">
            {dir ? (
              <>
                프로젝트 저장 위치: <code className="bg-gray-100 px-2 py-1 rounded text-sm break-all">{dir}</code>
                <br />
                <span className="text-xs text-gray-600">
                  💾 이 위치에 server, frontend 폴더가 생성됩니다
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