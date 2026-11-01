import { useEffect, useState, type ReactNode } from 'react'

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
    <button className="tool-back" onClick={() => go('/')}>
      <span className="material-symbols-outlined" style={{ fontSize: 18 }}>arrow_back</span>
      {label}
    </button>
  )
}

export function RouteApp({ landing, tool }: { landing: ReactNode; tool: ReactNode }) {
  const path = usePath()
  if (path === '/app' || path.startsWith('/app/')) return <>{tool}</>
  return <>{landing}</>
}
