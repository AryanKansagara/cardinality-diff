// Runs the real Action entry point (`node action/index.js`) the way a workflow does: inputs as INPUT_* variables,
// outputs and the job summary as files, and a local stand-in for the GitHub API. No network, no real token.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const BASE = join(root, 'samples/base.prom')
const HEAD = join(root, 'samples/head.prom')
const OM = join(root, 'samples/real/prometheus-self.om.txt')
const dir = mkdtempSync(join(tmpdir(), 'cardinality-action-'))
process.on('exit', () => rmSync(dir, { recursive: true, force: true }))

let n = 0
/** @param {string} text @param {string} [name] */
const file = (text, name = `in-${n++}.prom`) => { const p = join(dir, name); writeFileSync(p, text); return p }
const read = (/** @type {string} */ f) => readFileSync(f, 'utf8')

/**
 * @param {Record<string, string>} inputs  e.g. { base, head, 'fail-above': '5' }
 * @param {{ pr?: boolean }} [o] pr: point the Action at a fake GitHub API and capture the comment it posts
 */
async function run(inputs, { pr = false } = {}) {
  const out = join(dir, `out-${n++}`), summary = join(dir, `summary-${n++}`)
  writeFileSync(out, ''); writeFileSync(summary, '')
  /** @type {string[]} */
  const comments = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      if (req.method === 'GET') return res.end('[]')
      comments.push(JSON.parse(body).body)
      res.statusCode = 201
      res.end('{}')
    })
  })
  const env = { PATH: process.env.PATH ?? '', GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary, ...Object.fromEntries(Object.entries(inputs).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, v])) }
  if (pr) {
    await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)))
    const event = file(JSON.stringify({ pull_request: { number: 7 } }), 'event.json')
    Object.assign(env, { GITHUB_API_URL: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`, GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: 'o/r', 'INPUT_GITHUB-TOKEN': 'not-a-real-token' })
  }
  const child = spawn(process.execPath, ['action/index.js'], { cwd: root, env })
  let log = ''
  child.stdout.on('data', (c) => (log += c)); child.stderr.on('data', (c) => (log += c))
  const code = await new Promise((r) => child.on('close', r))
  if (pr) server.close()
  const outputs = Object.fromEntries(read(out).split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
  return { code, log, outputs, summary: read(summary), comments }
}

// ---- unchanged behaviour ----

test('a real change still reports growth and fails fail-above exactly as before', async () => {
  const r = await run({ base: BASE, head: HEAD, multiplier: '12', 'fail-above': '500' })
  assert.equal(r.code, 0)
  assert.equal(r.outputs['series-delta'], '416')
  assert.equal(r.outputs['cost-delta'], '32.45')
  assert.equal(r.outputs.status, 'ok')
  assert.match(r.summary, /## 🔴 Cardinality Diff/)
  assert.match(r.summary, /\*\*\+416 active series\*\* per target \(142 → 558, \+293%\)/)
  const over = await run({ base: BASE, head: HEAD, 'fail-above': '100' })
  assert.equal(over.code, 1)
  assert.match(over.log, /::error::Series delta 416 exceeds fail-above \(100\)/)
})

test('identical scrapes are still green and exit 0', async () => {
  const r = await run({ base: BASE, head: BASE })
  assert.equal(r.code, 0)
  assert.equal(r.outputs['series-delta'], '0')
  assert.match(r.summary, /## 🟢 Cardinality Diff/)
})

test('a missing file or input still fails the step', async () => {
  assert.equal((await run({ base: BASE, head: join(dir, 'nope.prom') })).code, 1)
  assert.match((await run({ base: BASE })).log, /Input "head" is required/)
})

// ---- unreadable, empty and truncated input ----

const blockedCases = /** @type {[string, string][]} */ ([
  ['JSON', '{"status":"success"}\n'],
  ['an HTML error page', '<html><body>502 Bad Gateway</body></html>\n'],
  ['binary data', '\u0089PNG\r\n\u001a\n\u0000\u0000\u0000\rIHDR\u00ff\u00fe'],
  ['an empty file', ''],
  ['whitespace only', '\n \n'],
  ['an OpenMetrics document without # EOF', '# TYPE a gauge\na 1\n# TYPE b info\nb_info{x="1"} 1\n'],
])
for (const [label, text] of blockedCases) {
  for (const failAbove of ['', '1000000']) {
    test(`${label} as head fails with a clear message and no delta (fail-above ${failAbove || 'unset'})`, async () => {
      const r = await run({ base: BASE, head: file(text), 'fail-above': failAbove })
      assert.equal(r.code, 1)
      assert.match(r.log, /::error::The head scrape cannot be used: /)
      assert.equal(r.outputs.status, 'blocked')
      assert.equal('series-delta' in r.outputs, false)
      assert.equal('cost-delta' in r.outputs, false)
      assert.doesNotMatch(r.log, /Series delta/)
      assert.match(r.summary, /## ❌ Cardinality Diff/)
      assert.doesNotMatch(r.summary, /🟢|🟠|🔴|−|\/month\*\*/)
    })
  }
}

test('an unreadable base fails, instead of showing everything as new', async () => {
  const r = await run({ base: file('{"status":"success"}\n'), head: HEAD })
  assert.equal(r.code, 1)
  assert.match(r.log, /::error::The base scrape cannot be used: no metric families could be parsed/)
  assert.doesNotMatch(r.summary, /new metric|\+\d/)
  assert.equal('series-delta' in r.outputs, false)
})

test('both sides unusable lists both', async () => {
  const r = await run({ base: file(''), head: file('<html>') })
  assert.equal(r.code, 1)
  assert.match(r.log, /The base scrape cannot be used/)
  assert.match(r.log, /The head scrape cannot be used/)
})

test('a blocked result is posted to the pull request and replaces nothing green', async () => {
  const r = await run({ base: BASE, head: file('{"status":"success"}\n') }, { pr: true })
  assert.equal(r.code, 1)
  assert.equal(r.comments.length, 1)
  assert.match(r.comments[0], /^<!-- cardinality-diff -->\n## ❌ Cardinality Diff/)
  assert.doesNotMatch(r.comments[0], /🟢|active series\*\*/)
})

// ---- incomplete but usable ----

test('a few malformed lines keep the numbers but are marked incomplete and not green', async () => {
  const noisy = file(read(BASE) + 'this is not a metric\nbad{ 1\n')
  const r = await run({ base: BASE, head: noisy })
  assert.equal(r.code, 0)
  assert.equal(r.outputs.status, 'incomplete')
  assert.equal(r.outputs['series-delta'], '0')
  assert.match(r.log, /::warning::Incomplete result\. 2 malformed lines were skipped while parsing/)
  assert.match(r.summary, /## 🟠 Cardinality Diff/)
  assert.match(r.summary, /_incomplete_/)
  assert.doesNotMatch(r.summary, /🟢/)
})

test('a large drop in a text-format scrape is flagged for confirmation, not celebrated', async () => {
  const cut = file(read(HEAD).split('\n').slice(0, 60).join('\n') + '\n')
  const r = await run({ base: BASE, head: cut, 'fail-above': '0' })
  assert.equal(r.code, 0, 'a drop is not a failure')
  assert.equal(r.outputs.status, 'confirm')
  assert.equal(r.outputs['series-delta'], '-118')
  assert.match(r.log, /::warning::Unconfirmed reduction\. Active series went down by 118 per target, but this scrape cannot be proven complete/)
  assert.match(r.summary, /## 🟠 Cardinality Diff/)
  assert.match(r.summary, /_unconfirmed_/)
  assert.match(r.summary, /no end marker/)
  assert.doesNotMatch(r.summary, /🟢/)
})

test('a legitimately removed family still reports its reduction', async () => {
  const text = read(BASE).split('\n').filter((l) => !/^(# (HELP|TYPE) )?process_open_fds\b/.test(l)).join('\n')
  const r = await run({ base: BASE, head: file(text) })
  assert.equal(r.code, 0)
  assert.equal(r.outputs['series-delta'], '-1')
  assert.match(r.summary, /\*\*−1 active series\*\*/)
  assert.match(r.summary, /`process_open_fds` \| gauge \| 1 \| 0 \| −1 \(-100%\) \| .* \| removed/)
})

test('a complete OpenMetrics scrape (ends with # EOF) that shrinks is a trusted reduction', async () => {
  const text = read(OM).split('\n').filter((l) => !/^prometheus_http_requests(_total|_created)?\{code="503"/.test(l)).join('\n')
  const r = await run({ base: OM, head: file(text) })
  assert.equal(r.code, 0)
  assert.equal(r.outputs.status, 'ok')
  assert.match(r.summary, /## 🟢 Cardinality Diff/)
})

// ---- first run ----

test('an empty base fails by default and passes only with allow-empty-base', async () => {
  const empty = file('')
  assert.equal((await run({ base: empty, head: HEAD })).code, 1)
  assert.equal((await run({ base: empty, head: HEAD, 'allow-empty-base': 'false' })).code, 1)
  const r = await run({ base: empty, head: HEAD, 'allow-empty-base': 'true' })
  assert.equal(r.code, 0)
  assert.equal(r.outputs['series-delta'], '558')
  assert.match(r.log, /::warning::No base scrape\./)
  assert.match(r.summary, /every metric family counts as new/)
})

test('allow-empty-base never excuses an unreadable base, a truncated base or an empty head', async () => {
  const on = { 'allow-empty-base': 'true' }
  assert.equal((await run({ base: file('{"a":1}'), head: HEAD, ...on })).code, 1)
  assert.equal((await run({ base: file('# TYPE b info\nb_info 1\n'), head: HEAD, ...on })).code, 1)
  assert.equal((await run({ base: BASE, head: file(''), ...on })).code, 1)
  assert.equal((await run({ base: file(''), head: file(''), ...on })).code, 1)
})

test('allow-empty-base must be true or false', async () => {
  const r = await run({ base: BASE, head: HEAD, 'allow-empty-base': 'yes' })
  assert.equal(r.code, 1)
  assert.match(r.log, /Input "allow-empty-base" must be "true" or "false"/)
})

test('action.yml declares the opt-in, off by default, and the status output', () => {
  const yml = read(join(root, 'action.yml'))
  assert.match(yml, /\n {2}allow-empty-base:\n(?: {4}.*\n)*? {4}default: 'false'/)
  assert.match(yml, /\n {2}status:\n/)
  assert.ok(existsSync(join(root, 'action/index.js')))
})
