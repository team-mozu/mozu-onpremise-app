import React from 'react'

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' }
export const Button: React.FC<Props> = ({ variant='primary', className='', ...props }) => {
  const base = 'px-4 py-2 rounded-2xl font-semibold transition shadow-soft'
  const theme = variant === 'primary'
    ? 'bg-carrot text-white hover:opacity-90'
    : 'bg-white text-carrot border border-carrot hover:bg-orange-50'
  return <button {...props} className={`${base} ${theme} ${className}`} />
}
