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
 * @typedef {{
 *   families: Family[], errors: ParseError[], series: number,
 *   eof: boolean, openMetrics: boolean
 * }} Report
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
 *   kind: string|null, reasons: string[], examples: string[], suggestions: Suggestion[],
 *   members?: { metric: string, series: number, groups: number }[]
 * }} Risk
 */

/** Metric types the text format 0.0.4 does not have; a scrape that declares one is OpenMetrics. */
const OPENMETRICS_ONLY_TYPES = new Set(['unknown', 'gaugehistogram', 'stateset', 'info'])
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
  // Syntax only OpenMetrics producers emit (`# UNIT`, exemplars, info/stateset/gaugehistogram/unknown types, `# TYPE foo counter` + `foo_total`). OpenMetrics requires a closing `# EOF`; text format 0.0.4 has no end marker.
  let openMetrics = false
  /** @type {Map<string, string>} families whose TYPE was redeclared after samples, by base name */
  const redeclared = new Map()
  /** @type {Map<string, {base: string, type: string}>} family key -> its declared base name and type */
  const aliasOf = new Map()

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
    for (const [base, type] of redeclared) {
      if (SUFFIXES[type].some((s) => sample === base + s)) {
        if (type === 'counter' && sample === base + '_total') openMetrics = true
        const key = base + SUFFIXES[type][0]
        aliasOf.set(key, { base, type })
        return key
      }
    }
    if (meta.has(sample)) return sample
    for (const [type, sfx] of Object.entries(SUFFIXES)) {
      for (const s of sfx) {
        if (!sample.endsWith(s)) continue
        const base = sample.slice(0, -s.length)
        if (meta.get(base)?.type === type) {
          // `# TYPE foo counter` with a `foo_total` sample is how OpenMetrics names counters; the text format
          // declares the full name (`# TYPE foo_total counter`).
          if (type === 'counter' && s === '_total') openMetrics = true
          return base
        }
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
        if (m[1] === 'EOF') { eof = openMetrics = true; continue }
        if (m[1] === 'UNIT') openMetrics = true
        const { n, rest } = metaName(m[2])
        const entry = meta.get(n) ?? { type: 'untyped', help: '' }
        if (m[1] === 'TYPE') {
          const t = rest.trim().toLowerCase()
          if (!TYPES.has(t)) throw `unknown metric type "${rest.trim()}"`
          const typed = t === 'unknown' ? 'untyped' : t
          if (OPENMETRICS_ONLY_TYPES.has(t)) openMetrics = true
          const seen = fams.get(n)
          // Prometheus' own OpenMetrics output declares a gauge and a counter under one name
          // (go_memstats_alloc_bytes and go_memstats_alloc_bytes_total). Accept a redeclaration whose
          // samples use different names; the counter's samples become their own family.
          if (seen?.keys.size && !(seen.type !== typed && SUFFIXES[typed] && !seen.sampleNames.has(n + SUFFIXES[typed][0]))) throw `TYPE for "${n}" appears after its samples`
          if (seen?.keys.size) { redeclared.set(n, typed); meta.set(n, entry); continue }
          entry.type = typed
        } else if (m[1] === 'HELP' && !fams.get(n)?.keys.size) entry.help = rest.replace(/\\(\\|n)/g, (_, e) => (e === 'n' ? '\n' : '\\'))
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
      const hasTs = !c.done && c.peek() !== '#'
      if (hasTs) {
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
        openMetrics = true
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
        f = { name: fname, type: aliasOf.get(fname)?.type ?? meta.get(fname)?.type ?? 'untyped', keys: new Set(), groups: new Set(), le: new Set(), created: 0, sampleNames: new Set(), labels: new Map() }
        fams.set(fname, f)
      }
      const sorted = Object.keys(labels).sort()
      const key = name + '\0' + sorted.map((k) => k + '\0' + labels[k]).join('\0')
      // OpenMetrics allows several timestamped samples of one series; it is still one series.
      if (f.keys.has(key) && hasTs) continue
      if (f.keys.has(key)) throw `duplicate series ${name}{${sorted.map((k) => `${k}="${labels[k]}"`).join(',')}}`
      f.keys.add(key)
      if (f.type === 'histogram' || f.type === 'gaugehistogram') {
        if (name.endsWith('_bucket') && !('le' in labels)) throw `histogram bucket "${name}" has no "le" label`
        if ('le' in labels) f.le.add(labels.le)
      }
      // Prometheus 3 skips OpenMetrics `_created` series at ingest; track but don't bill them.
      if (name === (aliasOf.get(fname)?.base ?? fname) + '_created' && fname !== name) { f.created++; continue }
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
  return { families, errors, series: families.reduce((s, f) => s + f.series, 0), eof, openMetrics }
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

// ---------- can this comparison be trusted? ----------

/**
 * @typedef {{
 *   state: 'ok'|'skipped-lines'|'empty'|'unreadable'|'truncated',
 *   message: string
 * }} ScrapeCheck
 * @typedef {{
 *   status: 'ok'|'confirm'|'incomplete'|'blocked',
 *   blockers: string[], warnings: string[]
 * }} Verdict
 */

/** Scrape text is untrusted: one line, bounded, no backticks (it is quoted in code) or control characters. */
const quoteFromScrape = (/** @type {string} */ s) => '`' + s.replace(/[\u0000-\u001f\u007f`]/g, ' ').slice(0, 100) + (s.length > 100 ? '…' : '') + '`'
const plural = (/** @type {number} */ n, /** @type {string} */ w) => `${fmt(n)} ${w}${n === 1 ? '' : 's'}`

/**
 * Decide whether one parsed scrape can be compared at all.
 *  - empty: no families and nothing malformed (a blank file, or only comments and `# EOF`).
 *  - unreadable: no families and at least one malformed line (JSON, an HTML error page, binary data).
 *  - truncated: an OpenMetrics document without its mandatory `# EOF`, so it provably ends early.
 *  - skipped-lines: usable, but some lines were malformed and are not counted.
 * Text format 0.0.4 has no end marker, so a clean 0.0.4 scrape can never be proven complete; see `verdict`.
 * @param {Report} r @returns {ScrapeCheck}
 */
export function checkScrape(r) {
  if (!r.families.length) {
    const first = r.errors[0]
    return first
      ? { state: 'unreadable', message: `no metric families could be parsed (${plural(r.errors.length, 'malformed line')}, first at line ${first.line}: ${quoteFromScrape(first.message)}). It does not look like a Prometheus or OpenMetrics /metrics response` }
      : { state: 'empty', message: 'it is empty (no metric families)' }
  }
  if (r.openMetrics && !r.eof) {
    return { state: 'truncated', message: 'it is an OpenMetrics document without its required "# EOF" line, so it is incomplete (cut off or truncated)' }
  }
  if (r.errors.length) return { state: 'skipped-lines', message: `${plural(r.errors.length, 'malformed line')} skipped` }
  return { state: 'ok', message: '' }
}

/**
 * Judge a comparison before showing any number from it.
 * `blocked`: a side is empty, unreadable or provably truncated: no delta, cost or green result may be shown.
 * `incomplete`: malformed lines were skipped on a side, so series on those lines are not counted.
 * `confirm`: the series count went down and the head cannot be proven complete (no `# EOF`), so a scrape cut at a
 *   line boundary looks the same as a real removal. Any net decrease needs a human to confirm it; there is no
 *   percentage cut-off, because a cut near the end of the file is as small as a small legitimate removal.
 * `base` may be omitted (single-scrape audit). `allowEmptyBase` accepts an empty, never an unreadable, base (first run).
 * `names` is how messages call each side (the web tool's audit mode has one scrape, not a "head").
 * @param {{ base?: Report, head: Report, diff?: Diff, allowEmptyBase?: boolean, names?: { base: string, head: string } }} o
 * @returns {Verdict}
 */
export function verdict({ base, head, diff: d, allowEmptyBase = false, names = { base: 'base', head: 'head' } }) {
  /** @type {string[]} */
  const blockers = []
  /** @type {string[]} */
  const warnings = []
  let skipped = 0
  for (const [side, r] of /** @type {const} */ ([['base', base], ['head', head]])) {
    if (!r) continue
    const c = checkScrape(r)
    if (c.state === 'empty' && side === 'base' && allowEmptyBase) {
      warnings.push('**No base scrape.** `allow-empty-base` is on, so every metric family counts as new.')
    } else if (c.state === 'empty' || c.state === 'unreadable' || c.state === 'truncated') {
      blockers.push(`The ${names[side]} scrape cannot be used: ${c.message}.`)
    } else if (c.state === 'skipped-lines') skipped += r.errors.length
  }
  if (blockers.length) return { status: 'blocked', blockers, warnings }
  if (skipped) warnings.unshift(`**Incomplete result.** ${plural(skipped, 'malformed line')} ${skipped === 1 ? 'was' : 'were'} skipped while parsing, so series on ${skipped === 1 ? 'that line are' : 'those lines are'} not counted.`)
  const decreased = !!base && !!d && d.delta < 0 && !head.eof
  if (decreased) {
    warnings.push(`**Unconfirmed reduction.** Active series went down by ${fmt(-(d?.delta ?? 0))} per target, but this scrape cannot be proven complete: the Prometheus text format has no end marker, so a scrape cut off at a line boundary looks the same as a real removal. Confirm the removed metrics were removed on purpose before counting this as savings (an OpenMetrics scrape ends with \`# EOF\`, which proves it is whole).`)
  }
  return { status: skipped ? 'incomplete' : decreased ? 'confirm' : 'ok', blockers, warnings }
}

// ---------- risky label detection ----------

const ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?=[0-9a-f]*\d)[0-9a-f]{12,}|(?=[A-Za-z_-]*\d)[A-Za-z0-9_-]{20,})$/i
/** @type {[string, string, (v: string) => boolean][]} kind, description, test — order matters */
const KINDS = [
  ['uuid', 'UUIDs', (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)],
  ['timestamp', 'timestamps', (v) => /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v) || /^1\d{9}(\d{3}|\d{6}|\d{9})?$/.test(v)],
  ['email', 'email addresses', (v) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(v)],
  ['ip', 'IP addresses', (v) => /^(\d{1,3}\.){3}\d{1,3}(:\d+)?$/.test(v) || !/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(v) && /^\[?(?=[^\]]*(::|[a-f]))[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,7}\]?(:\d+)?$/i.test(v)],
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
        // A high ratio alone is common for bounded labels (route templates, collectors, devices): warn only.
        severity ??= 'warn'
      }
      if (!severity) continue
      const bl = baseLabels.get(f.name)
      const isNew = !!base && (!bl || !bl.has(l.name))
      // Info metrics (build_info, disk_info) carry identity labels by design, one series per entity, and a
      // label with a single value adds no series. Neither is "likely unbounded" unless this change adds it.
      if (severity === 'bad' && !isNew && (distinct === 1 || f.type === 'info' || /_info$/.test(f.name))) severity = 'warn'
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
  return groupRisks(risks).sort((a, b) => rank(b) - rank(a) || b.series - a.series)
}

