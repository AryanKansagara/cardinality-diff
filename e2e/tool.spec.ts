import type { Page } from '@playwright/test'
import { test, expect } from './fixtures.ts'

// Synthetic exposures (no real services or people). Base: 2 routes + 1 gauge = 3 series.
// Head: the same counter gains a per-user `user_id` label, 2 routes x 30 users = 60 series, + 1 gauge = 61.
const base = `# HELP shop_requests_total Requests served.
# TYPE shop_requests_total counter
shop_requests_total{route="/cart"} 12
shop_requests_total{route="/checkout"} 7
# TYPE shop_up gauge
shop_up 1
`
const userIds = Array.from({ length: 30 }, (_, i) => String(100_000 + i * 7919))
const head = `# HELP shop_requests_total Requests served.
# TYPE shop_requests_total counter
${['/cart', '/checkout'].flatMap((route) => userIds.map((u) => `shop_requests_total{route="${route}",user_id="${u}"} 1`)).join('\n')}
# TYPE shop_up gauge
shop_up 1
`

const baseBox = (page: Page) => page.getByLabel('Base (main branch) metrics')
const headBox = (page: Page) => page.getByLabel('Head (pull request) metrics')
const stat = (page: Page, label: string) => page.locator('.stat', { has: page.getByText(label, { exact: true }) })

async function openDiff(page: Page) {
  await page.goto('/app')
  await baseBox(page).fill(base)
  await headBox(page).fill(head)
}

test('landing page links to the tool and docs render', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('series explosion')
  await page.goto('/docs')
  await expect(page.locator('main')).toContainText(/parser/i)
  await page.goto('/app')
  await expect(page.getByRole('heading', { name: 'One new label can multiply your metrics bill.' })).toBeVisible()
})

test('diffing two scrapes shows the cardinality change and its cost', async ({ page }) => {
  await openDiff(page)
  await expect(stat(page, 'Series per target')).toContainText('3 → 61')
  await expect(stat(page, 'Series delta')).toContainText('+58')
  // 58 series x 10 default targets x $6.50 per 1,000 series = $3.77 a month
  await expect(stat(page, 'Monthly cost delta')).toContainText('+$3.77')
  const row = page.locator('tbody tr', { hasText: 'shop_requests_total' })
  await expect(row).toContainText('changed')
  await expect(row).toContainText('+user_id')
  await expect(row.locator('td').nth(2)).toHaveText('2')
  await expect(row.locator('td').nth(3)).toHaveText('60')
  await expect(row.locator('td').nth(4)).toHaveText('+58')
  // Unchanged families are hidden until asked for.
  await expect(page.locator('tbody tr', { hasText: 'shop_up' })).toHaveCount(0)
  await page.getByLabel(/Show unchanged/).check()
  await expect(page.locator('tbody tr', { hasText: 'shop_up' })).toBeVisible()

  // Cost inputs feed the estimate.
  await page.getByLabel('Scraped targets').fill('100')
  await expect(stat(page, 'Monthly cost delta')).toContainText('+$37.70')
})

test('an added high-cardinality label is flagged, and only that one', async ({ page }) => {
  await openDiff(page)
  await expect(stat(page, 'Risky labels')).toContainText('1')
  const finding = page.locator('.finding', { hasText: 'shop_requests_total' })
  await expect(finding).toContainText('{user_id}')
  await expect(finding).toContainText('new label')
  await expect(finding).toContainText('Unbounded')
  await expect(finding).toContainText('30 distinct values')
  await expect(page.locator('.finding')).toHaveCount(1)

  // Projecting production volume recomputes series: 60 series for 30 users -> 2 per user, so 50,000 users = 100,000.
  await finding.getByLabel(/Expected distinct/).fill('50000')
  await expect(finding).toContainText('100,000 series')
  await expect(stat(page, 'Projected in production')).toContainText('100,001')

  // Same label set on both sides: nothing to flag.
  await headBox(page).fill(base)
  await expect(page.locator('.finding.good')).toContainText('No unbounded-looking labels found in this change')
  await expect(stat(page, 'Series delta')).toContainText('±0')
})

test('a label is flagged by the shape of its values even when its name looks harmless', async ({ page }) => {
  // 20 UUIDs under a neutral label name (`ref`): only the value shapes give it away.
  const uuid = (i: number) => `3f2b8c1e-5a4d-4e6f-9b0a-${String(i).padStart(12, '0')}`
  const orders = Array.from({ length: 20 }, (_, i) => `shop_orders_total{ref="${uuid(i)}"} 1`).join('\n')
  await page.goto('/app')
  await baseBox(page).fill('# TYPE shop_orders_total counter\nshop_orders_total{ref="a"} 1\n')
  await headBox(page).fill(`# TYPE shop_orders_total counter\n${orders}\n`)
  const finding = page.locator('.finding', { hasText: 'shop_orders_total' })
  await expect(finding).toContainText('{ref}')
  await expect(finding).toContainText('Unbounded')
  await expect(finding).toContainText('20 of 20 values look like UUIDs')
  await expect(stat(page, 'Series delta')).toContainText('+19')
})

