import { useEffect, useState, type ReactNode } from 'react'

export type Slide = { title: string; caption: string; preview: ReactNode }
export type LandingProps = {
  name: string
  icon: string
  tagline: string
  headline: string
  support: string
  audience: string
  features: { icon: string; title: string; body: string }[]
  slides: Slide[]
  tryHref?: string
}

function useTheme() {
  const [theme, setTheme] = useState(document.documentElement.dataset.theme ?? 'light')
  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    localStorage.setItem('theme', next)
    setTheme(next)
  }
  return { theme, toggle }
}

export function Landing(props: LandingProps) {
  const { name, icon, tagline, headline, support, audience, features, slides, tryHref = '/app' } = props
  const { theme, toggle } = useTheme()
  const [i, setI] = useState(0)

  useEffect(() => {
    if (slides.length < 2) return
    const t = setInterval(() => setI((n) => (n + 1) % slides.length), 4500)
    return () => clearInterval(t)
  }, [slides.length])

  const go = (href: string) => {
    history.pushState({}, '', href)
    dispatchEvent(new PopStateEvent('popstate'))
  }

  return (
    <div className="landing">
      <header className="topbar land-top">
        <div className="brand">
          <span className="logo" aria-hidden>
            <span className="material-symbols-outlined">{icon}</span>
          </span>
          <div>
            <strong>{name}</strong>
            <span className="muted tagline">{tagline}</span>
          </div>
        </div>
        <div className="row">
          <button className="btn ghost sm" onClick={() => go(tryHref)}>
            Try this
          </button>
          <button className="theme-toggle" onClick={toggle} aria-label="Toggle theme">
            <span className="material-symbols-outlined">{theme === 'dark' ? 'light_mode' : 'dark_mode'}</span>
          </button>
        </div>
      </header>

      <section className="land-hero">
        <div className="land-hero-copy">
          <p className="land-kicker">{name}</p>
          <h1>{headline}</h1>
          <p className="land-support">{support}</p>
          <div className="row land-cta">
            <button className="btn" onClick={() => go(tryHref)}>
              <span className="material-symbols-outlined">play_arrow</span>
              Try this
            </button>
            <button className="btn ghost" onClick={() => document.getElementById('demo')?.scrollIntoView({ behavior: 'smooth' })}>
              See how it works
            </button>
          </div>
          <p className="muted land-audience">{audience}</p>
        </div>
        <div className="land-hero-visual" aria-hidden>
          {slides[0]?.preview}
        </div>
      </section>

      <section className="land-section" id="demo">
        <h2>Product tour</h2>
        <p className="muted land-lead">Swipe through what you get once you open the tool.</p>
        <div className="carousel">
          <div className="carousel-frame">
            <div className="carousel-stage" key={i}>
              {slides[i]?.preview}
            </div>
            <div className="carousel-meta">
              <strong>{slides[i]?.title}</strong>
              <p className="muted">{slides[i]?.caption}</p>
            </div>
          </div>
          <div className="carousel-controls">
            <button className="btn ghost sm" aria-label="Previous" onClick={() => setI((n) => (n - 1 + slides.length) % slides.length)}>
              <span className="material-symbols-outlined">chevron_left</span>
            </button>
            <div className="carousel-dots" role="tablist" aria-label="Slides">
              {slides.map((s, n) => (
                <button
                  key={s.title}
                  role="tab"
                  aria-selected={n === i}
                  aria-label={s.title}
                  className={n === i ? 'on' : ''}
                  onClick={() => setI(n)}
                />
              ))}
            </div>
            <button className="btn ghost sm" aria-label="Next" onClick={() => setI((n) => (n + 1) % slides.length)}>
              <span className="material-symbols-outlined">chevron_right</span>
            </button>
          </div>
        </div>
      </section>

      <section className="land-section">
        <h2>Built for real workflows</h2>
        <div className="land-features">
          {features.map((f) => (
            <div key={f.title} className="land-feature">
              <span className="material-symbols-outlined">{f.icon}</span>
              <h3>{f.title}</h3>
              <p className="muted">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="land-section land-final">
        <h2>Ready to try {name}?</h2>
        <p className="muted">Open the live product — no account, no install.</p>
        <button className="btn" onClick={() => go(tryHref)}>
          <span className="material-symbols-outlined">play_arrow</span>
          Try this
        </button>
      </section>

      <footer className="container footer muted">
        Built by <a href="https://github.com/AryanKansagara">Aryan Kansagara</a>. Independent project, not affiliated with the vendor.
      </footer>
    </div>
  )
}

/** Mini UI frames used as landing “screenshots”. */
export function MockFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mock">
      <div className="mock-bar">
        <span /><span /><span />
        <em>{title}</em>
      </div>
      <div className="mock-body">{children}</div>
    </div>
  )
}

export function MockStat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className={`mock-stat ${tone ?? ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

export function MockBars({ items }: { items: { label: string; w: number; tone?: string }[] }) {
  return (
    <div className="mock-bars">
      {items.map((it) => (
        <div key={it.label} className="mock-bar-row">
          <span>{it.label}</span>
          <i><b style={{ width: `${it.w}%` }} className={it.tone} /></i>
        </div>
      ))}
    </div>
  )
}

export function MockList({ items }: { items: { badge: string; text: string; tone: string }[] }) {
  return (
    <ul className="mock-list">
      {items.map((it) => (
        <li key={it.text}>
          <span className={`badge ${it.tone}`}>{it.badge}</span>
          {it.text}
        </li>
      ))}
    </ul>
  )
}
