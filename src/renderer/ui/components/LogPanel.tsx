import React, { useEffect, useRef, useState } from 'react'

interface LogPanelProps {
  lines: string[]
}

export const LogPanel: React.FC<LogPanelProps> = ({ lines }) => {
  const ref = useRef<HTMLDivElement>(null)
  const [isAutoScroll, setIsAutoScroll] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')

  useEffect(() => {
    if (isAutoScroll && ref.current) {
      ref.current.scrollTo({ top: ref.current.scrollHeight, behavior: 'smooth' })
    }
  }, [lines.length, isAutoScroll])

  const handleScroll = () => {
    if (ref.current) {
      const { scrollTop, scrollHeight, clientHeight } = ref.current
      const isAtBottom = Math.abs(scrollHeight - clientHeight - scrollTop) < 10
      setIsAutoScroll(isAtBottom)
    }
  }

  const scrollToBottom = () => {
    if (ref.current) {
      ref.current.scrollTo({ top: ref.current.scrollHeight, behavior: 'smooth' })
      setIsAutoScroll(true)
    }
  }


  const getLogLevel = (line: string) => {
    if (line.includes('[ERROR]') || line.toLowerCase().includes('error')) return 'error'
    if (line.includes('[WARN]') || line.toLowerCase().includes('warn')) return 'warn'
    if (line.includes('[INFO]') || line.toLowerCase().includes('info')) return 'info'
    if (line.includes('[DEBUG]') || line.toLowerCase().includes('debug')) return 'debug'
    return 'default'
  }

  const getLogColor = (level: string) => {
    switch (level) {
      case 'error': return 'text-red-400'
      case 'warn': return 'text-yellow-400'
      case 'info': return 'text-blue-400'
      case 'debug': return 'text-gray-400'
      default: return 'text-green-200'
    }
  }

  const filteredLines = lines.filter(line =>
    searchTerm === '' || line.toLowerCase().includes(searchTerm.toLowerCase())
  )

  return (
    <div className="flex flex-col h-full">
      {/* 로그 패널 헤더 */}
      <div className="flex items-center justify-between p-3 bg-gray-800 rounded-t-2xl border-b border-gray-600">
        <h3 className="text-white font-semibold">서버 로그</h3>
        <div className="flex items-center gap-2">
          {/* 검색 입력 */}
          <input
            type="text"
            placeholder="로그 검색..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="px-2 py-1 text-sm bg-gray-700 text-white rounded border border-gray-600 focus:border-blue-500 focus:outline-none"
          />
          
          {/* 자동 스크롤 토글 */}
          <button
            onClick={() => setIsAutoScroll(!isAutoScroll)}
            className={`px-2 py-1 text-xs rounded ${
              isAutoScroll 
                ? 'bg-green-600 text-white' 
                : 'bg-gray-600 text-gray-300'
            }`}
            title={isAutoScroll ? '자동 스크롤 활성화' : '자동 스크롤 비활성화'}
          >
            자동스크롤
          </button>
          
          {/* 맨 아래로 스크롤 */}
          <button
            onClick={scrollToBottom}
            className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
            title="맨 아래로 스크롤"
          >
            ↓
          </button>
        </div>
      </div>

      {/* 로그 내용 */}
      <div
        ref={ref}
        onScroll={handleScroll}
        className="
          flex-1
          min-h-[360px]
          max-h-[70vh]
          overflow-auto
          bg-black
          rounded-b-2xl p-4
          font-mono text-sm
          scrollbar-thin scrollbar-track-gray-800 scrollbar-thumb-gray-600
        "
      >
        {filteredLines.length === 0 && searchTerm ? (
          <div className="text-gray-500 italic">검색 결과가 없습니다.</div>
        ) : (
          filteredLines.map((line, i) => {
            const level = getLogLevel(line)
            const color = getLogColor(level)
            return (
              <div key={i} className={`${color} mb-1 leading-relaxed`}>
                {/* 타임스탬프나 로그 레벨을 하이라이트 */}
                {line.includes('[') && line.includes(']') ? (
                  <span>
                    {line.split(/(\[[^\]]+\])/).map((part, idx) => (
                      <span key={idx} className={part.startsWith('[') && part.endsWith(']') ? 'font-bold' : ''}>
                        {part}
                      </span>
                    ))}
                  </span>
                ) : (
                  line
                )}
              </div>
            )
          })
        )}
        
        {/* 검색된 결과 개수 표시 */}
        {searchTerm && (
          <div className="text-gray-500 text-xs mt-2 border-t border-gray-700 pt-2">
            {filteredLines.length}개의 검색 결과 (전체 {lines.length}개 중)
          </div>
        )}
      </div>

      {/* 자동 스크롤이 비활성화된 경우 알림 */}
      {!isAutoScroll && (
        <div className="px-3 py-1 bg-yellow-600 text-white text-xs text-center">
          자동 스크롤이 비활성화되었습니다. 새 로그를 보려면 스크롤하세요.
        </div>
      )}
    </div>
  )
}
