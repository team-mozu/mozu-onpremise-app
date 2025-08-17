
import React from 'react'

type Props = React.InputHTMLAttributes<HTMLInputElement> & { label: string }
export const Field: React.FC<Props> = ({ label, ...rest }) => {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm text-gray-600">{label}</span>
      <input {...rest} className="px-3 py-2 rounded-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-carrot" />
    </label>
  )
}
