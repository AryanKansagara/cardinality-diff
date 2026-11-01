export type ThemeMode = 'light' | 'dark'

export type ThemeOption = { id: string; label: string; hint: string }

export const BRAND = 'grafana' as const
export const STORAGE_PREFIX = 'cd'
export const DEFAULT_THEME = 'brand'

export const THEMES: ThemeOption[] = [
  { id: 'brand', label: 'Grafana', hint: 'grafana.com orange' },
  { id: 'expressive', label: 'Aurora', hint: 'Teal + orchid' },
  { id: 'vibrant', label: 'Nova', hint: 'Bright violet' },
  { id: 'ocean', label: 'Tide', hint: 'Cool blue' },
  { id: 'sunset', label: 'Dusk', hint: 'Warm coral' },
  { id: 'forest', label: 'Grove', hint: 'Moss green' },
]

export type ThemeId = string

const MODE_KEY = `${STORAGE_PREFIX}:themeMode`
const THEME_KEY = `${STORAGE_PREFIX}:colorTheme`

export function readThemeMode(): ThemeMode {
  const saved = localStorage.getItem(MODE_KEY) as ThemeMode | null
  if (saved === 'light' || saved === 'dark') return saved
  // Match the company site’s default look when visitor has no preference stored
  return 'dark'
}

export function readThemeId(): ThemeId {
  const saved = localStorage.getItem(THEME_KEY)
  if (saved && THEMES.some((t) => t.id === saved)) return saved
  return DEFAULT_THEME
}

export function applyTheme(theme: ThemeId, mode: ThemeMode) {
  document.documentElement.dataset.brand = BRAND
  document.documentElement.dataset.theme = theme
  document.documentElement.dataset.themeMode = mode
  localStorage.setItem(THEME_KEY, theme)
  localStorage.setItem(MODE_KEY, mode)
}

export function applyThemeMode(mode: ThemeMode) {
  applyTheme(readThemeId(), mode)
}

export function applyThemeId(theme: ThemeId) {
  applyTheme(theme, readThemeMode())
}

export function toggleThemeMode(): ThemeMode {
  const next: ThemeMode = readThemeMode() === 'dark' ? 'light' : 'dark'
  applyThemeMode(next)
  return next
}
