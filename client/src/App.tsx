import { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';
import {
  analyzeIdea,
  generateBlueprint,
  reanalyzeIdea,
  refineIdea,
  type GtmFocus,
  type Report
} from './api';

mermaid.initialize({ startOnLoad: false, theme: 'neutral' });

function scoreClass(score: number): string {
  if (score >= 70) return 'high';
  if (score >= 45) return 'mid';
  return 'low';
}

/** Real client-side SHA-256 — the idea is fingerprinted before it leaves the browser. */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text)
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const VERDICT_COPY: Record<string, string> = {
  strong: 'Strong — go build it',
  promising: 'Promising — sharpen and go',
  uphill: 'Uphill — real obstacles to clear',
  weak: 'Weak — rethink the wedge'
};

/* ── Terminal-style progress ─────────────────────────── */

const ANALYSIS_LINES = [
  'connection established → analysis service',
  'computing SHA-256 idea fingerprint (local)',
  'generating research queries',
  'querying Hacker News · GitHub · Reddit',
  'scoring five GTM lenses',
  'adversarial pass — attempting to kill the idea',
  'compiling verdict'
];

const BLUEPRINT_LINES = [
  'connection established → analysis service',
  'loading viability report',
  'decomposing MVP into ForkLaunch modules',
  'rendering system diagram',
  'generating scaffold commands (CLI v1.4)',
  'writing build prompt + ship runbook'
];

function TerminalProgress({
  label,
  lines,
  fingerprint
}: {
  label: string;
  lines: string[];
  fingerprint?: string;
}) {
  const [step, setStep] = useState(0);
  const start = useRef(Date.now());
  useEffect(() => {
    const id = setInterval(
      () => setStep((s) => Math.min(s + 1, lines.length - 1)),
      8000
    );
    return () => clearInterval(id);
  }, [lines.length]);
  const ts = (i: number) =>
    `${String(Math.floor((Math.min(i, step) * 8 + (Date.now() - start.current) / 8000) / 60)).padStart(2, '0')}:${String(Math.round(Math.min(i * 8, (Date.now() - start.current) / 1000)) % 60).padStart(2, '0')}`;
  return (
    <div className="card">
      <h2>{label}</h2>
      <div className="term" aria-live="polite">
        {lines.slice(0, step + 1).map((l, i) => (
          <div key={i} className={`term-line ${i < step ? 'done' : 'active'}`}>
            <span className="t">{ts(i)}</span>
            <span className="marker">{i < step ? '✓' : '▸'}</span>
            <span>
              {l}
              {l.includes('fingerprint') && fingerprint && (
                <span className="term-fp"> {fingerprint.slice(0, 16)}…</span>
              )}
            </span>
          </div>
        ))}
      </div>
      <p className="meta" style={{ marginTop: '0.8rem' }}>
        Real research, not vibes — this takes about a minute.
      </p>
    </div>
  );
}

/* ── Mermaid + copy helpers ──────────────────────────── */

function Mermaid({ chart }: { chart: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    mermaid
      .render(`d${Math.floor(Math.random() * 1e9)}`, chart)
      .then(({ svg }) => {
        if (!cancelled && ref.current) ref.current.innerHTML = svg;
      })
      .catch(() => {
        if (ref.current)
          ref.current.innerHTML = `<pre class="diagram-fallback">${chart.replaceAll('<', '&lt;')}</pre>`;
      });
    return () => {
      cancelled = true;
    };
  }, [chart]);
  return <div className="diagram" ref={ref} />;
}

function CopyBlock({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-block">
      <button
        className="copy-btn"
        onClick={() => {
          void navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        }}
      >
        {copied ? '✓ copied' : (label ?? 'copy')}
      </button>
      <pre>{text}</pre>
    </div>
  );
}

/* ── Enterprise readiness Q&A ─────────────────────────── */

interface ReadinessQuestion {
  id: string;
  category: string;
  question: string;
  detail: string;
  weight: number;
  remediation: string;
}

