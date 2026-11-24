import { test as base, expect } from '@playwright/test'

// Hosts the app tries to reach (web fonts). They are blocked, never fetched: tests must not depend on the network.
const EXPECTED_BLOCKED = ['fonts.googleapis.com', 'fonts.gstatic.com']

export const test = base.extend<{ blocked: string[]; pageErrors: Error[] }>({
  blocked: [async ({ context }, use) => {
    const blocked: string[] = []
    await context.route(/^(?!https?:\/\/127\.0\.0\.1[:/]).*/, (route) => {
      const url = route.request().url()
      // data: and blob: URLs are not network requests.
      if (/^(data|blob):/.test(url)) return route.continue()
      blocked.push(new URL(url).host)
      return route.abort('blockedbyclient')
    })
    await use(blocked)
  }, { auto: true }],

  pageErrors: [async ({ page, blocked }, use) => {
    const errors: Error[] = []
    page.on('pageerror', (e) => errors.push(e))
    await use(errors)
    // After the test: nothing threw, and nothing outside the known font hosts was requested.
    expect(errors, 'uncaught page errors').toEqual([])
    expect(blocked.filter((h) => !EXPECTED_BLOCKED.includes(h)), 'unexpected external requests').toEqual([])
  }, { auto: true }],
})

export { expect }