/**
 * One label with the same values on many families (a filesystem uuid on 180 node_bcachefs_* metrics)
 * is one finding, not 180. Members keep their own series counts for cost and projection.
 * @param {Risk[]} risks @returns {Risk[]}
 */
function groupRisks(risks) {
  /** @type {Map<string, Risk>} */
  const by = new Map()
  for (const r of risks) {
    const key = [r.label, r.severity, r.kind, r.isNew, r.distinct, [...r.examples].sort().join('\0')].join('\u0001')
    const g = by.get(key)
    const m = { metric: r.metric, series: r.series, groups: r.groups }
    if (!g) { by.set(key, { ...r, members: [m] }); continue }
    g.members = [...(g.members ?? []), m]
    g.series += r.series
  }
  return [...by.values()]
}

/** Minimum series one new label value adds: one full label combination (all buckets + _sum + _count for histograms). */
/** @param {{series: number, groups: number, members?: {series: number, groups: number}[]}} f @returns {number} */
export function seriesPerValue(f) {
  const one = (/** @type {{series: number, groups: number}} */ m) => Math.max(1, Math.round(m.series / Math.max(m.groups, 1)))
  return f.members && f.members.length > 1 ? f.members.reduce((a, m) => a + one(m), 0) : one(f)
}

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
/**
 * Grafana Cloud bills max(active series, total DPM / included DPM). Pro includes 1 data point per minute
 * per series, so a series scraped every 15s (4 DPM) bills as 4 series once the account average is above 1.
 * https://grafana.com/docs/grafana-cloud/cost-management-and-billing/understand-your-invoice/metrics-invoice/
 */
