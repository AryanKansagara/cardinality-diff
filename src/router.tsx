import { useEffect, useState, type ReactNode } from 'react'
import { Button } from './ui.tsx'
import { icon } from './icons.ts'

export function usePath() {
  const [path, setPath] = useState(() => location.pathname)
  useEffect(() => {
    const onPop = () => setPath(location.pathname)
    addEventListener('popstate', onPop)
    return () => removeEventListener('popstate', onPop)
  }, [])
  return path
}

export function go(href: string) {
  history.pushState({}, '', href)
  dispatchEvent(new PopStateEvent('popstate'))
}

export function BackToHome({ label = 'Back to home' }: { label?: string }) {
  return (
    <div className="tool-back-wrap">
      <Button variant="text" icon={icon.arrowBack} onClick={() => go('/')}>
        {label}
      </Button>
    </div>
  )
}

export function RouteApp({ landing, tool }: { landing: ReactNode; tool: ReactNode }) {
  const path = usePath()
  if (path === '/app' || path.startsWith('/app/')) return <>{tool}</>
  return <>{landing}</>
}
