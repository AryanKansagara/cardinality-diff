import { RouteApp } from './router.tsx'
import { Landing, MockFrame, MockStat, MockBars, MockList } from './Landing.tsx'
import Tool from './Tool.tsx'

function ProductLanding() {
  return (
    <Landing
      name="Cardinality Diff"
      icon="ssid_chart"
      tagline="Prometheus cardinality & cost analyzer"
      headline="See the series explosion *before it hits your bill*"
      support="Diff two /metrics scrapes or audit a single scrape. Estimate Grafana Cloud series cost and flag risky label combinations."
      audience="For platform and observability engineers reviewing Prometheus changes."
      features={[
        {
          icon: 'compare_arrows',
          title: 'Diff scrapes',
          body: 'Compare before/after /metrics output and see series delta per family.',
        },
        {
          icon: 'attach_money',
          title: 'Monthly cost projection',
          body: 'Estimate Grafana Cloud active-series spend from the scrape you paste.',
        },
        {
          icon: 'report',
          title: 'Risk findings',
          body: 'Flag high-cardinality labels like path, user, or unbounded IDs.',
        },
      ]}
      slides={[
        {
          title: 'Diff summary',
          caption: 'Active series delta and projected monthly cost.',
          preview: (
            <MockFrame title="Diff summary">
              <div className="mock-stats">
                <MockStat label="Series Δ" value="+128k" tone="bad" />
                <MockStat label="Est. cost" value="$42/mo" tone="warn" />
                <MockStat label="Families" value="312" />
              </div>
            </MockFrame>
          ),
        },
        {
          title: 'Largest families',
          caption: 'Which metrics dominate the series count.',
          preview: (
            <MockFrame title="Largest families">
              <MockBars
                items={[
                  { label: 'http_requests_total', w: 92, tone: 'bad' },
                  { label: 'pod_cpu', w: 68 },
                  { label: 'custom_job_labels', w: 54, tone: 'warn' },
                ]}
              />
            </MockFrame>
          ),
        },
        {
          title: 'Risks',
          caption: 'Label combinations that can explode cardinality.',
          preview: (
            <MockFrame title="Risks">
              <MockList
                items={[
                  { badge: 'Bad', text: 'Unbounded path label on http_requests_total', tone: 'bad' },
                  { badge: 'Warn', text: 'user_id label multiplies series per tenant', tone: 'warn' },
                  { badge: 'Warn', text: 'Raw URL query values in label set', tone: 'warn' },
                ]}
              />
            </MockFrame>
          ),
        },
      ]}
    />
  )
}

export default function App() {
  return <RouteApp landing={<ProductLanding />} tool={<Tool />} />
}
