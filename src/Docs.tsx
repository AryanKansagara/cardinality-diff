import { Shell } from './Shell.tsx'

const a = (href: string, text: string) => <a href={href} target="_blank" rel="noreferrer">{text}</a>

export default function Docs() {
  return (
    <Shell name="Cardinality Diff" tagline="How the numbers are calculated">
      <section className="panel docs">
        <h2>What it reads</h2>
        <p>
          Prometheus text exposition format (0.0.4) and OpenMetrics 1.0, as served on <code>/metrics</code>. Every histogram
          bucket, <code>_sum</code> and <code>_count</code> is a separate series. OpenMetrics <code>_created</code> samples are
          parsed but not counted, because Prometheus 3 does not store them by default. Several timestamped samples of one series
          count once.
        </p>
        <p>
          Prometheus' own OpenMetrics output declares a gauge and a counter under one name (for example{' '}
          <code>go_memstats_alloc_bytes</code> and <code>go_memstats_alloc_bytes_total</code>). Both are kept as separate
          families instead of reporting an error.
        </p>

        <h2>Tested against real scrapes</h2>
        <ul>
          <li>{a('https://github.com/prometheus/node_exporter/blob/master/collector/fixtures/e2e-output.txt', 'node_exporter end-to-end fixture')}: 3,049 samples, 1,230 declared families, no parse errors.</li>
          <li>{a('https://github.com/prometheus/prometheus/tree/main/model/textparse/testdata', 'Prometheus parser test data')}: Prometheus' own <code>/metrics</code> in OpenMetrics, and the 237-family all-types file.</li>
          <li>{a('https://github.com/prometheus/OpenMetrics/tree/main/tests/testdata/parsers', 'OpenMetrics conformance suite')}: all 44 valid documents parse without errors, and 65 of the 167 invalid ones are reported. The parser is deliberately lenient: it still counts series in documents the spec rejects for reasons that do not change cardinality, such as negative counter values or metadata order.</li>
        </ul>
        <p className="small muted">Trimmed excerpts (Apache-2.0) are in the repository under <code>samples/real/</code> and run in the test suite. Checked 2026-11-16.</p>

        <h2>Risky labels</h2>
        <ul>
          <li><b>Unbounded</b>: most values look like UUIDs, timestamps, emails, IP addresses, raw URL paths with IDs, hashes or long numbers, or the label name suggests a per-entity value (<code>user_id</code>, <code>session</code>, <code>email</code>) and its values back that up.</li>
          <li><b>Suspicious</b>: one of the above for some values, or almost every series has its own value. Route templates, collector names and devices often look like this and are bounded.</li>
          <li>A label with a single value, or a label on an info metric (<code>*_info</code>, such as <code>build_info{'{'}revision{'}'}</code>), is only suspicious unless the pull request adds it.</li>
          <li>The same label with the same values on many families (one filesystem <code>uuid</code> on every <code>node_bcachefs_*</code> metric) is one finding.</li>
          <li>MAC addresses are not treated as IPv6 addresses.</li>
        </ul>

        <h2>Cost</h2>
        <p>
          Cost = series × scraped targets × DPM factor × price per 1,000 series per month. The default price is the Grafana
          Cloud Pro list rate of $6.50 per 1k series, with 10k active series included per account and a $19 monthly platform
          fee ({a('https://grafana.com/pricing/', 'grafana.com/pricing')}, checked 2026-11-16).
        </p>
        <p>
          Grafana Cloud bills the higher of active series and total data points per minute divided by the included DPM (1 on
          Pro), both at the 95th percentile of the month
          ({a('https://grafana.com/docs/grafana-cloud/cost-management-and-billing/understand-your-invoice/metrics-invoice/', 'metrics invoice docs')}).
          A 15-second scrape is 4 DPM, so each series bills as 4. Scrape intervals longer than a minute do not reduce the
          estimate below 1. The estimate is marginal: it ignores the free 10k and assumes your account is already above them.
        </p>
      </section>
    </Shell>
  )
}
