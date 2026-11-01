// GitHub Action entry point. Zero dependencies: reads inputs from env, talks to the REST API with fetch.
import { readFileSync, appendFileSync } from 'node:fs'
import { parse, diff, findRisks, monthlyCost, renderMarkdown, signed, usd, MARKER } from '../src/core.js'

const env = process.env
const input = (/** @type {string} */ name) => (env[`INPUT_${name.toUpperCase()}`] ?? '').trim()
const num = (/** @type {string} */ name, /** @type {number} */ def) => {
  const v = input(name)
  if (v === '') return def
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) throw new Error(`Input "${name}" must be a non-negative number, got "${v}"`)
  return n
}
const output = (/** @type {string} */ k, /** @type {string|number} */ v) => env.GITHUB_OUTPUT && appendFileSync(env.GITHUB_OUTPUT, `${k}=${v}\n`)

async function gh(/** @type {string} */ path, /** @type {RequestInit} */ init = {}) {
  const res = await fetch(`${env.GITHUB_API_URL ?? 'https://api.github.com'}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${input('github-token')}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' },
  })
  if (!res.ok) throw new Error(`GitHub API ${init.method ?? 'GET'} ${path}: ${res.status} ${await res.text()}`)
  return res.json()
}

async function upsertComment(/** @type {string} */ body) {
  const event = env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) : {}
  const pr = event.pull_request?.number ?? event.issue?.number
  if (!pr || !env.GITHUB_REPOSITORY || !input('github-token')) {
    console.log('No pull request or token in context; skipping PR comment.')
    return
  }
  const repo = `/repos/${env.GITHUB_REPOSITORY}`
  let existing = null
  for (let page = 1; !existing; page++) {
    const batch = await gh(`${repo}/issues/${pr}/comments?per_page=100&page=${page}`)
    existing = batch.find((/** @type {{body?: string}} */ c) => c.body?.startsWith(MARKER))
    if (batch.length < 100) break
  }
  if (existing) await gh(`${repo}/issues/comments/${existing.id}`, { method: 'PATCH', body: JSON.stringify({ body }) })
  else await gh(`${repo}/issues/${pr}/comments`, { method: 'POST', body: JSON.stringify({ body }) })
  console.log(`${existing ? 'Updated' : 'Created'} comment on #${pr}`)
}

try {
  const read = (/** @type {string} */ name) => {
    const p = input(name)
    if (!p) throw new Error(`Input "${name}" is required`)
    return readFileSync(p, 'utf8')
  }
  const base = parse(read('base')), head = parse(read('head'))
  for (const [which, r] of /** @type {const} */ ([['base', base], ['head', head]])) {
    for (const e of r.errors.slice(0, 20)) console.log(`::warning file=${input(which)},line=${e.line}::${e.message}`)
  }
  const multiplier = num('multiplier', 1), pricePer1k = num('price-per-1k', 6.5)
  const failAbove = input('fail-above') === '' ? null : num('fail-above', 0)
  const d = diff(base, head)
  const risks = findRisks(head, base)
  const cost = monthlyCost(d.delta, multiplier, pricePer1k)
  const md = renderMarkdown({ diff: d, risks, multiplier, pricePer1k, failAbove, errors: base.errors.length + head.errors.length })

  console.log(`Series delta ${signed(d.delta)} per target, ${usd(cost, true)}/month, ${risks.length} risky label(s)`)
  output('series-delta', d.delta)
  output('cost-delta', cost.toFixed(2))
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, md + '\n')
  else console.log('\n' + md)
  await upsertComment(md)
  if (failAbove !== null && d.delta > failAbove) {
    console.log(`::error::Series delta ${d.delta} exceeds fail-above (${failAbove})`)
    process.exitCode = 1
  }
} catch (e) {
  console.log(`::error::${e instanceof Error ? e.message : e}`)
  process.exitCode = 1
}