test('copy PR comment puts the same report on the clipboard', async ({ page }) => {
  await openDiff(page)
  await page.getByRole('button', { name: 'Copy PR comment' }).click()
  await expect(page.getByRole('status')).toHaveText('PR comment Markdown copied.')
  const md = await page.evaluate(() => navigator.clipboard.readText())
  expect(md).toContain('<!-- cardinality-diff -->')
  expect(md).toContain('**+58 active series** per target (3 → 61')
  expect(md).toContain('+$3.77/month')
  expect(md).toContain('`shop_requests_total{user_id}`')
})

test('share link restores the inputs after a reload and in a fresh tab', async ({ page, context }) => {
  await openDiff(page)
  await page.getByLabel('Scraped targets').fill('25')
  await page.getByRole('button', { name: 'Copy share link' }).click()
  await expect(page.getByRole('status')).toHaveText('Share link copied to clipboard.')
  const link = await page.evaluate(() => navigator.clipboard.readText())
  expect(link).toMatch(/\/app#s=[\w-]+$/)
  expect(page.url()).toBe(link)

  // 58 x 25 x $6.50 / 1000 = $9.43
  for (const target of [page, await context.newPage()]) {
    if (target === page) await page.reload()
    else await target.goto(link)
    await expect(baseBox(target)).toHaveValue(base)
    await expect(headBox(target)).toHaveValue(head)
    await expect(target.getByLabel('Scraped targets')).toHaveValue('25')
    await expect(stat(target, 'Series delta')).toContainText('+58')
    await expect(stat(target, 'Monthly cost delta')).toContainText('+$9.43')
  }
})

test('a corrupt share link says so and leaves the tool usable', async ({ page }) => {
  await page.goto('/app#s=not-a-real-link')
  await expect(page.getByRole('status')).toHaveText('That share link could not be decoded.')
  await page.getByRole('button', { name: 'Load sample' }).first().click()
  await expect(stat(page, 'Series delta')).not.toContainText('±0')
})

test('theme choice persists across reloads', async ({ page }) => {
  await page.goto('/app')
  const mode = () => page.evaluate(() => document.documentElement.dataset.themeMode)
  expect(await mode()).toBe('light')
  await page.getByRole('button', { name: 'Switch to dark theme' }).click()
  expect(await mode()).toBe('dark')
  await page.reload()
  expect(await mode()).toBe('dark')
  await expect(page.getByRole('button', { name: 'Switch to light theme' })).toBeVisible()
})

test.describe('unreadable or wrong-format files', () => {
  const bad: Array<[string, { name: string; mimeType: string; buffer: Buffer }]> = [
    ['JSON', { name: 'metrics.json', mimeType: 'application/json', buffer: Buffer.from('{"status":"success","data":[1,2]}') }],
    ['an HTML error page', { name: 'metrics.txt', mimeType: 'text/plain', buffer: Buffer.from('<html><body>502 Bad Gateway</body></html>') }],
    ['a binary image', { name: 'metrics.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0xff, 0xfe]) }],
  ]
  for (const [label, file] of bad) {
    test(`${label} is reported with line numbers and the app stays usable`, async ({ page }) => {
      await page.goto('/app')
      const panel = page.locator('.panel', { has: headBox(page) })
      await panel.locator('input[type=file]').setInputFiles(file)
      await expect(panel.locator('.badge.bad')).toContainText(/malformed line/)
      await expect(panel.locator('.errors li').first()).toContainText('Line 1:')
      await expect(panel.getByText('Parsed cleanly')).toHaveCount(0)
      await expect(panel).toContainText('0 families · 0 series')
      // Nothing is silently reported as a clean result.
      await expect(page.locator('.finding.good')).toHaveCount(0)

      // Recover: replace it with valid input and get a normal report.
      await baseBox(page).fill(base)
      await headBox(page).fill(head)
      await expect(panel.getByText('Parsed cleanly')).toBeVisible()
      await expect(stat(page, 'Series delta')).toContainText('+58')
    })
  }

  test('a partly valid scrape keeps the good lines and flags the bad ones', async ({ page }) => {
    await page.goto('/app')
    await headBox(page).fill('# TYPE ok gauge\nok 1\nthis is not a metric\nok_two{a="1"} nope\nok_three 3\n')
    const panel = page.locator('.panel', { has: headBox(page) })
    await expect(panel).toContainText('2 malformed lines')
    await expect(panel.locator('.errors')).toContainText('Line 3:')
    await expect(panel.locator('.errors')).toContainText('Line 4:')
    await expect(panel).toContainText('2 families · 2 series')
  })

  test('an empty file shows no false success', async ({ page }) => {
    await page.goto('/app')
    await headBox(page).fill('')
    await baseBox(page).fill('')
    await expect(page.getByText('Parsed cleanly')).toHaveCount(0)
    await expect(page.getByText('No metric families changed.')).toBeVisible()
  })
})

test('audit mode inspects a single scrape and loads the bundled real scrape', async ({ page }) => {
  await page.goto('/app')
  await page.getByRole('tab', { name: /Audit/ }).click()
  await expect(baseBox(page)).toHaveCount(0)
  await page.getByLabel('Scrape metrics').fill(head)
  await expect(stat(page, 'Active series per target')).toContainText('61')
  await expect(page.locator('.finding', { hasText: 'shop_requests_total' })).toContainText('{user_id}')
  await page.getByRole('button', { name: 'Real node_exporter scrape' }).click()
  await expect(page.getByText('Parsed cleanly')).toBeVisible()
  await expect(page.locator('tbody tr', { hasText: 'node_btrfs_device_size_bytes' })).toBeVisible()
})
