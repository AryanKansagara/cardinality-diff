// Cardinality Diff core: Prometheus / OpenMetrics text parser, cardinality analysis,
// diffing, risky-label detection, cost math and PR-comment rendering.
// Plain ESM + JSDoc so the web app and the GitHub Action (node20, no build) share it.

/**
 * @typedef {{ line: number, message: string }} ParseError
 * @typedef {{
 *   name: string, type: string, help: string,
 *   series: number, groups: number, buckets: number, created: number,
 *   sampleNames: string[],
 *   labels: { name: string, values: string[] }[]
 * }} Family
 * @typedef {{ families: Family[], errors: ParseError[], series: number }} Report
 * @typedef {{
 *   name: string, type: string, status: 'added'|'removed'|'changed'|'unchanged',
 *   base: number, head: number, delta: number, pct: number|null,
 *   newLabels: string[], removedLabels: string[]
 * }} DiffRow
 * @typedef {{ rows: DiffRow[], base: number, head: number, delta: number }} Diff
 * @typedef {{ title: string, body: string, code?: string }} Suggestion
 * @typedef {{
 *   metric: string, type: string, label: string, severity: 'bad'|'warn',
 *   distinct: number, groups: number, series: number, buckets: number, isNew: boolean,
 *   kind: string|null, reasons: string[], examples: string[], suggestions: Suggestion[]
 * }} Risk
 */

const TYPES = new Set(['counter', 'gauge', 'histogram', 'summary', 'untyped', 'unknown', 'gaugehistogram', 'stateset', 'info'])
/** @type {Record<string, string[]>} sample-name suffixes that belong to a declared family */
const SUFFIXES = {
  counter: ['_total', '_created'],
  histogram: ['_bucket', '_sum', '_count', '_created'],
  gaugehistogram: ['_bucket', '_gsum', '_gcount'],
  summary: ['_sum', '_count', '_created'],
  info: ['_info'],
}
/** Labels that are part of a type's structure, never "user" cardinality. */
const STRUCTURAL = new Set(['le', 'quantile'])
const NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*/
const LABEL_RE = /^[a-zA-Z_][a-zA-Z0-9_]*/

/** Parse a Go-style float ("+Inf", "NaN", "1e-3"). */
function parseValue(/** @type {string} */ s) {
  if (/^[+-]?inf(inity)?$/i.test(s)) return s[0] === '-' ? -Infinity : Infinity
  if (/^nan$/i.test(s)) return NaN
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$|^[+-]?0x[0-9a-f]+$/i.test(s)) return null
  return Number(s)
}

/**
 * Tiny cursor over one line. Throws string messages on malformed input.
 * @param {string} line
 */
function cursor(line) {
  let i = 0
  const c = {
    get pos() { return i },
    get done() { return i >= line.length },
    peek: () => line[i],
    ws() { const s = i; while (line[i] === ' ' || line[i] === '\t') i++; return i > s },
    /** @param {string} ch */
    expect(ch) { if (line[i] !== ch) throw `expected '${ch}' at column ${i + 1}`; i++ },
    /** @param {RegExp} re */
    match(re) { const m = re.exec(line.slice(i)); if (!m) return null; i += m[0].length; return m[0] },
    token() { const s = i; while (i < line.length && line[i] !== ' ' && line[i] !== '\t') i++; return line.slice(s, i) },
    quoted() {
      c.expect('"')
      let out = ''
      for (;;) {
        if (i >= line.length) throw 'unterminated quoted string'
        const ch = line[i++]
        if (ch === '"') return out
        if (ch === '\\') {
          const e = line[i++]
          if (e === undefined) throw 'unterminated escape sequence'
          out += e === 'n' ? '\n' : e // \\ -> \, \" -> ", unknown escapes kept literally
        } else out += ch
      }
    },
    rest: () => line.slice(i),
  }
  return c
}

