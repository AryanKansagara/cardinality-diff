import type { ReactNode } from 'react'
import { BrandMark } from './Landing.tsx'
import { ThemeControls } from './ThemeChrome.tsx'

export function Shell({ name, tagline, children }: { name: string; tagline: string; icon?: string; children: ReactNode }) {
  return (
    <>
      <header className="topbar">
        <a className="brand" href="/">
          <BrandMark />
          <div>
            <strong>{name}</strong>
            <span className="muted tagline">{tagline}</span>
          </div>
        </a>
        <ThemeControls />
      </header>
      <main className="container">{children}</main>
      <footer className="container footer muted">
        Built by <a href="https://github.com/AryanKansagara">Aryan Kansagara</a>. Independent project, not affiliated with the vendor.
      </footer>
    </>
  )
}
