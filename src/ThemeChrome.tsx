import { useState } from 'react'
import { IconButton } from './ui.tsx'
import { icon } from './icons.ts'
import { readThemeMode, toggleThemeMode, type ThemeMode } from './themeMode.ts'

/** Brand backdrop behind the hero; each company skin paints it in brand-skins.css. */
export function AmbientBackground() {
  return <div className="ambient" aria-hidden />
}

export function ThemeControls() {
  const [mode, setMode] = useState<ThemeMode>(() => readThemeMode())
  return (
    <div className="appbar-actions">
      <IconButton
        icon={mode === 'dark' ? icon.lightMode : icon.darkMode}
        aria-label={mode === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        title={mode === 'dark' ? 'Light theme' : 'Dark theme'}
        onClick={() => setMode(toggleThemeMode())}
      />
    </div>
  )
}