export const dpmFactor = (/** @type {number} */ scrapeInterval) => Math.max(1, 60 / (scrapeInterval > 0 ? scrapeInterval : 60))

export const monthlyCost = (/** @type {number} */ series, /** @type {number} */ multiplier, /** @type {number} */ pricePer1k, scrapeInterval = 60) =>
  (series * multiplier * dpmFactor(scrapeInterval) * pricePer1k) / 1000

export const fmt = (/** @type {number} */ n) => Math.round(n).toLocaleString('en-US')
export const signed = (/** @type {number} */ n) => (n > 0 ? '+' : n < 0 ? '−' : '±') + fmt(Math.abs(n))
export const usd = (/** @type {number} */ n, sign = false) =>
  (sign ? (n > 0 ? '+' : n < 0 ? '−' : '±') : n < 0 ? '−' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
export const pct = (/** @type {number|null} */ p) => (p === null ? 'new' : (p > 0 ? '+' : '') + (Math.abs(p) >= 100 ? Math.round(p) : p.toFixed(1)) + '%')

export const MARKER = '<!-- cardinality-diff -->'

/**
 * Render the PR comment.
 * With a `verdict`, a blocked comparison renders no numbers at all and any other non-ok status is never green.
 * @param {{ diff: Diff, risks: Risk[], multiplier: number, pricePer1k: number, failAbove?: number|null, errors?: number, scrapeInterval?: number, verdict?: Verdict }} o
 */
export function renderMarkdown({ diff: d, risks, multiplier, pricePer1k, failAbove = null, errors = 0, scrapeInterval = 60, verdict: v }) {
  if (v?.status === 'blocked') {
    return [
      MARKER,
      '## ❌ Cardinality Diff',
      '',
      '**Could not compare these scrapes.** No series delta or cost estimate is shown because a scrape is missing, unreadable or incomplete:',
      '',
      ...v.blockers.flatMap((b) => [`> [!CAUTION]\n> ${b}`, '']),
      'Check that both files are complete Prometheus text or OpenMetrics `/metrics` responses from a healthy service (not an error page or a cut-off download).',
    ].join('\n')
  }
  const cost = monthlyCost(d.delta, multiplier, pricePer1k, scrapeInterval)
  const over = failAbove !== null && d.delta > failAbove
  const notes = v ? v.warnings : errors ? [`${errors} malformed line(s) were skipped while parsing.`] : []
  const unsure = !!v && v.status !== 'ok'
  const changed = d.rows.filter((r) => r.status !== 'unchanged')
  const bad = risks.filter((r) => r.severity === 'bad')
  const code = (/** @type {string} */ s) => '`' + s.replace(/`/g, "'").replace(/\|/g, '\\|') + '`'
  const icon = over || bad.some((r) => r.isNew) ? '🔴' : d.delta > 0 || risks.length || unsure ? '🟠' : '🟢'
  const lines = [
    MARKER,
    `## ${icon} Cardinality Diff`,
    '',
    `**${signed(d.delta)} active series** per target (${fmt(d.base)} → ${fmt(d.head)}, ${pct(d.base ? (d.delta / d.base) * 100 : null)})` +
      ` · **${usd(cost, true)}/month** at ${multiplier}× targets and $${pricePer1k.toFixed(2)}/1k series` +
      (dpmFactor(scrapeInterval) > 1 ? `, ${scrapeInterval}s scrape (${fmt(dpmFactor(scrapeInterval))} DPM)` : '') +
      (unsure ? ` · _${v.status === 'confirm' ? 'unconfirmed' : 'incomplete'}_` : ''),
  ]
  if (over) lines.push('', `> [!CAUTION]\n> Series delta ${signed(d.delta)} exceeds the configured threshold of ${fmt(failAbove ?? 0)}.`)
  for (const n of notes) lines.push('', `> [!WARNING]\n> ${n}`)
  if (changed.length) {
    lines.push('', '| Metric | Type | Base | Head | Δ series | Δ $/month | Note |', '|---|---|--:|--:|--:|--:|---|')
    for (const r of changed.slice(0, 10)) {
      const note = r.status === 'added' ? 'new metric' : r.status === 'removed' ? 'removed' : r.newLabels.length ? 'new label ' + r.newLabels.map(code).join(', ') : ''
      lines.push(`| ${code(r.name)} | ${r.type} | ${fmt(r.base)} | ${fmt(r.head)} | ${signed(r.delta)} (${pct(r.pct)}) | ${usd(monthlyCost(r.delta, multiplier, pricePer1k, scrapeInterval), true)} | ${note} |`)
    }
    if (changed.length > 10) lines.push('', `<sub>${changed.length - 10} more changed metric(s) not shown.</sub>`)
  } else lines.push('', 'No metric families changed.')
  if (risks.length) {
    lines.push('', `### ⚠️ ${risks.length} risky label${risks.length > 1 ? 's' : ''}`, '')
    for (const r of risks.slice(0, 8)) {
      lines.push(`- **${code(`${r.metric}{${r.label}}`)}**${(r.members?.length ?? 1) > 1 ? ` and ${(r.members?.length ?? 1) - 1} more metric${(r.members?.length ?? 1) > 2 ? 's' : ''}` : ''}${r.isNew ? ' (new)' : ''}: ${r.distinct} values in this scrape, each new value adds ≥${fmt(seriesPerValue(r))} series. ${r.reasons[0]} _Fix: ${r.suggestions[0].title.toLowerCase()}._`)
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
  lines.push('', `<sub>Estimate = series × ${multiplier} target(s) × $${pricePer1k.toFixed(2)} per 1,000 active series/month${dpmFactor(scrapeInterval) > 1 ? ` × ${fmt(dpmFactor(scrapeInterval))} for a ${scrapeInterval}s scrape interval (1 DPM included)` : ''}. Grafana Cloud includes 10k series free per account.</sub>`)
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
