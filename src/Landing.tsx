import { useEffect, useState, type ReactNode } from 'react'
import { Button, IconButton } from 'material/react'
import { icon } from './icons.ts'
import { AmbientBackground, ThemeControls } from './ThemeChrome.tsx'

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

export function Landing(props: LandingProps) {
  const { name, tagline, headline, support, audience, features, slides, tryHref = '/app' } = props
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
      <AmbientBackground />
      <header className="topbar land-top">
        <div className="brand">
          <span className="logo" aria-hidden dangerouslySetInnerHTML={{ __html: icon.monitoring }} />
          <div>
            <strong>{name}</strong>
            <span className="muted tagline">{tagline}</span>
          </div>
        </div>
        <div className="row">
          <Button variant="outlined" onClick={() => go(tryHref)}>Try this</Button>
          <ThemeControls />
        </div>
      </header>

      <section className="land-hero">
        <div className="land-hero-copy">
          <p className="land-kicker">{name}</p>
          <h1>{headline}</h1>
          <p className="land-support">{support}</p>
          <div className="row land-cta">
            <Button variant="filled" icon={icon.play} onClick={() => go(tryHref)}>Try this</Button>
            <Button variant="outlined" onClick={() => document.getElementById('demo')?.scrollIntoView({ behavior: 'smooth' })}>
              See how it works
            </Button>
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
            <IconButton
              variant="outlined"
              icon={icon.chevronLeft}
              aria-label="Previous"
              onClick={() => setI((n) => (n - 1 + slides.length) % slides.length)}
            />
            <div className="carousel-dots" role="tablist" aria-label="Slides">
              {slides.map((s, n) => (
                <button
                  key={s.title}
                  type="button"
                  role="tab"
                  aria-selected={n === i}
                  aria-label={s.title}
                  className={n === i ? 'on' : ''}
                  onClick={() => setI(n)}
                />
              ))}
            </div>
            <IconButton
              variant="outlined"
              icon={icon.chevronRight}
              aria-label="Next"
              onClick={() => setI((n) => (n + 1) % slides.length)}
            />
          </div>
        </div>
      </section>

      <section className="land-section">
        <h2>Built for real workflows</h2>
        <div className="land-features">
          {features.map((f) => (
            <div key={f.title} className="land-feature">
              <h3>{f.title}</h3>
              <p className="muted">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="land-section land-final">
        <h2>Ready to try {name}?</h2>
        <p className="muted">Open the live product — no account, no install.</p>
        <Button variant="filled" icon={icon.play} onClick={() => go(tryHref)}>Try this</Button>
      </section>

      <footer className="container footer muted">
        Built by <a href="https://github.com/AryanKansagara">Aryan Kansagara</a>. Independent project, not affiliated with the vendor.
      </footer>
    </div>
  )
}

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
