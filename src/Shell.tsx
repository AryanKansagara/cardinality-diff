import { useState, type ReactNode } from 'react'

export function Shell({
  name,
  tagline,
  icon = 'analytics',
  children,
}: {
  name: string
  tagline: string
  icon?: string
  children: ReactNode
}) {
  const [theme, setTheme] = useState(document.documentElement.dataset.theme ?? 'light')
  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    localStorage.setItem('theme', next)
    setTheme(next)
  }
  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>
            <span className="material-symbols-outlined">{icon}</span>
          </span>
          <div>
            <strong>{name}</strong>
            <span className="muted tagline">{tagline}</span>
          </div>
        </div>
        <button className="theme-toggle" onClick={toggle} aria-label="Toggle theme" title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}>
          <span className="material-symbols-outlined">{theme === 'dark' ? 'light_mode' : 'dark_mode'}</span>
        </button>
      </header>
      <main className="container">{children}</main>
      <footer className="container footer muted">
        Built by <a href="https://github.com/AryanKansagara">Aryan Kansagara</a>. Independent project, not affiliated with the vendor.
      </footer>
    </>
  )
}
