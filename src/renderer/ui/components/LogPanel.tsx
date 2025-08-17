import React, { useEffect, useRef } from 'react'

export const LogPanel: React.FC<{ lines: string[] }> = ({ lines }) => {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: 'smooth' })
  }, [lines.length])
  return (
    <div
      ref={ref}
      className="
        min-h-[360px]
        h-[55vh]
        max-h-[70vh]
        overflow-auto
        bg-black text-green-200
        rounded-2xl p-4
        font-mono text-sm
      "
    >
      {lines.map((l, i) => <div key={i}>{l}</div>)}
    </div>
  )
}