const READINESS_QUESTIONS: ReadinessQuestion[] = [
  {
    id: 'sso',
    category: 'Identity',
    question: 'Will you support SSO (SAML / OIDC) at launch?',
    detail: 'Enterprise buyers routinely disqualify vendors without SSO in security review.',
    weight: 15,
    remediation: 'ForkLaunch iam-better-auth ships OIDC/social/SSO flows out of the box — add it with `forklaunch init module iam --module iam-better-auth`.'
  },
  {
    id: 'rbac',
    category: 'Identity',
    question: 'Do you have role-based access control with least-privilege roles?',
    detail: 'Admins, editors, viewers — and the ability to prove who can do what.',
    weight: 10,
    remediation: 'ForkLaunch handlers take allowedRoles/allowedPermissions per route; role surfacing comes from the IAM module.'
  },
  {
    id: 'audit',
    category: 'Data protection',
    question: 'Is every data access audit-logged?',
    detail: 'Security teams ask for access trails during procurement, and regulators after incidents.',
    weight: 12,
    remediation: 'ForkLaunch request telemetry logs every call with correlation ids; compliance entities record retention events.'
  },
  {
    id: 'encryption',
    category: 'Data protection',
    question: 'Is sensitive data encrypted at rest with managed keys?',
    detail: 'Field-level encryption, not just disk encryption, for PII and secrets.',
    weight: 15,
    remediation: 'ForkLaunch compliance entities encrypt classified fields (AES-256-GCM, per-tenant HKDF keys) before they reach Postgres.'
  },
  {
    id: 'tenancy',
    category: 'Data protection',
    question: 'Are customer tenants isolated at the data layer?',
    detail: 'Row-level isolation with per-tenant keys, provable in a security review.',
    weight: 12,
    remediation: 'ForkLaunch tenant filters + Postgres RLS scope every query; encryption keys derive per tenant.'
  },
  {
    id: 'compliance',
    category: 'Compliance',
    question: 'Can you map your controls to SOC 2 / HIPAA / GDPR today?',
    detail: 'A controls matrix reviewers can walk through, even pre-certification.',
    weight: 12,
    remediation: 'ForkLaunch compliance tooling (classification, retention, erasure/export endpoints) gives you the technical controls to map.'
  },
  {
    id: 'retention',
    category: 'Compliance',
    question: 'Do you enforce data retention and deletion automatically?',
    detail: 'GDPR erasure and retention schedules enforced by software, not calendars.',
    weight: 9,
    remediation: 'defineComplianceEntity retention policies anonymize/delete on schedule; eraseUserData/exportUserData routes come scaffolded.'
  },
  {
    id: 'sla',
    category: 'Operations',
    question: 'Can you commit to an SLA with incident response?',
    detail: 'Uptime targets, on-call, a status page, and a post-incident process.',
    weight: 8,
    remediation: 'Deploy on the ForkLaunch platform with OpenTelemetry metrics/traces wired; releases and rollbacks are one command.'
  },
  {
    id: 'residency',
    category: 'Operations',
    question: 'Can customers pin data to a region?',
    detail: 'EU customers will ask. US healthcare will ask. Plan the answer now.',
    weight: 7,
    remediation: 'ForkLaunch environments are per-region; deploy the same release to multiple regions with per-region config.'
  }
];

type ReadinessAnswer = 'yes' | 'partial' | 'no';
const ANSWER_POINTS: Record<ReadinessAnswer, number> = { yes: 1, partial: 0.45, no: 0 };
const ANSWER_LABELS: Record<ReadinessAnswer, string> = {
  yes: 'Yes, at launch',
  partial: 'Partially / planned',
  no: 'Not yet'
};

