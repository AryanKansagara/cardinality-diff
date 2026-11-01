import type { ButtonHTMLAttributes } from 'react'

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; icon?: string }

const Icon = ({ svg }: { svg?: string }) =>
  svg ? <span className="btn-icon" aria-hidden dangerouslySetInnerHTML={{ __html: svg }} /> : null

export function Button({ variant = 'filled', icon, children, className = '', ...rest }: Props) {
  return (
    <button type="button" className={`btn btn--${variant} ${className}`} {...rest}>
      <Icon svg={icon} />
      {children}
    </button>
  )
}

export function IconButton({ variant = 'standard', icon, className = '', ...rest }: Props) {
  return (
    <button type="button" className={`icon-btn icon-btn--${variant} ${className}`} {...rest}>
      <Icon svg={icon} />
    </button>
  )
}
