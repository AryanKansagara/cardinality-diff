import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'material/styles'
import 'material/styles/typography'
import 'material/themes/expressive'
import 'material/themes/vibrant'
import 'material/themes/ocean'
import 'material/themes/sunset'
import 'material/themes/forest'
import './brand-themes.css'
import './theme.css'
import { applyTheme, readThemeId, readThemeMode } from './themeMode.ts'
import App from './App.tsx'

applyTheme(readThemeId(), readThemeMode())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