function EnterpriseReadiness() {
  const [answers, setAnswers] = useState<Record<string, ReadinessAnswer>>({});
  const [started, setStarted] = useState(false);
  const idx = READINESS_QUESTIONS.findIndex((q) => !(q.id in answers));
  const complete = idx === -1;

  if (!started) {
    return (
      <div className="card">
        <h2>
          4 · Prove it to enterprise buyers
          <span className="badge gold">readiness scoring</span>
        </h2>
        <p>
          Nine questions security reviewers will ask in your first enterprise
          deal. Answer honestly — every gap comes back with the ForkLaunch
          feature that closes it.
        </p>
        <button className="primary" onClick={() => setStarted(true)}>
          Score enterprise readiness
        </button>
      </div>
    );
  }

  if (!complete) {
    const q = READINESS_QUESTIONS[idx];
    return (
      <div className="card">
        <h2>
          Enterprise readiness
          <span className="badge">{idx + 1} / {READINESS_QUESTIONS.length}</span>
          <span className="badge gold">{q.category}</span>
        </h2>
        <div className="score-bar" style={{ margin: '0.6rem 0 1.1rem' }}>
          <div
            className="score-bar-fill high"
            style={{ width: `${(idx / READINESS_QUESTIONS.length) * 100}%` }}
          />
        </div>
        <h3 style={{ fontSize: '1.15rem', margin: '0 0 0.4rem' }}>{q.question}</h3>
        <p className="meta" style={{ marginTop: 0 }}>{q.detail}</p>
        <div className="btn-row">
          {(Object.keys(ANSWER_LABELS) as ReadinessAnswer[]).map((a) => (
            <button
              key={a}
              className={a === 'yes' ? 'primary' : 'secondary'}
              onClick={() => setAnswers((prev) => ({ ...prev, [q.id]: a }))}
            >
              {ANSWER_LABELS[a]}
            </button>
          ))}
        </div>
        {idx > 0 && (
          <p className="meta" style={{ marginTop: '1rem' }}>
            <a
              href="#back"
              onClick={(e) => {
                e.preventDefault();
                const prevQ = READINESS_QUESTIONS[idx - 1];
                setAnswers((prev) => {
                  const next = { ...prev };
                  delete next[prevQ.id];
                  return next;
                });
              }}
            >
              ← back
            </a>
          </p>
        )}
      </div>
    );
  }

  const totalWeight = READINESS_QUESTIONS.reduce((s, q) => s + q.weight, 0);
  const score = Math.round(
    (READINESS_QUESTIONS.reduce(
      (s, q) => s + q.weight * ANSWER_POINTS[answers[q.id]],
      0
    ) /
      totalWeight) *
      100
  );
  const grade =
    score >= 85
      ? 'Enterprise-ready'
      : score >= 65
        ? 'Nearly there'
        : score >= 45
          ? 'Mid-market ready'
          : 'Not yet';
  const categories = [...new Set(READINESS_QUESTIONS.map((q) => q.category))].map(
    (cat) => {
      const qs = READINESS_QUESTIONS.filter((q) => q.category === cat);
      const w = qs.reduce((s, q) => s + q.weight, 0);
      const pts = qs.reduce((s, q) => s + q.weight * ANSWER_POINTS[answers[q.id]], 0);
      return { cat, pct: Math.round((pts / w) * 100) };
    }
  );
  const gaps = READINESS_QUESTIONS.filter((q) => answers[q.id] !== 'yes');

  return (
    <div className="card">
      <h2>
        Enterprise readiness
        <span className={`badge ${score >= 65 ? 'ok' : 'warn'}`}>{grade}</span>
      </h2>
      <div className="verdict-row" style={{ marginBottom: '1rem' }}>
        <div
          className={`viability-ring ${scoreClass(score)}`}
          style={{ ['--pct' as string]: score }}
        >
          <span className="viability-score">{score}</span>
          <span className="viability-denominator">/100</span>
        </div>
        <div style={{ flex: 1, minWidth: 240 }}>
          {categories.map((c) => (
            <div key={c.cat} style={{ marginBottom: '0.55rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="meta">{c.cat}</span>
                <span className="meta" style={{ fontFamily: 'var(--mono)' }}>{c.pct}%</span>
              </div>
              <div className="score-bar">
                <div className={`score-bar-fill ${scoreClass(c.pct)}`} style={{ width: `${c.pct}%` }} />
              </div>
            </div>
          ))}
        </div>
      </div>
      {gaps.length > 0 ? (
        <>
          <h3>Close the gaps</h3>
          {gaps.map((q) => (
            <div className="bear-item" key={q.id}>
              <div className="bear-claim">
                <span className={`severity ${answers[q.id] === 'no' ? 'sev-4' : 'sev-2'}`}>
                  {answers[q.id] === 'no' ? 'GAP' : 'PARTIAL'}
                </span>
                <strong>{q.question}</strong>
              </div>
              <p className="bear-counter">{q.remediation}</p>
            </div>
          ))}
        </>
      ) : (
        <p className="notice">Clean sweep — bring on the security review.</p>
      )}
      <button className="secondary" onClick={() => setAnswers({})}>
        Re-run assessment
      </button>
    </div>
  );
}

/* ── Main app ─────────────────────────────────────────── */

const SOURCE_LABELS: Record<string, string> = {
  reddit: 'Reddit',
  hackernews: 'Hacker News',
  github: 'GitHub',
  stackoverflow: 'Stack Overflow',
  devto: 'Dev.to',
  npm: 'npm registry',
  news: 'News',
  linkedin: 'LinkedIn (via web search)'
};

const SYSTEM_DIAGRAM = `graph TD
  B["your browser<br/>SHA-256 fingerprint computed locally"] -->|TLS| A["analysis service<br/>ForkLaunch · Node"]
  A --> Q["AI query generation"]
  Q -->|4 queries x 8 sources| HN["Hacker News<br/>stories + comments"]
  Q --> GH["GitHub<br/>repo search"]
  Q --> SO["Stack Overflow<br/>StackExchange API"]
  Q --> NW["Google News<br/>RSS"]
  Q --> NP["npm registry<br/>competition"]
  Q --> DV["Dev.to<br/>practitioner posts"]
  Q --> RD["Reddit<br/>RSS · OAuth if keyed"]
  Q --> LI["LinkedIn<br/>via web search"]
  HN --> SC["dedupe + rank by engagement<br/>evidence-weighted scoring · 5 GTM lenses"]
  GH --> SC
  SO --> SC
  NW --> SC
  NP --> SC
  DV --> SC
  RD --> SC
  LI --> SC
  A --> F["Azure AI Foundry<br/>scoring · adversarial pass · blueprints"]
  SC --> F
  F --> PG[("Postgres<br/>pitch + identity encrypted<br/>AES-256-GCM")]
  subgraph ISO["tenant isolation — enforced in software"]
    PG --> TA["tenant A rows<br/>HKDF key A"]
    PG --> TB["tenant B rows<br/>HKDF key B"]
  end`;

function HowItWorks() {
  return (
    <>
      <div className="card">
        <h2>How the gauntlet works</h2>
        <p className="meta" style={{ marginTop: 0 }}>
          Every arrow below runs on each analysis — nothing is mocked.
        </p>
        <Mermaid chart={SYSTEM_DIAGRAM} />
        <ol className="steps">
          <li>
            <strong>Fingerprint first.</strong> Your browser computes a SHA-256
            hash of the idea before upload — a timestamped proof of what you
            submitted, computed locally.
          </li>
          <li>
            <strong>Evidence gathering.</strong> The AI writes research
            queries, then the service pulls live signals: community pain from
            Reddit, builder attention from Hacker News, existing competition
            from GitHub.
          </li>
          <li>
            <strong>Scoring and the bear case.</strong> Azure AI Foundry
            scores five GTM lenses against that evidence, then runs a second,
            adversarial pass instructed to kill the idea.
          </li>
          <li>
            <strong>Sealed storage.</strong> Your pitch, name, and email are
            encrypted (AES-256-GCM) before they reach Postgres. Workflow
            metadata stays queryable; content does not.
          </li>
        </ol>
      </div>
      <div className="card">
        <h2>
          Tenant isolation
          <span className="badge ok">enforced</span>
        </h2>
        <p>
          Every row carries an organization id. A tenant filter scopes every
          query, Postgres row-level security backs it at the database, and
          encryption keys are HKDF-derived per tenant — even raw database
          access can't decrypt another tenant's data. It's the same
          compliance machinery ForkLaunch runs for healthcare deployments,
          pointed at your startup idea.
        </p>
        <div className="sec-strip">
          <span className="sec-chip">row-level security</span>
          <span className="sec-chip">per-tenant HKDF keys</span>
          <span className="sec-chip">tenant filter on every query</span>
        </div>
      </div>
    </>
  );
}

export default function App() {
  const [title, setTitle] = useState('');
  const [pitch, setPitch] = useState('');
  const [founderName, setFounderName] = useState('');
  const [founderEmail, setFounderEmail] = useState('');
  const [founderCompany, setFounderCompany] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  const [history, setHistory] = useState<Report[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changes, setChanges] = useState<string[] | null>(null);
  const [view, setView] = useState<'report' | 'build' | 'how'>('report');
  const [landingHow, setLandingHow] = useState(false);
  const [editingPitch, setEditingPitch] = useState(false);
  const [fingerprint, setFingerprint] = useState<string | null>(null);

  const prev = history.length > 1 ? history[1] : null;

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(null);
    }
  };

  const pushReport = (r: Report) => {
    setReport(r);
    setHistory((h) => [r, ...h]);
    setTitle(r.title);
    setPitch(r.pitch);
    void sha256Hex(`${r.title}\n${r.pitch}`).then(setFingerprint);
  };

  if (busy && !report) {
    return (
      <Shell>
        <TerminalProgress
          label={`Pressure-testing “${title}”`}
          lines={ANALYSIS_LINES}
          fingerprint={fingerprint ?? undefined}
        />
      </Shell>
    );
  }

  if (!report) {
    return (
      <Shell
        tabs={
          <>
            <button className={!landingHow ? 'active' : ''} onClick={() => setLandingHow(false)}>
              Your idea
            </button>
            <button className={landingHow ? 'active' : ''} onClick={() => setLandingHow(true)}>
              How it works
              <span className="tab-dot" aria-hidden="true" />
            </button>
          </>
        }
      >
        {landingHow ? (
          <HowItWorks />
        ) : (
        <>
        <section className="hero">
          <p className="eyebrow">forklaunch / gtm-validator</p>
          <h2>
            Pressure-test your startup idea <em>before</em> you build it.
          </h2>
          <p className="lede">
            Five go-to-market lenses, live demand signals from Reddit, Hacker
            News, and GitHub, and an adversarial pass that tries to kill the
            idea. Survive it, and we hand you the architecture and the exact
            commands to build it on ForkLaunch.
          </p>
          <div className="sec-strip">
            <span className="sec-chip">SHA-256 fingerprinted in your browser</span>
            <span className="sec-chip">stored in your database, not ours</span>
            <span className="sec-chip">never used to train models</span>
          </div>
        </section>
        <div className="card">
          <h2>Your idea</h2>
          <label>Name it</label>
          <input
            className="submit-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="AI prior-auth copilot for small clinics"
          />
          <label>Pitch it</label>
          <textarea
            className="submit-body"
            value={pitch}
            onChange={(e) => setPitch(e.target.value)}
            placeholder="What's the problem, who has it, what do you build, who pays? Two or three honest paragraphs beat a polished deck."
          />
          <div className="founder-row">
            <div>
              <label>You</label>
              <input
                value={founderName}
                onChange={(e) => setFounderName(e.target.value)}
                placeholder="Jane Chen"
              />
            </div>
            <div>
              <label>Email · report link + follow-ups</label>
              <input
                value={founderEmail}
                onChange={(e) => setFounderEmail(e.target.value)}
                placeholder="jane@company.com"
              />
            </div>
            <div>
              <label>Company · optional</label>
              <input
                value={founderCompany}
                onChange={(e) => setFounderCompany(e.target.value)}
                placeholder="stealth"
              />
            </div>
          </div>
          {error && <div className="error">{error}</div>}
          <button
            className="primary"
            disabled={!title || !pitch || !founderName || !founderEmail || !!busy}
            onClick={() =>
              void run('analyze', async () => {
                setFingerprint(await sha256Hex(`${title}\n${pitch}`));
                pushReport(
                  await analyzeIdea({
                    title,
                    pitch,
                    founder: {
                      name: founderName,
                      email: founderEmail,
                      company: founderCompany || undefined
                    }
                  })
                );
              })
            }
          >
            Run the gauntlet
          </button>
          <p className="meta" style={{ marginTop: '0.8rem' }}>
            Your name, email, and pitch are encrypted (AES-256-GCM) before
            they're stored.
          </p>
        </div>
        </>
        )}
      </Shell>
    );
  }

  const verdictClass = scoreClass(report.viabilityScore);

  return (
    <Shell
      tabs={
        <>
          <button className={view === 'report' ? 'active' : ''} onClick={() => setView('report')}>
            Viability report
          </button>
          <button className={view === 'build' ? 'active' : ''} onClick={() => setView('build')}>
            Build it on ForkLaunch
            <span className="tab-dot" aria-hidden="true" />
          </button>
          <button className={view === 'how' ? 'active' : ''} onClick={() => setView('how')}>
            How it works
          </button>
        </>
      }
    >
      {busy && (
        <TerminalProgress
          label={busy === 'blueprint' ? 'Designing your ForkLaunch architecture' : `Re-analyzing “${title}”`}
          lines={busy === 'blueprint' ? BLUEPRINT_LINES : ANALYSIS_LINES}
          fingerprint={fingerprint ?? undefined}
        />
      )}

      {!busy && view === 'how' && <HowItWorks />}

      {!busy && view === 'report' && (
        <>
          <div className="card verdict-card">
            <div className="verdict-row">
              <div
                className={`viability-ring ${verdictClass}`}
                style={{ ['--pct' as string]: report.viabilityScore }}
              >
                <span className="viability-score">{report.viabilityScore}</span>
                <span className="viability-denominator">/100</span>
              </div>
              <div style={{ flex: 1, minWidth: 260 }}>
                <h2 style={{ marginBottom: '0.3rem' }}>
                  {report.title}
                  <span className="badge gold">v{report.version}</span>
                  {report.generatedBy !== 'foundry' && (
                    <span className="badge warn">offline sample</span>
                  )}
                </h2>
                <p className="verdict-label">
                  {VERDICT_COPY[report.verdict] ?? report.verdict}
                  {prev && prev.viabilityScore !== report.viabilityScore && (
                    <span className={`delta ${report.viabilityScore > prev.viabilityScore ? 'up' : 'down'}`}>
                      {report.viabilityScore > prev.viabilityScore ? '▲' : '▼'}{' '}
                      {Math.abs(report.viabilityScore - prev.viabilityScore)}
                    </span>
                  )}
                </p>
                <p style={{ margin: 0 }}>{report.summary}</p>
                {fingerprint && (
                  <p className="fingerprint">
                    idea fingerprint <code>{fingerprint.slice(0, 20)}…{fingerprint.slice(-6)}</code> · SHA-256, computed in your browser
                  </p>
                )}
              </div>
            </div>
          </div>

          {changes && changes.length > 0 && (
            <div className="notice" style={{ marginBottom: '1.2rem' }}>
              <strong>The AI revised your pitch.</strong> What changed:
              <ul className="feedback" style={{ marginBottom: 0 }}>
                {changes.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="eval-grid">
            {report.dimensions.map((dim) => {
              const prevScore = prev?.dimensions.find((d) => d.key === dim.key)?.score;
              const delta = prevScore !== undefined ? dim.score - prevScore : null;
              return (
                <div key={dim.key} className="eval-card">
                  <h3>{dim.name}</h3>
                  <div className="score-row">
                    <span className={`score ${scoreClass(dim.score)}`}>{dim.score}</span>
                    <span className="meta">/ 100</span>
                    {delta !== null && delta !== 0 && (
                      <span className={`delta ${delta > 0 ? 'up' : 'down'}`}>
                        {delta > 0 ? `▲ +${delta}` : `▼ ${delta}`}
                      </span>
                    )}
                  </div>
                  <div className="score-bar">
                    <div className={`score-bar-fill ${scoreClass(dim.score)}`} style={{ width: `${dim.score}%` }} />
                  </div>
                  <p className="meta">{dim.summary}</p>
                  {dim.actionableFeedback.length > 0 && (
                    <ul className="feedback">
                      {dim.actionableFeedback.map((f, i) => (
                        <li key={i}>{f}</li>
                      ))}
                    </ul>
                  )}
                  <button
                    className="secondary"
                    disabled={!!busy}
                    onClick={() =>
                      void run('refine', async () => {
                        const out = await refineIdea(report.ideaId, dim.key as GtmFocus, [
                          dim.summary,
                          ...dim.actionableFeedback
                        ]);
                        setChanges(out.changes);
                        pushReport(out.report);
                      })
                    }
                  >
                    Improve this
                  </button>
                </div>
              );
            })}
          </div>

          <div className="card bear-card">
            <h2>
              The bear case
              <span className="badge warn">adversarial</span>
            </h2>
            <p className="meta" style={{ marginTop: 0 }}>
              A skeptical partner tried to kill this idea. Here's their best shot — and your counterplay.
            </p>
            {report.bearCase.map((b, i) => (
              <div className="bear-item" key={i}>
                <div className="bear-claim">
                  <span className={`severity sev-${b.severity}`}>SEV-{b.severity}</span>
                  <strong>{b.claim}</strong>
                </div>
                {b.counterplay && <p className="bear-counter">↳ counterplay: {b.counterplay}</p>}
              </div>
            ))}
          </div>

          <div className="card">
            <h2>What the internet says</h2>
            <p className="meta" style={{ marginTop: 0 }}>
              Live signals gathered during this analysis — the evidence behind the scores.
            </p>
            <div className="signals-grid">
              {report.signals.map((s) => (
                <div key={s.source} className="signal-col">
                  <h3>
                    {SOURCE_LABELS[s.source] ?? s.source}
                    <span className={`badge ${s.status === 'ok' ? 'ok' : ''}`}>{s.status}</span>
                  </h3>
                  <p className="meta">
                    {(s.queries ?? [s.query]).filter(Boolean).length > 1
                      ? `${(s.queries ?? []).length} queries trawled: ${(s.queries ?? [])
                          .map((q) => `“${q}”`)
                          .join(', ')}`
                      : `query: “${s.query}”`}
                  </p>
                  {s.status !== 'ok' && s.note && <p className="meta">{s.note}</p>}
                  {s.items.slice(0, 5).map((item, i) => (
                    <a key={i} className="signal-item" href={item.url} target="_blank" rel="noreferrer">
                      <span className="signal-score">{item.score}</span>
                      <span>
                        {item.title}
                        {item.context && <span className="meta"> · {item.context}</span>}
                      </span>
                    </a>
                  ))}
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <h2>Edit and re-run</h2>
            {!editingPitch ? (
              <>
                <p className="pitch-preview">{report.pitch}</p>
                <button className="secondary" onClick={() => setEditingPitch(true)}>
                  Edit the pitch yourself
                </button>
              </>
            ) : (
              <>
                <label>Title</label>
                <input className="submit-title" value={title} onChange={(e) => setTitle(e.target.value)} />
                <label>Pitch</label>
                <textarea className="submit-body" value={pitch} onChange={(e) => setPitch(e.target.value)} />
                <div className="btn-row">
                  <button
                    className="primary"
                    disabled={!!busy}
                    onClick={() =>
                      void run('reanalyze', async () => {
                        setChanges(null);
                        pushReport(await reanalyzeIdea(report.ideaId, { title, pitch }));
                        setEditingPitch(false);
                      })
                    }
                  >
                    Re-run analysis
                  </button>
                  <button className="secondary" onClick={() => setEditingPitch(false)}>
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
          {error && <div className="error">{error}</div>}
        </>
      )}

      {!busy && view === 'build' && (
        <>
          {!report.blueprint ? (
            <div className="card">
              <h2>Turn the verdict into a build plan</h2>
              <p>
                Generate the ForkLaunch architecture for “{report.title}”: the
                service decomposition, a system diagram, the exact scaffolding
                commands, a build prompt for your AI coding agent, and the
                release-and-deploy runbook.
              </p>
              {error && <div className="error">{error}</div>}
              <button
                className="primary"
                disabled={!!busy}
                onClick={() =>
                  void run('blueprint', async () => {
                    pushReport(await generateBlueprint(report.ideaId));
                  })
                }
              >
                Design the architecture
              </button>
            </div>
          ) : (
            <>
              <div className="card">
                <h2>
                  {report.blueprint.appName}
                  <span className="badge gold">ForkLaunch blueprint</span>
                </h2>
                <p>{report.blueprint.rationale}</p>
                <Mermaid chart={report.blueprint.diagram} />
                <table>
                  <thead>
                    <tr><th>Module</th><th>Type</th><th>Purpose</th></tr>
                  </thead>
                  <tbody>
                    {report.blueprint.services.map((s) => (
                      <tr key={s.name}><td><code>{s.name}</code></td><td>service</td><td>{s.description}</td></tr>
                    ))}
                    {report.blueprint.workers.map((w) => (
                      <tr key={w.name}><td><code>{w.name}</code></td><td>worker ({w.type})</td><td>{w.description}</td></tr>
                    ))}
                    {report.blueprint.libraries.map((l) => (
                      <tr key={l.name}><td><code>{l.name}</code></td><td>library</td><td>{l.description}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="card">
                <h2>1 · Scaffold it</h2>
                <p className="meta" style={{ marginTop: 0 }}>ForkLaunch CLI v1.4 — every flag supplied, no interactive prompts.</p>
                <CopyBlock text={report.blueprint.scaffoldCommands.join('\n')} label="copy all" />
              </div>
              <div className="card">
                <h2>2 · Build it</h2>
                <p className="meta" style={{ marginTop: 0 }}>Paste into your AI coding agent from the scaffolded repo root.</p>
                <CopyBlock text={report.blueprint.buildPrompt} label="copy prompt" />
              </div>
              <div className="card">
                <h2>3 · Ship it</h2>
                <ol className="steps">
                  {report.blueprint.shipSteps.map((s) => (
                    <li key={s.title}>
                      <strong>{s.title}.</strong> {s.detail}
                      {s.command && <CopyBlock text={s.command} />}
                    </li>
                  ))}
                </ol>
              </div>
              <EnterpriseReadiness />
            </>
          )}
        </>
      )}
    </Shell>
  );
}

function Shell({
  children,
  tabs
}: {
  children: React.ReactNode;
  tabs?: React.ReactNode;
}) {
  return (
    <div className="portal-root">
      <header className="masthead">
        <div className="shell">
          <p className="eyebrow">forklaunch</p>
          <h1>gtm-validator</h1>
          <p>idea in · evidence out · then the exact plan to build it</p>
        </div>
      </header>
      {tabs && (
        <nav className="tabs">
          <div className="shell tabs-row">{tabs}</div>
        </nav>
      )}
      <main>{children}</main>
    </div>
  );
}
