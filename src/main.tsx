import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'material/styles'
import 'material/styles/typography'
import './brand-themes.css'
import './theme.css'
import './brand-skins.css'
import { applyThemeMode, readThemeMode } from './themeMode.ts'
import App from './App.tsx'

applyThemeMode(readThemeMode())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

