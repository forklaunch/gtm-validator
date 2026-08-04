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

const VERDICT_COPY: Record<string, string> = {
  strong: 'Strong — go build it',
  promising: 'Promising — sharpen and go',
  uphill: 'Uphill — real obstacles to clear',
  weak: 'Weak — rethink the wedge'
};

const ANALYSIS_STAGES = [
  'Generating research queries…',
  'Pulling community signals from Reddit, Hacker News, and GitHub…',
  'Scoring market pull, differentiation, timing, distribution, monetization…',
  'Running the adversarial pass — trying to kill your idea…',
  'Writing the viability verdict…'
];

function StagedProgress({ label }: { label: string }) {
  const [stage, setStage] = useState(0);
  useEffect(() => {
    const id = setInterval(
      () => setStage((s) => Math.min(s + 1, ANALYSIS_STAGES.length - 1)),
      9000
    );
    return () => clearInterval(id);
  }, []);
  return (
    <div className="card progress-card">
      <h2>{label}</h2>
      <div className="progress-track">
        <div className="progress-glow" />
      </div>
      <p className="meta">{ANALYSIS_STAGES[stage]}</p>
    </div>
  );
}

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
        {copied ? '✓ Copied' : (label ?? 'Copy')}
      </button>
      <pre>{text}</pre>
    </div>
  );
}

const SOURCE_LABELS: Record<string, string> = {
  reddit: 'Reddit',
  hackernews: 'Hacker News',
  github: 'GitHub',
  linkedin: 'LinkedIn'
};

export default function App() {
  const [title, setTitle] = useState('');
  const [pitch, setPitch] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  const [history, setHistory] = useState<Report[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changes, setChanges] = useState<string[] | null>(null);
  const [view, setView] = useState<'report' | 'build'>('report');
  const [editingPitch, setEditingPitch] = useState(false);

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
  };

  if (busy && !report) {
    return (
      <Shell>
        <StagedProgress label={`Pressure-testing “${title}”`} />
      </Shell>
    );
  }

  if (!report) {
    return (
      <Shell>
        <section className="hero">
          <p className="eyebrow">ForkLaunch · GTM Validator</p>
          <h2>
            Pressure-test your startup idea <em>before</em> you build it.
          </h2>
          <p className="lede">
            Five go-to-market lenses, live demand signals from Reddit, Hacker
            News, and GitHub, and an adversarial pass that tries to kill the
            idea. Survive it, and we hand you the architecture and the exact
            commands to build it on ForkLaunch.
          </p>
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
          {error && <div className="error">{error}</div>}
          <button
            className="primary"
            disabled={!title || !pitch || !!busy}
            onClick={() =>
              void run('analyze', async () => {
                pushReport(await analyzeIdea({ title, pitch }));
              })
            }
          >
            Run the gauntlet
          </button>
          <p className="meta" style={{ marginTop: '0.8rem' }}>
            Analysis takes about a minute — real research, not vibes.
          </p>
        </div>
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
        </>
      }
    >
      {busy && <StagedProgress label={busy === 'blueprint' ? 'Designing your ForkLaunch architecture…' : `Re-analyzing “${title}”`} />}

      {!busy && view === 'report' && (
        <>
          <div className="card verdict-card">
            <div className="verdict-row">
              <div className={`viability-ring ${verdictClass}`}>
                <span className="viability-score">{report.viabilityScore}</span>
                <span className="viability-denominator">/100</span>
              </div>
              <div>
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
                      {report.viabilityScore - prev.viabilityScore}
                    </span>
                  )}
                </p>
                <p style={{ margin: 0 }}>{report.summary}</p>
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
                        const out = await refineIdea(report.ideaId, dim.key, [
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
                  <span className={`severity sev-${b.severity}`}>{'⚠'.repeat(Math.max(1, Math.min(5, b.severity)))}</span>
                  <strong>{b.claim}</strong>
                </div>
                {b.counterplay && <p className="bear-counter">Counterplay: {b.counterplay}</p>}
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
                  <p className="meta">query: “{s.query}”</p>
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
                <CopyBlock text={report.blueprint.scaffoldCommands.join('\n')} label="Copy all" />
              </div>
              <div className="card">
                <h2>2 · Build it</h2>
                <p className="meta" style={{ marginTop: 0 }}>Paste into your AI coding agent from the scaffolded repo root.</p>
                <CopyBlock text={report.blueprint.buildPrompt} label="Copy prompt" />
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
          <p className="eyebrow">ForkLaunch</p>
          <h1>GTM Validator</h1>
          <p>
            Idea in. Evidence-backed verdict out. Then the exact plan to build
            it.
          </p>
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