/**
 * Parse `{a="1",b="2"}` (cursor on '{'). Supports Prometheus 3 quoted UTF-8 names,
 * including a bare quoted metric name inside the braces.
 * @param {ReturnType<typeof cursor>} c
 * @returns {{ labels: Record<string,string>, name: string|null }}
 */
function parseLabels(c) {
  c.expect('{')
  /** @type {Record<string,string>} */
  const labels = {}
  let name = null
  for (;;) {
    c.ws()
    if (c.peek() === '}') { c.expect('}'); return { labels, name } }
    let key = c.peek() === '"' ? c.quoted() : c.match(LABEL_RE)
    if (key === null) throw `invalid label name at column ${c.pos + 1}`
    c.ws()
    if (c.peek() !== '=') {
      // `{"my.metric", a="1"}`: a quoted string without '=' is the metric name.
      if (name !== null || Object.keys(labels).length) throw `expected '=' after label "${key}"`
      name = key
    } else {
      c.expect('=')
      c.ws()
      if (key in labels) throw `duplicate label "${key}"`
      labels[key] = c.quoted()
    }
    c.ws()
    if (c.peek() === ',') c.expect(',')
    else if (c.peek() !== '}') throw `expected ',' or '}' at column ${c.pos + 1}`
  }
}

/**
 * Parse a Prometheus text exposition (0.0.4) or OpenMetrics 1.0 document.
 * Never throws: malformed lines are reported with line numbers and skipped.
 * @param {string} text
 * @returns {Report}
 */
