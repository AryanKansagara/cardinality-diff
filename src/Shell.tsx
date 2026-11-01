import type { ReactNode } from 'react'
import { TopAppBar } from 'material/react'
import { AmbientBackground, ThemeControls } from './ThemeChrome.tsx'

export function Shell({
  name,
  tagline,
  children,
}: {
  name: string
  tagline: string
  icon?: string
  children: ReactNode
}) {
  return (
    <>
      <AmbientBackground />
      <TopAppBar type="center" headline={name} no-scroll trailing={<ThemeControls />} />
      <p className="shell-tagline muted">{tagline}</p>
      <main className="container">{children}</main>
      <footer className="container footer muted">
        Built by <a href="https://github.com/AryanKansagara">Aryan Kansagara</a>. Independent project, not affiliated with the vendor.
      </footer>
    </>
  )
}
