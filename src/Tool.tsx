import { useDeferredValue, useEffect, useMemo, useState, type DragEvent } from 'react'
import { Shell } from './Shell.tsx'
import { BackToHome } from './router.tsx'
import {
  parse, diff, findRisks, project, monthlyCost, renderMarkdown, encodeState, decodeState, seriesPerValue,
  fmt, signed, usd, pct,
} from './core.js'
import baseSample from '../samples/base.prom?raw'
import headSample from '../samples/head.prom?raw'

type Report = ReturnType<typeof parse>
type Risk = ReturnType<typeof findRisks>[number]
type Mode = 'diff' | 'audit'

const PRICING_URL = 'https://grafana.com/pricing/'
const MAX_SHARE = 60_000 // characters in the URL hash; beyond this, browsers and chat apps start truncating

function ScrapeInput({ label, value, onChange, sample, report }: {
  label: string; value: string; onChange: (v: string) => void; sample: string; report: Report
}) {
  const [drag, setDrag] = useState(false)
  const load = (f?: File) => f && f.text().then(onChange)
  const onDrop = (e: DragEvent) => { e.preventDefault(); setDrag(false); load(e.dataTransfer.files[0]) }
  return (
    <div className="panel">
      <div className="row spread">
        <h3>{label}</h3>
        <div className="row">
          <button className="btn ghost sm" onClick={() => onChange(sample)}>Load sample</button>
          <label className="btn ghost sm">Upload<input type="file" accept=".txt,.prom,.metrics,text/plain,*/*" hidden onChange={(e) => load(e.target.files?.[0])} /></label>
          {value && <button className="btn ghost sm" onClick={() => onChange('')}>Clear</button>}
        </div>
      </div>
      <textarea
        className={drag ? 'drop' : ''} value={value} spellCheck={false} aria-label={`${label} metrics`}
        placeholder={'Paste a /metrics scrape, or drop a file here.\n\n# TYPE http_requests_total counter\nhttp_requests_total{code="200"} 1027'}
        onChange={(e) => onChange(e.target.value)}
        onDragOver={(e) => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)} onDrop={onDrop}
      />
      <div className="row spread small">
        <span className="muted">{report.families.length} families · {fmt(report.series)} series</span>
        {report.errors.length ? <span className="badge bad">{report.errors.length} malformed line{report.errors.length > 1 ? 's' : ''}</span>
          : value.trim() ? <span className="badge good">Parsed cleanly</span> : null}
      </div>
      {report.errors.length > 0 && (
        <ul className="errors mono">
          {report.errors.slice(0, 6).map((e) => <li key={e.line}><b>Line {e.line}:</b> {e.message}</li>)}
          {report.errors.length > 6 && <li className="muted">…and {report.errors.length - 6} more (skipped, parsing continued)</li>}
        </ul>
      )}
    </div>
  )
}

