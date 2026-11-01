import { useState, type ReactNode } from 'react'
import { IconButton, Menu, MenuItem } from 'material/react'
import { icon } from './icons.ts'
import {
  applyThemeId,
  applyThemeMode,
  readThemeId,
  readThemeMode,
  THEMES,
  type ThemeId,
  type ThemeMode,
} from './themeMode.ts'

export function AmbientBackground() {
  return (
    <div className="ambient" aria-hidden>
      <span className="ambient-blob a" />
      <span className="ambient-blob b" />
      <span className="ambient-blob c" />
    </div>
  )
}

export function ThemeControls() {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [mode, setMode] = useState<ThemeMode>(() => readThemeMode())
  const [theme, setTheme] = useState<ThemeId>(() => readThemeId())
  const [open, setOpen] = useState(false)

  const toggleMode = () => {
    const next: ThemeMode = mode === 'dark' ? 'light' : 'dark'
    applyThemeMode(next)
    setMode(next)
  }

  return (
    <div className="appbar-actions">
      <IconButton
        ref={setAnchor}
        variant="standard"
        icon={icon.monitoring}
        aria-label="Choose color theme"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      />
      <Menu
        open={open}
        anchor={anchor ?? undefined}
        position="bottom-end"
        aria-label="Color themes"
        onClose={() => setOpen(false)}
        onSelect={(e) => {
          const value = (e as CustomEvent<{ value?: string }>).detail?.value as ThemeId | undefined
          if (!value || !THEMES.some((t) => t.id === value)) return
          setTheme(value)
          applyThemeId(value)
          setOpen(false)
        }}
      >
        {THEMES.map((t) => (
          <MenuItem
            key={t.id}
            value={t.id}
            label={t.label}
            supporting-text={t.hint}
            icon={theme === t.id ? icon.play : undefined}
          />
        ))}
      </Menu>
      <IconButton
        variant="standard"
        icon={mode === 'dark' ? icon.lightMode : icon.darkMode}
        aria-label={mode === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        onClick={toggleMode}
      />
    </div>
  )
}

export function withAmbient(children: ReactNode) {
  return (
    <>
      <AmbientBackground />
      {children}
    </>
  )
}