export function parse(text) {
  /** @type {ParseError[]} */
  const errors = []
  /** @type {Map<string, {type: string, help: string}>} */
  const meta = new Map()
  /** @type {Map<string, {name: string, type: string, keys: Set<string>, groups: Set<string>, le: Set<string>, created: number, sampleNames: Set<string>, labels: Map<string, Set<string>>}>} */
  const fams = new Map()
  const lines = text.split(/\r?\n/)
  let eof = false

  /** @param {string} s */
  const metaName = (s) => {
    const c = cursor(s)
    const n = c.peek() === '"' ? c.quoted() : c.match(NAME_RE)
    if (!n) throw 'invalid metric name'
    c.ws()
    return { n, rest: c.rest() }
  }

  /** @param {string} sample */
  const familyOf = (sample) => {
    if (meta.has(sample)) return sample
    for (const [type, sfx] of Object.entries(SUFFIXES)) {
      for (const s of sfx) {
        if (!sample.endsWith(s)) continue
        const base = sample.slice(0, -s.length)
        if (meta.get(base)?.type === type) return base
      }
    }
    return sample
  }

  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln].replace(/^[ \t]+/, '')
    const no = ln + 1
    if (!line) continue
    if (eof) { errors.push({ line: no, message: 'content after # EOF' }); break }
    try {
      if (line[0] === '#') {
        const m = /^#[ \t]+(HELP|TYPE|UNIT|EOF)\b[ \t]*(.*)$/.exec(line)
        if (!m) continue // plain comment
        if (m[1] === 'EOF') { eof = true; continue }
        const { n, rest } = metaName(m[2])
        const entry = meta.get(n) ?? { type: 'untyped', help: '' }
        if (m[1] === 'TYPE') {
          const t = rest.trim().toLowerCase()
          if (!TYPES.has(t)) throw `unknown metric type "${rest.trim()}"`
          if (fams.has(n) && fams.get(n)?.keys.size) throw `TYPE for "${n}" appears after its samples`
          entry.type = t === 'unknown' ? 'untyped' : t
        } else if (m[1] === 'HELP') entry.help = rest.replace(/\\(\\|n)/g, (_, e) => (e === 'n' ? '\n' : '\\'))
        meta.set(n, entry)
        continue
      }

      const c = cursor(line)
      let name = c.match(NAME_RE)
      /** @type {Record<string,string>} */
      let labels = {}
      if (c.peek() === '{') {
        const r = parseLabels(c)
        labels = r.labels
        if (r.name !== null) {
          if (name) throw 'metric name given twice'
          name = r.name
        }
      }
      if (!name) throw 'missing metric name'
      if (!c.ws()) throw `expected whitespace before value at column ${c.pos + 1}`
      const raw = c.token()
      if (raw === '') throw 'missing sample value'
      if (parseValue(raw) === null) throw `invalid sample value "${raw}"`
      c.ws()
      if (!c.done && c.peek() !== '#') {
        const ts = c.token()
        if (parseValue(ts) === null || !isFinite(/** @type {number} */ (parseValue(ts)))) throw `invalid timestamp "${ts}"`
        c.ws()
      }
      if (!c.done) {
        // OpenMetrics exemplar: `# {trace_id="abc"} 0.5 [timestamp]`
        c.expect('#')
        c.ws()
        if (c.peek() !== '{') throw 'exemplar must start with a label set'
        parseLabels(c)
        c.ws()
        const ev = c.token()
        if (parseValue(ev) === null) throw `invalid exemplar value "${ev}"`
        c.ws()
        if (!c.done) {
          const ets = c.token()
          if (parseValue(ets) === null) throw `invalid exemplar timestamp "${ets}"`
          c.ws()
        }
        if (!c.done) throw `unexpected text "${c.rest()}"`
      }

      const fname = familyOf(name)
      let f = fams.get(fname)
      if (!f) {
        f = { name: fname, type: meta.get(fname)?.type ?? 'untyped', keys: new Set(), groups: new Set(), le: new Set(), created: 0, sampleNames: new Set(), labels: new Map() }
        fams.set(fname, f)
      }
      const sorted = Object.keys(labels).sort()
      const key = name + '\0' + sorted.map((k) => k + '\0' + labels[k]).join('\0')
      if (f.keys.has(key)) throw `duplicate series ${name}{${sorted.map((k) => `${k}="${labels[k]}"`).join(',')}}`
      f.keys.add(key)
      if (f.type === 'histogram' || f.type === 'gaugehistogram') {
        if (name.endsWith('_bucket') && !('le' in labels)) throw `histogram bucket "${name}" has no "le" label`
        if ('le' in labels) f.le.add(labels.le)
      }
      // Prometheus 3 skips OpenMetrics `_created` series at ingest; track but don't bill them.
      if (name === fname + '_created' && fname !== name) { f.created++; continue }
      f.sampleNames.add(name)
      f.groups.add(sorted.filter((k) => !STRUCTURAL.has(k)).map((k) => k + '\0' + labels[k]).join('\0'))
      for (const k of sorted) {
        let set = f.labels.get(k)
        if (!set) f.labels.set(k, (set = new Set()))
        set.add(labels[k])
      }
    } catch (e) {
      errors.push({ line: no, message: typeof e === 'string' ? e : String(e) })
    }
  }

  /** @type {Family[]} */
  const families = [...fams.values()].map((f) => ({
    name: f.name,
    type: f.type,
    help: meta.get(f.name)?.help ?? '',
    series: f.keys.size - f.created,
    groups: f.groups.size,
    buckets: f.le.size,
    created: f.created,
    sampleNames: [...f.sampleNames].sort(),
    labels: [...f.labels].map(([name, v]) => ({ name, values: [...v] })).sort((a, b) => a.name.localeCompare(b.name)),
  }))
  return { families, errors, series: families.reduce((s, f) => s + f.series, 0) }
}

/**
 * Compare two parsed scrapes. Rows are sorted by absolute series delta (largest first).
 * @param {Report} base @param {Report} head @returns {Diff}
 */
