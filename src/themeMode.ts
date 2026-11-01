export type ThemeMode = 'light' | 'dark'

const KEY = 'themeMode'

export function readThemeMode(): ThemeMode {
  const saved = localStorage.getItem(KEY)
  if (saved === 'light' || saved === 'dark') return saved
  // Default to the mode the company's own website ships with.
  return document.documentElement.dataset.defaultMode === 'light' ? 'light' : 'dark'
}

export function applyThemeMode(mode: ThemeMode) {
  document.documentElement.dataset.themeMode = mode
  localStorage.setItem(KEY, mode)
}

export function toggleThemeMode(): ThemeMode {
  const next: ThemeMode = readThemeMode() === 'dark' ? 'light' : 'dark'
  applyThemeMode(next)
  return next
}
