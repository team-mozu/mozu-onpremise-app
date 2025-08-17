
import React from 'react'

type Props = { index: number, title: string, active?: boolean, done?: boolean }
export const Step: React.FC<Props> = ({ index, title, active, done }) => {
  const dot = done ? 'bg-carrot' : active ? 'border-2 border-carrot' : 'bg-gray-300'
  const text = done ? 'text-carrot' : active ? 'text-carrot' : 'text-gray-500'
  return (
    <div className="flex items-center gap-3">
      <div className={`w-4 h-4 rounded-full ${dot}`} />
      <div className={`text-sm ${text}`}>{index}. {title}</div>
    </div>
  )
}