export function diff(base, head) {
  const b = new Map(base.families.map((f) => [f.name, f]))
  const h = new Map(head.families.map((f) => [f.name, f]))
  /** @type {DiffRow[]} */
  const rows = []
  for (const name of new Set([...b.keys(), ...h.keys()])) {
    const bf = b.get(name), hf = h.get(name)
    const bl = new Set(bf?.labels.map((l) => l.name)), hl = new Set(hf?.labels.map((l) => l.name))
    const bs = bf?.series ?? 0, hs = hf?.series ?? 0
    const newLabels = bf && hf ? [...hl].filter((l) => !bl.has(l)) : []
    const removedLabels = bf && hf ? [...bl].filter((l) => !hl.has(l)) : []
    rows.push({
      name,
      type: (hf ?? bf)?.type ?? 'untyped',
      status: !bf ? 'added' : !hf ? 'removed' : bs !== hs || newLabels.length || removedLabels.length ? 'changed' : 'unchanged',
      base: bs, head: hs, delta: hs - bs,
      pct: bs ? ((hs - bs) / bs) * 100 : null,
      newLabels, removedLabels,
    })
  }
  rows.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta) || x.name.localeCompare(y.name))
  return { rows, base: base.series, head: head.series, delta: head.series - base.series }
}

// ---------- risky label detection ----------

const ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?=[0-9a-f]*\d)[0-9a-f]{12,}|[A-Za-z0-9_-]{20,})$/i
/** @type {[string, string, (v: string) => boolean][]} kind, description, test — order matters */
const KINDS = [
  ['uuid', 'UUIDs', (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)],
  ['timestamp', 'timestamps', (v) => /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v) || /^1\d{9}(\d{3}|\d{6}|\d{9})?$/.test(v)],
  ['email', 'email addresses', (v) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(v)],
  ['ip', 'IP addresses', (v) => /^(\d{1,3}\.){3}\d{1,3}(:\d+)?$/.test(v) || /^\[?(?=[^\]]*(::|[a-f]))[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,7}\]?(:\d+)?$/i.test(v)],
  ['path', 'raw URL paths containing IDs or query strings', (v) => /^(\/|[a-z][a-z0-9+.-]*:\/\/)/i.test(v) && (v.includes('?') || v.split(/[/?#]/).some((s) => ID_SEGMENT.test(s)))],
  ['hex', 'hex hashes / trace IDs', (v) => /^(0x)?(?=[0-9a-f]*\d)[0-9a-f]{12,}$/i.test(v)],
  ['number', 'long numeric IDs', (v) => /^-?\d{5,}$/.test(v)],
]
const SUSPICIOUS_NAME = /(^|_)(ids?|uuid|guid|email|session|token|ip|addr|path|url|uri|query|user|username|customer|account|tenant_id|hash|sha|timestamp)$/i

/** Regex alternation matching all of a family's sample names (for metric_relabel_configs). */
function nameRegex(/** @type {Family} */ f) {
  const esc = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const names = f.sampleNames.length ? f.sampleNames : [f.name]
  if (names.length === 1) return esc(names[0])
  const sfx = names.map((n) => n.slice(f.name.length).replace(/^_/, ''))
  if (names.every((n) => n.startsWith(f.name))) return `${esc(f.name)}_(${sfx.filter(Boolean).map(esc).join('|')})` + (sfx.includes('') ? '?' : '')
  return `(${names.map(esc).join('|')})`
}

/** Turn a raw path into a route template, e.g. /api/users/42?x=1 -> /api/users/:id */
export function templatePath(/** @type {string} */ v) {
  const [path] = v.split(/[?#]/)
  return path.split('/').map((s) => (ID_SEGMENT.test(s) ? ':id' : s)).join('/')
}

/**
 * @param {Family} f @param {string} label @param {string} kind
 * @returns {Suggestion[]}
 */
function suggest(f, label, kind) {
  const scope = nameRegex(f)
  const values = f.labels.find((l) => l.name === label)?.values ?? []
  /** @type {Suggestion[]} */
  const out = []
  const isPath = kind === 'path' || /(path|url|uri)$/i.test(label)
  if (isPath) {
    const templates = [...new Set(values.map(templatePath))].filter((t) => t.includes(':id')).slice(0, 4)
    out.push({
      title: 'Label by route template, not raw path',
      body: 'Use the router\'s matched pattern (chi `RoutePattern()`, gin `c.FullPath()`, gorilla `CurrentRoute().GetPathTemplate()`, Express `req.route.path`) so `/users/42` and `/users/43` share one series.',
    })
    if (templates.length) {
      const yq = (/** @type {string} */ s) => `'${s.replace(/'/g, "''")}'`
      out.push({
        title: 'Stop-gap: rewrite paths at scrape time',
        body: 'Until the code change ships, collapse ID segments with metric_relabel_configs (regexes are fully anchored; one rule per route).',
        code: 'metric_relabel_configs:\n' + templates.map((t) => {
          const re = t.split('/').map((s) => (s === ':id' ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/')
          return `  - source_labels: [__name__, ${label}]\n    regex: ${yq(`${scope};${re}([?#].*)?`)}\n    target_label: ${label}\n    replacement: ${yq(t)}`
        }).join('\n'),
      })
    }
  } else if (kind === 'timestamp') {
    out.push({ title: 'Make the time a value, not a label', body: 'Expose it as a gauge sample, e.g. `job_last_success_timestamp_seconds`, instead of a label that creates a new series every time it changes.' })
  } else if (kind === 'ip') {
    out.push({ title: 'Aggregate or drop client addresses', body: 'Per-client IPs are unbounded. Bucket into a coarse dimension (region, ASN, internal/external) or drop the label and keep IPs in access logs.' })
  } else {
    out.push({ title: 'Remove the label from instrumentation', body: `Per-entity values like \`${label}\` belong in logs and traces, which are built for high-cardinality fields. Aggregate the metric over all ${label.replace(/_id$/, '')}s instead.` })
  }
  if (!isPath) {
    out.push({
      title: 'Stop-gap: drop it at scrape time',
      body: `Scoped to this metric only (setting a label to an empty string removes it). If \`${label}\` was the only distinguishing label, series will collide; fix the code too.`,
      code: `metric_relabel_configs:\n  - source_labels: [__name__]\n    regex: '${scope}'\n    target_label: ${label}\n    replacement: ''`,
    })
  }
  if (f.type === 'histogram' || f.type === 'counter') {
    out.push({ title: 'Keep per-event detail in exemplars', body: `Attach a \`trace_id\` exemplar to \`${f.name}\` and jump from a Grafana panel to the exact trace in Tempo, with zero extra series.` })
  }
  return out
}

/**
 * Flag labels that look unbounded. `base` (optional) marks labels new in this change.
 * @param {Report} head @param {Report} [base] @returns {Risk[]}
 */
export function findRisks(head, base) {
  const baseLabels = new Map(base?.families.map((f) => [f.name, new Map(f.labels.map((l) => [l.name, l.values.length]))]))
  /** @type {Risk[]} */
  const risks = []
  for (const f of head.families) {
    for (const l of f.labels) {
      if (STRUCTURAL.has(l.name)) continue
      const distinct = l.values.length
      /** @type {string[]} */
      const reasons = []
      let severity = /** @type {'bad'|'warn'|null} */ (null)
      let kind = null
      for (const [k, desc, test] of KINDS) {
        const n = l.values.filter(test).length
        if (!n) continue
        kind = k
        if (n / distinct >= 0.5) { severity = 'bad'; reasons.push(`${n} of ${distinct} values look like ${desc}.`) }
        else { severity = 'warn'; reasons.push(`${n} of ${distinct} values look like ${desc}.`) }
        break
      }
      const hint = SUSPICIOUS_NAME.test(l.name)
      if (hint) {
        reasons.push(`The name \`${l.name}\` suggests a per-entity value with no upper bound.`)
        if (kind || distinct >= 10) severity = 'bad'
        else severity ??= 'warn'
      }
      if (distinct >= 10 && distinct / Math.max(f.groups, 1) >= 0.5) {
        reasons.push(`${distinct} distinct values across ${f.groups} label combinations: almost every series is unique to one value.`)
        severity ??= 'warn'
        if (distinct >= 50) severity = 'bad'
      }
      if (!severity) continue
      const bl = baseLabels.get(f.name)
      const isNew = !!base && (!bl || !bl.has(l.name))
      const grew = !!base && !!bl && (bl.get(l.name) ?? 0) < distinct
      if (base && !isNew && !grew && severity === 'warn') continue // pre-existing, unchanged, low-confidence: noise
      risks.push({
        metric: f.name, type: f.type, label: l.name, severity, distinct, groups: f.groups,
        series: f.series, buckets: f.buckets, isNew, kind, reasons,
        examples: l.values.slice(0, 5),
        suggestions: suggest(f, l.name, kind ?? (hint && /(path|url|uri)$/i.test(l.name) ? 'path' : 'id')),
      })
    }
  }
  const rank = (/** @type {Risk} */ r) => (r.severity === 'bad' ? 2 : 0) + (r.isNew ? 1 : 0)
  return risks.sort((a, b) => rank(b) - rank(a) || b.series - a.series)
}

/** Minimum series one new label value adds: one full label combination (all buckets + _sum + _count for histograms). */
export const seriesPerValue = (/** @type {{series: number, groups: number}} */ f) => Math.max(1, Math.round(f.series / Math.max(f.groups, 1)))

/**
 * Worst-case production series when flagged labels reach `expected` distinct values.
 * Assumes label values are independent (an upper bound, e.g. user_id x path).
 * @param {Report} report
 * @param {Record<string, number>} expected keyed by `${metric}{${label}}`
 */
export function project(report, expected) {
  /** @type {Map<string, number>} */
  const byFamily = new Map()
  let total = 0
  for (const f of report.families) {
    let factor = 1
    for (const l of f.labels) {
      const e = expected[`${f.name}{${l.name}}`]
      if (e > 0 && l.values.length) factor *= e / l.values.length
    }
    const s = Math.round(f.series * factor)
    byFamily.set(f.name, s)
    total += s
  }
  return { total, byFamily }
}

/** Monthly USD for `series` active series scraped from `multiplier` targets. */
export const monthlyCost = (/** @type {number} */ series, /** @type {number} */ multiplier, /** @type {number} */ pricePer1k) =>
  (series * multiplier * pricePer1k) / 1000

export const fmt = (/** @type {number} */ n) => Math.round(n).toLocaleString('en-US')
export const signed = (/** @type {number} */ n) => (n > 0 ? '+' : n < 0 ? '−' : '±') + fmt(Math.abs(n))
export const usd = (/** @type {number} */ n, sign = false) =>
  (sign ? (n > 0 ? '+' : n < 0 ? '−' : '±') : n < 0 ? '−' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
export const pct = (/** @type {number|null} */ p) => (p === null ? 'new' : (p > 0 ? '+' : '') + (Math.abs(p) >= 100 ? Math.round(p) : p.toFixed(1)) + '%')

export const MARKER = '<!-- cardinality-diff -->'

/**
 * Render the PR comment.
 * @param {{ diff: Diff, risks: Risk[], multiplier: number, pricePer1k: number, failAbove?: number|null, errors?: number }} o
 */
export function renderMarkdown({ diff: d, risks, multiplier, pricePer1k, failAbove = null, errors = 0 }) {
  const cost = monthlyCost(d.delta, multiplier, pricePer1k)
  const over = failAbove !== null && d.delta > failAbove
  const changed = d.rows.filter((r) => r.status !== 'unchanged')
  const bad = risks.filter((r) => r.severity === 'bad')
  const code = (/** @type {string} */ s) => '`' + s.replace(/`/g, "'").replace(/\|/g, '\\|') + '`'
  const icon = over || bad.some((r) => r.isNew) ? '🔴' : d.delta > 0 || risks.length ? '🟠' : '🟢'
  const lines = [
    MARKER,
    `## ${icon} Cardinality Diff`,
    '',
    `**${signed(d.delta)} active series** per target (${fmt(d.base)} → ${fmt(d.head)}, ${pct(d.base ? (d.delta / d.base) * 100 : null)})` +
      ` · **${usd(cost, true)}/month** at ${multiplier}× targets and $${pricePer1k.toFixed(2)}/1k series`,
  ]
  if (over) lines.push('', `> [!CAUTION]\n> Series delta ${signed(d.delta)} exceeds the configured threshold of ${fmt(failAbove ?? 0)}.`)
  if (errors) lines.push('', `> [!WARNING]\n> ${errors} malformed line(s) were skipped while parsing.`)
  if (changed.length) {
    lines.push('', '| Metric | Type | Base | Head | Δ series | Δ $/month | Note |', '|---|---|--:|--:|--:|--:|---|')
    for (const r of changed.slice(0, 10)) {
      const note = r.status === 'added' ? 'new metric' : r.status === 'removed' ? 'removed' : r.newLabels.length ? 'new label ' + r.newLabels.map(code).join(', ') : ''
      lines.push(`| ${code(r.name)} | ${r.type} | ${fmt(r.base)} | ${fmt(r.head)} | ${signed(r.delta)} (${pct(r.pct)}) | ${usd(monthlyCost(r.delta, multiplier, pricePer1k), true)} | ${note} |`)
    }
    if (changed.length > 10) lines.push('', `<sub>${changed.length - 10} more changed metric(s) not shown.</sub>`)
  } else lines.push('', 'No metric families changed.')
  if (risks.length) {
    lines.push('', `### ⚠️ ${risks.length} risky label${risks.length > 1 ? 's' : ''}`, '')
    for (const r of risks.slice(0, 8)) {
      lines.push(`- **${code(`${r.metric}{${r.label}}`)}**${r.isNew ? ' (new)' : ''}: ${r.distinct} values in this scrape, each new value adds ≥${fmt(seriesPerValue(r))} series. ${r.reasons[0]} _Fix: ${r.suggestions[0].title.toLowerCase()}._`)
    }
    lines.push('', '<details><summary>Suggested fixes</summary>', '')
    for (const r of risks.slice(0, 8)) {
      lines.push(`#### ${code(`${r.metric}{${r.label}}`)}`, '', ...r.reasons.map((x) => `- ${x}`), `- Examples: ${r.examples.map(code).join(', ')}`, '')
      for (const s of r.suggestions) {
        lines.push(`**${s.title}.** ${s.body}`, '')
        if (s.code) lines.push('```yaml', s.code, '```', '')
      }
    }
    lines.push('</details>')
  }
  if (changed.length) {
    lines.push('', '<details><summary>All changed metrics</summary>', '', '| Metric | Base | Head | Δ |', '|---|--:|--:|--:|')
    for (const r of changed) lines.push(`| ${code(r.name)} | ${fmt(r.base)} | ${fmt(r.head)} | ${signed(r.delta)} |`)
    lines.push('', '</details>')
  }
  lines.push('', `<sub>Estimate = series × ${multiplier} target(s) × $${pricePer1k.toFixed(2)} per 1,000 active series/month. Grafana Cloud includes 10k series free per account.</sub>`)
  return lines.join('\n')
}

// ---------- share links ----------

/** @param {unknown} state @returns {Promise<string>} deflate-raw + base64url */
export async function encodeState(state) {
  const stream = new Blob([JSON.stringify(state)]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** @param {string} s @returns {Promise<any>} */
export async function decodeState(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return JSON.parse(await new Response(stream).text())
}
