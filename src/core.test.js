import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse, diff, findRisks, project, monthlyCost, renderMarkdown, encodeState, decodeState, templatePath, MARKER } from './core.js'

const sample = (/** @type {string} */ f) => readFileSync(new URL(`../samples/${f}`, import.meta.url), 'utf8')

test('parses text format: types, escapes, histograms, summaries', () => {
  const r = parse(`# HELP req Total "requests" with a \\\\ and \\n
# TYPE req counter
req{path="/a\\"b\\\\c\\nd",code="200",} 3 1712345678000
req{code="500"} +Inf
# TYPE lat histogram
lat_bucket{le="0.1"} 1
lat_bucket{le="+Inf"} 2
lat_sum 0.3
lat_count 2
# TYPE q summary
q{quantile="0.5"} NaN
q_sum 1
q_count 1
# a plain comment
untyped_thing 1e-3
`)
  assert.deepEqual(r.errors, [])
  const req = r.families.find((f) => f.name === 'req')
  assert.equal(req?.type, 'counter')
  assert.equal(req?.help, 'Total "requests" with a \\ and \n')
  assert.deepEqual(req?.labels.find((l) => l.name === 'path')?.values, ['/a"b\\c\nd'])
  const lat = r.families.find((f) => f.name === 'lat')
  assert.equal(lat?.series, 4)
  assert.equal(lat?.buckets, 2)
  assert.equal(lat?.groups, 1)
  assert.equal(r.families.find((f) => f.name === 'q')?.series, 3)
  assert.equal(r.families.find((f) => f.name === 'untyped_thing')?.type, 'untyped')
  assert.equal(r.series, 2 + 4 + 3 + 1)
})

test('parses OpenMetrics: _total/_created, exemplars, EOF, UTF-8 names', () => {
  const r = parse(`# TYPE foo counter
# UNIT foo seconds
foo_total{a="1"} 5 1520879607.789 # {trace_id="KOO5S4vxi0o"} 0.67 1520879602.890
foo_created{a="1"} 1520430000.123
# TYPE h histogram
h_bucket{le="1"} 0 # {trace_id="x"} 0.5
h_bucket{le="+Inf"} 1
h_count 1
h_sum 2
h_created 1520430000
{"my.dotted.metric", "service.name"="api"} 1
# EOF
`)
  assert.deepEqual(r.errors, [])
  const foo = r.families.find((f) => f.name === 'foo')
  assert.equal(foo?.series, 1, '_created is tracked but not counted')
  assert.equal(foo?.created, 1)
  assert.equal(r.families.find((f) => f.name === 'h')?.series, 4)
  assert.equal(r.families.find((f) => f.name === 'my.dotted.metric')?.labels[0].name, 'service.name')
})

test('reports malformed lines with line numbers and keeps going', () => {
  const r = parse(`ok 1
bad{a="1" 2
bad2{a=1} 2
no_value
dup 1
dup 1
# TYPE x wat
x_y 1 notatimestamp
fine{a="b"} 2
`)
  assert.deepEqual(r.errors.map((e) => e.line), [2, 3, 4, 6, 7, 8])
  assert.match(r.errors[3].message, /duplicate series/)
  assert.deepEqual(r.families.map((f) => f.name).sort(), ['dup', 'fine', 'ok'])
})

test('content after # EOF is an error', () => {
  assert.equal(parse('a 1\n# EOF\nb 2\n').errors[0].line, 3)
})

test('diff on samples flags the new labels and counter', () => {
  const base = parse(sample('base.prom')), head = parse(sample('head.prom'))
  assert.deepEqual([...base.errors, ...head.errors], [])
  const d = diff(base, head)
  assert.equal(d.delta, head.series - base.series)
  assert.ok(d.delta > 300)
  const http = d.rows[0]
  assert.equal(http.name, 'http_request_duration_seconds')
  assert.deepEqual(http.newLabels.sort(), ['path', 'user_id'])
  assert.equal(d.rows.find((r) => r.name === 'orders_processed_total')?.status, 'added')
  assert.equal(d.rows.find((r) => r.name === 'go_goroutines')?.status, 'unchanged')

  const risks = findRisks(head, base)
  const keys = risks.map((r) => `${r.metric}{${r.label}}`)
  for (const k of ['http_request_duration_seconds{user_id}', 'http_request_duration_seconds{path}', 'orders_processed_total{order_id}']) assert.ok(keys.includes(k), k)
  assert.ok(!keys.some((k) => /\{(le|code|method|route|status|quantile|version)\}/.test(k)), keys.join())
  assert.ok(risks.every((r) => r.isNew && r.severity === 'bad'))
  const order = risks.find((r) => r.label === 'order_id')
  assert.equal(order?.kind, 'uuid')
  assert.match(order?.suggestions.find((s) => s.code)?.code ?? '', /regex: 'orders_processed_total'\n    target_label: order_id\n    replacement: ''/)
  const path = risks.find((r) => r.label === 'path')
  assert.match(path?.suggestions.find((s) => s.code)?.code ?? '', /source_labels: \[__name__, path\]/)
})

test('audit mode reports nothing risky on a clean scrape', () => {
  assert.deepEqual(findRisks(parse(sample('base.prom'))), [])
})

test('value classifiers', () => {
  const risks = (/** @type {string} */ label, /** @type {string[]} */ vals) =>
    findRisks(parse(vals.map((v, i) => `m{${label}="${v}",i="${i}"} 1`).join('\n')))
  assert.equal(risks('client', ['10.0.0.1', '10.0.0.2', '192.168.1.9'])[0]?.kind, 'ip')
  assert.equal(risks('who', ['a@b.io', 'c@d.com'])[0]?.kind, 'email')
  assert.equal(risks('at', ['2024-01-02T03:04:05Z', '2024-01-02T03:04:06Z'])[0]?.kind, 'timestamp')
  assert.equal(risks('sha', ['3f2a9c0b1d4e5f60718293a4'])[0]?.kind, 'hex')
  assert.equal(risks('route', ['/users/:id', '/orders']).length, 0)
  assert.equal(templatePath('/api/users/42/orders?x=1'), '/api/users/:id/orders')
})

test('projection and cost', () => {
  const r = parse('m{user_id="1",le="1"} 1\nm{user_id="2",le="1"} 1\nother 1\n')
  assert.equal(project(r, { 'm{user_id}': 50000 }).total, 50001)
  assert.equal(monthlyCost(1000, 3, 6.5), 19.5)
})

test('markdown has marker, summary and fixes', () => {
  const base = parse(sample('base.prom')), head = parse(sample('head.prom'))
  const md = renderMarkdown({ diff: diff(base, head), risks: findRisks(head, base), multiplier: 10, pricePer1k: 6.5, failAbove: 100 })
  assert.ok(md.startsWith(MARKER))
  assert.match(md, /exceeds the configured threshold/)
  assert.match(md, /order_id/)
  assert.match(md, /```yaml/)
})

test('share state round-trips', async () => {
  const state = { base: 'a 1\n', head: 'a{x="é"} 1\n'.repeat(100), m: 3 }
  const enc = await encodeState(state)
  assert.match(enc, /^[A-Za-z0-9_-]+$/)
  assert.deepEqual(await decodeState(enc), state)
})