function Bars({ base, head, mode }: { base: Report; head: Report; mode: Mode }) {
  const b = new Map(base.families.map((f) => [f.name, f.series]))
  const rows = head.families.map((f) => ({ name: f.name, head: f.series, base: b.get(f.name) ?? 0 }))
  if (mode === 'diff') for (const f of base.families) if (!rows.some((r) => r.name === f.name)) rows.push({ name: f.name, head: 0, base: f.series })
  rows.sort((x, y) => Math.max(y.head, y.base) - Math.max(x.head, x.base))
  const top = rows.slice(0, 8)
  const max = Math.max(1, ...top.map((r) => Math.max(r.head, r.base)))
  if (!top.length) return null
  return (
    <div className="panel">
      <div className="row spread">
        <h2>Largest metric families</h2>
        {mode === 'diff' && <div className="legend small muted"><i className="sw base" /> Base <i className="sw head" /> Head</div>}
      </div>
      <div className="bars">
        {top.map((r) => (
          <div key={r.name} className="bar-row" title={mode === 'diff' ? `${r.name}: ${fmt(r.base)} → ${fmt(r.head)} series` : `${r.name}: ${fmt(r.head)} series`}>
            <span className="mono name">{r.name}</span>
            <div className="tracks">
              {mode === 'diff' && <span className="b" style={{ width: `${(r.base / max) * 100}%` }} />}
              <span className="h" style={{ width: `${(r.head / max) * 100}%` }} />
            </div>
            <span className="mono num">{mode === 'diff' ? `${fmt(r.base)} → ${fmt(r.head)}` : fmt(r.head)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function RiskCard({ r, expected, setExpected, cost }: {
  r: Risk; expected?: number; setExpected: (n: number | undefined) => void; cost: (series: number) => number
}) {
  const per = seriesPerValue(r)
  const projected = expected ? Math.round(r.series * (expected / r.distinct)) : null
  return (
    <div className={`finding ${r.severity}`}>
      <div className="row spread">
        <h3 className="mono">{r.metric}<span className="hl">{`{${r.label}}`}</span></h3>
        <div className="row">
          {r.isNew && <span className="badge info">new label</span>}
          <span className={`badge ${r.severity}`}>{r.severity === 'bad' ? 'Unbounded' : 'Suspicious'}</span>
        </div>
      </div>
      <ul className="reasons">{r.reasons.map((x) => <li key={x}>{x}</li>)}</ul>
      <div className="chips">{r.examples.map((v) => <code key={v}>{v || '""'}</code>)}</div>
      <p className="small muted">
        {r.distinct} distinct values now. Every new value adds at least <b>{fmt(per)}</b> series
        {r.type === 'histogram' && r.buckets ? ` (${r.buckets} buckets + _sum + _count)` : ''}, multiplied by every other label it combines with.
      </p>
      <div className="project row">
        <label className="small" htmlFor={`p-${r.metric}-${r.label}`}>Expected distinct <code>{r.label}</code> values in production</label>
        <input
          id={`p-${r.metric}-${r.label}`} type="number" min={1} placeholder={String(r.distinct)} value={expected ?? ''}
          onChange={(e) => setExpected(e.target.value ? Math.max(1, Number(e.target.value)) : undefined)}
        />
        {projected !== null && <span className="small"><b>{fmt(projected)}</b> series for this metric · <b>{usd(cost(projected))}</b>/mo</span>}
      </div>
      <details>
        <summary>How to fix ({r.suggestions.length})</summary>
        {r.suggestions.map((s) => (
          <div key={s.title} className="fix">
            <b>{s.title}.</b> <span dangerouslySetInnerHTML={{ __html: inlineCode(s.body) }} />
            {s.code && <Code text={s.code} />}
          </div>
        ))}
      </details>
    </div>
  )
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const inlineCode = (s: string) => escapeHtml(s).replace(/`([^`]+)`/g, '<code>$1</code>')

function Code({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="code">
      <button className="btn ghost sm" onClick={() => navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })}>
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre>{text}</pre>
    </div>
  )
}

export default function Tool() {
  const [mode, setMode] = useState<Mode>('diff')
  const [base, setBase] = useState(baseSample)
  const [head, setHead] = useState(headSample)
  const [multiplier, setMultiplier] = useState(10)
  const [price, setPrice] = useState(6.5)
  const [expected, setExpected] = useState<Record<string, number>>({})
  const [showAll, setShowAll] = useState(false)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    const m = /^#s=(.+)$/.exec(location.hash)
    if (!m) return
    decodeState(m[1]).then((s) => {
      setMode(s.m === 'audit' ? 'audit' : 'diff'); setBase(String(s.b ?? '')); setHead(String(s.h ?? ''))
      setMultiplier(Number(s.x) || 1); setPrice(Number(s.p) || 6.5); setExpected(s.e ?? {})
    }).catch(() => setNotice('That share link could not be decoded.'))
  }, [])

  const baseText = useDeferredValue(base), headText = useDeferredValue(head)
  const baseR = useMemo(() => parse(baseText), [baseText])
  const headR = useMemo(() => parse(headText), [headText])
  const emptyR = useMemo(() => parse(''), [])
  const isDiff = mode === 'diff'
  const ref = isDiff ? baseR : emptyR
  const d = useMemo(() => diff(ref, headR), [ref, headR])
  const risks = useMemo(() => findRisks(headR, isDiff ? baseR : undefined), [headR, baseR, isDiff])
  const proj = useMemo(() => project(headR, expected), [headR, expected])
  const cost = (n: number) => monthlyCost(n, multiplier, price)
  const hasProj = Object.values(expected).some((v) => v > 0)
  const rows = d.rows.filter((r) => showAll || r.status !== 'unchanged')

  const flash = (s: string) => { setNotice(s); setTimeout(() => setNotice(''), 2500) }
  const share = async () => {
    const enc = await encodeState({ m: mode, b: isDiff ? base : '', h: head, x: multiplier, p: price, e: expected })
    if (enc.length > MAX_SHARE) return flash(`Inputs are too large for a link (${fmt(enc.length)} chars compressed). Trim the scrapes and try again.`)
    history.replaceState(null, '', `#s=${enc}`)
    await navigator.clipboard.writeText(location.href).then(() => flash('Share link copied to clipboard.'), () => flash('Link is in the address bar.'))
  }
  const copyMd = () => navigator.clipboard.writeText(renderMarkdown({ diff: d, risks, multiplier, pricePer1k: price, errors: baseR.errors.length + headR.errors.length }))
    .then(() => flash('PR comment Markdown copied.'))

  return (
    <Shell name="Cardinality Diff" tagline="Catch Prometheus series explosions in code review" icon="ssid_chart">
      <BackToHome />
      <section className="hero">
        <h1>One new label can multiply your metrics bill.</h1>
        <p>
          Paste the <code>/metrics</code> output from before and after a change. Cardinality Diff shows the active-series delta per
          metric, flags labels like <code>user_id</code>, trace IDs or raw URL paths, and estimates the monthly cost before it reaches
          production. <span className="badge good">Runs entirely in your browser</span>
        </p>
      </section>

      <div className="tabs" role="tablist">
        {(['diff', 'audit'] as const).map((m) => (
          <button key={m} role="tab" aria-selected={mode === m} onClick={() => setMode(m)}>
            {m === 'diff' ? 'Diff: base vs head' : 'Audit: single scrape'}
          </button>
        ))}
      </div>

      <div className={isDiff ? 'grid cols-2' : 'grid'}>
        {isDiff && <ScrapeInput label="Base (main branch)" value={base} onChange={setBase} sample={baseSample} report={baseR} />}
        <ScrapeInput label={isDiff ? 'Head (pull request)' : 'Scrape'} value={head} onChange={setHead} sample={headSample} report={headR} />
      </div>

      <section className="panel settings">
        <div className="field">
          <label htmlFor="mult">Scraped targets</label>
          <input id="mult" type="number" min={0} value={multiplier} onChange={(e) => setMultiplier(Math.max(0, Number(e.target.value)))} />
          <span className="small muted">Pods × replicas exposing these metrics</span>
        </div>
        <div className="field">
          <label htmlFor="price">$ per 1,000 active series / month</label>
          <input id="price" type="number" min={0} step={0.5} value={price} onChange={(e) => setPrice(Math.max(0, Number(e.target.value)))} />
          <span className="small muted">Default: <a href={PRICING_URL} target="_blank" rel="noreferrer">Grafana Cloud Pro</a> list price; first 10k series free per account</span>
        </div>
        <div className="row actions">
          <button className="btn" onClick={share}>Copy share link</button>
          {isDiff && <button className="btn ghost" onClick={copyMd}>Copy PR comment</button>}
        </div>
        {notice && <p className="notice small" role="status">{notice}</p>}
      </section>

      <section className="stats">
        {isDiff ? (
          <>
            <Stat label="Series per target" value={`${fmt(d.base)} → ${fmt(d.head)}`} />
            <Stat label="Series delta" value={signed(d.delta)} sub={pct(d.base ? (d.delta / d.base) * 100 : null)} tone={d.delta > 0 ? 'bad' : 'good'} />
            <Stat label="Monthly cost delta" value={usd(cost(d.delta), true)} sub={`${fmt(d.delta * multiplier)} series across ${multiplier} targets`} tone={d.delta > 0 ? 'bad' : 'good'} />
          </>
        ) : (
          <>
            <Stat label="Active series per target" value={fmt(headR.series)} sub={`${headR.families.length} metric families`} />
            <Stat label="Estimated monthly cost" value={usd(cost(headR.series))} sub={`${fmt(headR.series * multiplier)} series across ${multiplier} targets`} />
          </>
        )}
        <Stat label="Risky labels" value={String(risks.length)} sub={`${risks.filter((r) => r.severity === 'bad').length} likely unbounded`} tone={risks.length ? 'warn' : 'good'} />
        {hasProj && (
          <Stat label="Projected in production" value={fmt(proj.total)} tone="bad"
            sub={`${usd(cost(proj.total))}/mo · ${isDiff ? usd(cost(proj.total - d.base), true) + ' vs base' : 'worst case'}`} />
        )}
      </section>

      {risks.length > 0 && (
        <section className="panel">
          <div className="row spread">
            <h2>Risky labels</h2>
            {hasProj && <button className="btn ghost sm" onClick={() => setExpected({})}>Reset projections</button>}
          </div>
          <p className="small muted">
            A dev or staging scrape shows a handful of values; production will see one per user, order or URL. Enter an expected
            count to project the real cost (worst case: values are assumed independent of other labels).
          </p>
          {risks.map((r) => {
            const k = `${r.metric}{${r.label}}`
            return <RiskCard key={k} r={r} cost={cost} expected={expected[k]}
              setExpected={(n) => setExpected(({ [k]: _, ...rest }) => (n ? { ...rest, [k]: n } : rest))} />
          })}
        </section>
      )}
      {headR.families.length > 0 && risks.length === 0 && (
        <div className="finding good">No unbounded-looking labels found{isDiff ? ' in this change' : ''}.</div>
      )}

      <Bars base={ref} head={headR} mode={mode} />

      <section className="panel">
        <div className="row spread">
          <h2>{isDiff ? 'Changes by metric' : 'Metric families'}</h2>
          {isDiff && (
            <label className="row small check">
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show unchanged ({d.rows.length - d.rows.filter((r) => r.status !== 'unchanged').length})
            </label>
          )}
        </div>
        <div className="table-wrap">
          {isDiff ? (
            <table>
              <thead><tr><th>Metric</th><th>Status</th><th className="r">Base</th><th className="r">Head</th><th className="r">Δ series</th><th className="r">Change</th><th className="r">Δ $/mo</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.name}>
                    <td>
                      <span className="mono">{r.name}</span> <span className="muted small">{r.type}</span>
                      {(r.newLabels.length > 0 || r.removedLabels.length > 0) && (
                        <div className="chips">
                          {r.newLabels.map((l) => <span key={l} className="badge warn mono">+{l}</span>)}
                          {r.removedLabels.map((l) => <span key={l} className="badge good mono">−{l}</span>)}
                        </div>
                      )}
                    </td>
                    <td><span className={`badge ${{ added: 'warn', removed: 'good', changed: 'info', unchanged: '' }[r.status]}`}>{r.status}</span></td>
                    <td className="r mono">{fmt(r.base)}</td>
                    <td className="r mono">{fmt(r.head)}</td>
                    <td className={`r mono ${r.delta > 0 ? 'up' : r.delta < 0 ? 'down' : ''}`}>{signed(r.delta)}</td>
                    <td className="r mono">{r.status === 'removed' ? '−100%' : pct(r.pct)}</td>
                    <td className="r mono">{usd(cost(r.delta), true)}</td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={7} className="muted">No metric families changed.</td></tr>}
              </tbody>
            </table>
          ) : (
            <table>
              <thead><tr><th>Metric</th><th className="r">Series</th><th>Share</th><th>Labels (distinct values)</th><th className="r">Buckets</th></tr></thead>
              <tbody>
                {[...headR.families].sort((a, b) => b.series - a.series).map((f) => (
                  <tr key={f.name}>
                    <td><span className="mono">{f.name}</span> <span className="muted small">{f.type}</span></td>
                    <td className="r mono">{fmt(f.series)}</td>
                    <td className="share"><div className="bar"><span style={{ width: `${(f.series / Math.max(headR.series, 1)) * 100}%` }} /></div></td>
                    <td><div className="chips">{f.labels.map((l) => <code key={l.name}>{l.name} <b>{l.values.length}</b></code>)}</div></td>
                    <td className="r mono">{f.buckets || '–'}</td>
                  </tr>
                ))}
                {!headR.families.length && <tr><td colSpan={5} className="muted">Paste a scrape to see its metric families.</td></tr>}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="small muted about">
        <p>
          <b>Why this exists.</b> Active series are the unit of cost for Prometheus-compatible backends, and a single label with a
          per-request value (user ID, trace ID, raw path) quietly multiplies them. Teams find out from the bill
          (<a href="https://news.ycombinator.com/item?id=41500740" target="_blank" rel="noreferrer">a 70k-series, $1,000+ surprise on Hacker News</a>).
          Adaptive Metrics can aggregate unused series after the fact; this catches them in review. A GitHub Action that posts the
          same report on pull requests ships in the <a href="https://github.com/AryanKansagara/cardinality-diff" target="_blank" rel="noreferrer">repository</a>.
        </p>
        <p>
          Series are counted per scrape target as Prometheus would store them: every bucket, <code>_sum</code> and <code>_count</code>
          is its own series; OpenMetrics <code>_created</code> lines are parsed but not counted.
        </p>
      </section>
    </Shell>
  )
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'good' | 'warn' | 'bad' }) {
  return (
    <div className={`stat ${tone ?? ''}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="small muted">{sub}</div>}
    </div>
  )
}
