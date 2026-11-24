# Cardinality Diff

Catch Prometheus cardinality explosions in code review, before they show up on the bill.

Diff two `/metrics` scrapes (base branch vs pull request), see the active-series delta per metric family, get warnings for
labels that look unbounded (`user_id`, trace IDs, raw URL paths, emails, IPs, timestamps), and get a monthly cost estimate.
It ships as a static web tool and as a zero-dependency GitHub Action that comments on pull requests.

## The problem

Active series are what you pay for on Prometheus-compatible backends. One label with a per-request value turns one series
into thousands, and for a histogram every new value costs a full set of buckets plus `_sum` and `_count`. The change is a
one-line diff that looks harmless in review, and teams usually find out from the invoice:

- [Hacker News discussion](https://news.ycombinator.com/item?id=41500740): 70k active series and a $1,000+ bill,
  the most-cited complaint in the thread.
- [Prometheus docs, "Use labels"](https://prometheus.io/docs/practices/naming/#labels): "Do not use labels to store
  dimensions with high cardinality (many different label values), such as user IDs, email addresses, or other unbounded sets of values."
- Grafana Cloud's Adaptive Metrics reduces cost after series already exist. Cardinality Diff moves the check earlier, into the pull request.

## Web tool

`npm run dev`, then open the printed URL. Everything runs in your browser; nothing is uploaded.

- **Diff** mode compares a base and head scrape; **Audit** mode inspects a single scrape.
- Paste, upload, or drag and drop a scrape, or click **Load sample** (a Go service where a PR adds `user_id` and raw `path`
  labels to `http_request_duration_seconds` and a new `orders_processed_total{order_id}` counter).
- Per metric family: type, series count, labels with distinct-value counts, histogram bucket count.
- Diff table sorted by series delta, with new labels highlighted and a $/month delta per row.
- Risky-label findings explain why each label is risky and how to fix it: route templates instead of raw paths, remove the
  label, a metric-scoped `metric_relabel_configs` stop-gap you can copy, or exemplars, logs and traces for per-event detail.
- **Projected production cardinality**: a dev scrape has 30 user IDs, production has 50,000. Enter the expected count per
  flagged label to recompute series and cost (worst case: label values are treated as independent).
- Cost = series × scraped targets × DPM factor × price per 1,000 active series per month. The default of $6.50 is the
  [Grafana Cloud Pro list price](https://grafana.com/pricing/) (checked 2026-11-16); the first 10k series per account are free.
  Grafana Cloud bills the higher of active series and total data points per minute over the included 1 DPM
  ([metrics invoice docs](https://grafana.com/docs/grafana-cloud/cost-management-and-billing/understand-your-invoice/metrics-invoice/)),
  so a 15s scrape interval bills each series as 4. All three are configurable.
- `/docs` explains the parser, the detector rules and the cost model, with sources.
- **Copy share link** encodes the inputs into the URL hash (deflate-raw + base64url). **Copy PR comment** produces the same Markdown as the Action.

### Parser

Handles the Prometheus text exposition format and OpenMetrics 1.0: `# HELP` / `# TYPE` / `# UNIT`, escaping in label values
and HELP text, trailing commas, `+Inf` / `-Inf` / `NaN`, timestamps, histogram `_bucket` / `_sum` / `_count`, summary
quantiles, OpenMetrics `_total` / `_created`, exemplars, `# EOF`, and Prometheus 3 quoted UTF-8 metric and label names.
Malformed lines (duplicate series, bad escapes, missing values, unknown types, content after `# EOF`) are reported with line
numbers and skipped; parsing continues.

Several timestamped samples of one series count once, and a gauge and counter declared under one name (as Prometheus'
own OpenMetrics output does for `go_memstats_alloc_bytes`) stay separate families.

Tested against real scrapes: node_exporter's end-to-end fixture, Prometheus' own `/metrics` in OpenMetrics and the
Prometheus parser test data, and the OpenMetrics conformance suite (all 44 valid documents parse cleanly). Trimmed
excerpts (Apache-2.0, with sources in the test file) live in `samples/real/` and run in `npm test`.

Series are counted as Prometheus stores them: every bucket, `_sum` and `_count` is its own series. OpenMetrics `_created`
lines are parsed but not counted, since Prometheus 3 does not ingest them as series by default.

## GitHub Action

```yaml
- uses: AryanKansagara/cardinality-diff@v1
  with:
    base: ${{ runner.temp }}/base.prom
    head: ${{ runner.temp }}/head.prom
    multiplier: 12        # pods/replicas exposing these metrics
    price-per-1k: 6.5     # USD per 1,000 active series per month
    scrape-interval: 15   # seconds; Grafana Cloud bills 60/interval DPM per series
    fail-above: 500       # optional: fail when the per-target series delta exceeds this
```

| Input | Default | |
|---|---|---|
| `base` | required | Path to the base branch scrape |
| `head` | required | Path to the PR head scrape |
| `multiplier` | `1` | Number of scraped targets |
| `price-per-1k` | `6.5` | USD per 1,000 active series per month |
| `scrape-interval` | `60` | Seconds between scrapes; below 60 multiplies cost by 60/interval |
| `fail-above` | none | Fail the step if the series delta is above this |
| `allow-empty-base` | `false` | Accept an empty base scrape (first run). See [Unreadable, empty or cut-off scrapes](#unreadable-empty-or-cut-off-scrapes) |
| `github-token` | `${{ github.token }}` | Needs `pull-requests: write` |

Outputs: `series-delta` and `cost-delta` (USD per month), and `status` (`ok`, `confirm`, `incomplete` or `blocked`, below).
`series-delta` and `cost-delta` are not set when the status is `blocked`. The action creates one PR comment and updates it on later pushes
(found by a hidden marker), writes the same report to the job summary, and annotates malformed lines as warnings. It runs on
`node20` with no dependencies and no build step.

### Unreadable, empty or cut-off scrapes

A comparison is only as good as the two files. The Action and the web tool never turn a bad file into a result:

| Situation | What happens |
|---|---|
| A side has **no metric families**: JSON, an HTML error page, binary data (`unreadable`), or a blank file, or only comments or `# EOF` (`empty`) | **Blocked.** No delta, savings or cost; `❌` comment; the step **fails (exit 1) even when `fail-above` is unset**; `series-delta`/`cost-delta` are not set. Applies to base and head alike, so an unreadable base cannot make everything look newly added. |
| An **OpenMetrics** document without its mandatory `# EOF` line | **Blocked** as truncated. The [OpenMetrics spec](https://prometheus.io/docs/specs/om/open_metrics_spec/#overall-structure) says "Expositions MUST end with EOF", so a missing one proves the document is incomplete. A document counts as OpenMetrics if it has `# EOF`, a `# UNIT` line, an exemplar, a `info` / `stateset` / `gaugehistogram` / `unknown` type, or `# TYPE foo counter` with a `foo_total` sample (the text format declares the full name, `# TYPE foo_total counter`). |
| Some **malformed lines** in an otherwise valid scrape | Same numbers as before, status `incomplete`: `🟠` at best, labelled _incomplete_, with a warning. The rule is "any skipped line", with no percentage threshold: a line that was skipped is a series that was not counted, however few. The step passes unless `fail-above` is exceeded. |
| The **series count went down** and the head has no `# EOF` | Status `confirm`: the reduction is reported (a legitimately removed family still shows as removed, with its delta), but flagged _unconfirmed_ and never `🟢`, with a note to confirm the removed metrics were removed on purpose. The step passes. |

The text format 0.0.4 has no end marker, so a scrape cut off at a line boundary cannot be told from a complete one. That is why every net decrease is flagged, not only large ones: a cut near the end of the file is as small as a small legitimate removal, and any cut-off we picked would be arbitrary. A reduction in an OpenMetrics scrape that ends with `# EOF` is proven complete and stays green. A cut-off *base* is not detectable in the text format either; it can only make a PR look like it adds series, never like it saves them.

**First run.** When there is no base yet, set `allow-empty-base: true` to compare against nothing: every family counts as new and the comment says so. It is off by default, accepts only a base with no metric families and no malformed lines (an unreadable or truncated base still fails), and an empty head is never accepted.

```yaml
- uses: AryanKansagara/cardinality-diff@v1
  with:
    base: ${{ runner.temp }}/base.prom   # may be an empty file on the very first run
    head: ${{ runner.temp }}/head.prom
    allow-empty-base: true   # only while bootstrapping; remove it once the base scrape exists
```

In the web tool the same states appear as an explicit "Could not compare these scrapes" panel instead of the stats, and the Diff tab refuses an empty base (use Audit mode to inspect a single scrape).

### Example workflow

The scrape must contain the series the code produces, so exercise the service before scraping: a few smoke requests, or
your integration tests.

```yaml
name: Cardinality Diff
on: pull_request

permissions:
  contents: read
  pull-requests: write

jobs:
  cardinality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-go@v5
        with: { go-version: stable }

      - name: Write scrape helper
        run: |
          cat > "$RUNNER_TEMP/scrape.sh" <<'EOF'
          set -euo pipefail
          go build -o "$RUNNER_TEMP/app" ./cmd/server
          "$RUNNER_TEMP/app" & pid=$!
          for i in $(seq 30); do curl -sf localhost:8080/healthz >/dev/null && break; sleep 1; done
          # Exercise the code paths whose metrics you care about.
          curl -s localhost:8080/api/users/42 >/dev/null
          curl -s localhost:8080/api/users/43 >/dev/null
          curl -s -X POST localhost:8080/api/orders -d '{"sku":"A1"}' >/dev/null
          curl -sf localhost:8080/metrics > "$1"
          kill $pid
          EOF

      - name: Scrape head
        run: bash "$RUNNER_TEMP/scrape.sh" "$RUNNER_TEMP/head.prom"

      - name: Scrape base
        run: |
          git checkout --quiet ${{ github.event.pull_request.base.sha }}
          bash "$RUNNER_TEMP/scrape.sh" "$RUNNER_TEMP/base.prom"
          git checkout --quiet -

      - uses: AryanKansagara/cardinality-diff@v1
        with:
          base: ${{ runner.temp }}/base.prom
          head: ${{ runner.temp }}/head.prom
          multiplier: 12
          fail-above: 500
```

No server to run? Dump the registry from a test instead and run it on both commits:

```go
func TestDumpMetrics(t *testing.T) {
	srv := httptest.NewServer(newRouter()) // exercise handlers so labelled series exist
	defer srv.Close()
	http.Get(srv.URL + "/api/users/42")

	mfs, err := prometheus.DefaultGatherer.Gather()
	if err != nil { t.Fatal(err) }
	f, _ := os.Create(os.Getenv("METRICS_OUT"))
	defer f.Close()
	for _, mf := range mfs { expfmt.MetricFamilyToText(f, mf) }
}
```

```sh
METRICS_OUT=$RUNNER_TEMP/head.prom go test ./... -run TestDumpMetrics
```

### Sample PR comment

> ## 🔴 Cardinality Diff
>
> **+416 active series** per target (142 → 558, +293%) · **+$32.45/month** at 12× targets and $6.50/1k series
>
> | Metric | Type | Base | Head | Δ series | Δ $/month | Note |
> |---|---|--:|--:|--:|--:|---|
> | `http_request_duration_seconds` | histogram | 112 | 504 | +392 (+350%) | +$30.58 | new label `path`, `user_id` |
> | `orders_processed_total` | counter | 0 | 24 | +24 (new) | +$1.87 | new metric |
>
> ### ⚠️ 3 risky labels
>
> - **`http_request_duration_seconds{path}`** (new): 27 values in this scrape, each new value adds ≥14 series. 24 of 27 values look like raw URL paths containing IDs or query strings. _Fix: label by route template, not raw path._
> - **`http_request_duration_seconds{user_id}`** (new): 35 values in this scrape, each new value adds ≥14 series. 35 of 35 values look like long numeric IDs. _Fix: remove the label from instrumentation._
> - **`orders_processed_total{order_id}`** (new): 24 values in this scrape, each new value adds ≥1 series. 24 of 24 values look like UUIDs. _Fix: remove the label from instrumentation._
>
> <details><summary>Suggested fixes</summary>
>
> ```yaml
> metric_relabel_configs:
>   - source_labels: [__name__, path]
>     regex: 'http_request_duration_seconds_(bucket|count|sum);/api/users/[^/]+([?#].*)?'
>     target_label: path
>     replacement: '/api/users/:id'
> ```
> </details>

Try it locally against the samples (the API call is skipped without a PR context):

```sh
env INPUT_BASE=samples/base.prom INPUT_HEAD=samples/head.prom INPUT_MULTIPLIER=12 INPUT_FAIL-ABOVE=500 node action/index.js
```

## Local development

```sh
npm install
npm run dev     # web tool
npm test        # parser, diff, detector, cost, share-link, incomplete-input and Action (`node action/index.js`) tests (node:test)
npm run build   # type-check and production build into dist/
npm run test:e2e  # builds, then runs the Playwright (Chromium) suite against `vite preview`
```

The E2E suite lives in `e2e/` and runs against the production build. Install the browser once with
`npx playwright install chromium` (add `--with-deps` on a fresh Linux machine). Tests use only synthetic scrapes, block every
non-local request (the web fonts are the only external requests the app makes), and fail on uncaught page errors.
It listens on port 4179; set `E2E_PORT` to use another. GitHub Actions (`.github/workflows/ci.yml`) runs `npm ci`, build,
unit tests and E2E on every pull request and push to `main`, and caches the Chromium download by Playwright version.

`src/core.js` holds all the logic (parser, diff, risk detection, cost, Markdown rendering, share encoding) as plain ESM with
JSDoc types, so the React app and the Action share one implementation without a build step. `src/App.tsx` is the UI;
`action/index.js` is the Action entry point; `samples/` holds the demo scrapes.

## Limitations

- Counts series per scrape target. Labels added by Prometheus at scrape time (`job`, `instance`) and by relabeling are not
  visible in the scrape; account for targets with the multiplier.
- The detector is heuristic: value shapes, label names, and distinct-to-series ratio. On a real node_exporter scrape it
  reports hardware identity labels (filesystem UUIDs, IPVS addresses) as findings; single-value and info-metric labels are
  downgraded to suspicious, and one label repeated across families is grouped into one finding. A dev scrape only shows the values you
  exercised, which is what the production projection is for.
- Projection assumes flagged labels vary independently, so it is an upper bound.
- Native histograms are not part of the text format and are not modelled.
- Text format 0.0.4 cannot prove a scrape is complete (see above). A scrape that is mostly garbage but contains a few valid lines is reported as `incomplete`, not blocked, because only "no metric families at all" is provably unreadable.
- A hand-written scrape that mixes text-format syntax with the OpenMetrics-only markers listed above is read as OpenMetrics and blocked until it ends with `# EOF`.

Built by Aryan Kansagara.
