import { createHash } from 'node:crypto';
import { OpenTelemetryCollector } from '@forklaunch/core/http';
import { EntityManager } from '@mikro-orm/core';
import { Metrics } from '@gtm-validator/monitoring';
import {
  FounderEntity,
  GtmReportEntity,
  StartupIdeaEntity,
  type GtmReport,
  type StartupIdea
} from '../../persistence/entities';
import { FoundryService } from './foundry.service';
import { SignalsService, type SourceSignals } from './signals.service';

export const GTM_TENANT_ID = 'gtm-validator';

export const GTM_DIMENSIONS = {
  marketPull: 'Market Pull',
  differentiation: 'Differentiation',
  timing: 'Timing',
  distribution: 'Distribution',
  monetization: 'Monetization'
} as const;
export type GtmDimensionKey = keyof typeof GTM_DIMENSIONS;

export interface GtmDimension {
  key: string;
  name: string;
  score: number;
  summary: string;
  actionableFeedback: string[];
}

export interface BearCaseItem {
  claim: string;
  severity: number; // 1 (annoyance) – 5 (company killer)
  counterplay: string;
}

export interface ReportPayload {
  id: string;
  ideaId: string;
  version: number;
  title: string;
  pitch: string;
  viabilityScore: number;
  verdict: string;
  summary: string;
  generatedBy: string;
  dimensions: GtmDimension[];
  signals: SourceSignals[];
  bearCase: BearCaseItem[];
  blueprint?: Blueprint;
  createdAt: string;
}

export interface Blueprint {
  appName: string;
  database: string;
  rationale: string;
  services: Array<{ name: string; description: string }>;
  workers: Array<{ name: string; type: string; description: string }>;
  libraries: Array<{ name: string; description: string }>;
  diagram: string; // mermaid flowchart
  scaffoldCommands: string[];
  buildPrompt: string;
  shipSteps: Array<{ title: string; detail: string; command?: string }>;
}

export class IdeaNotFoundError extends Error {}

const ANALYSIS_SYSTEM_PROMPT = `You are a seasoned go-to-market analyst and venture partner evaluating startup ideas. You are rigorous, evidence-driven, and allergic to hype. You are given a startup idea and real-world signals trawled from multiple public sources: Reddit and Hacker News stories/comments (community pain and builder attention), Stack Overflow (what engineers actually get stuck on), GitHub and npm (shipped competition), Dev.to (practitioner writing), and news coverage (market and competitor framing). Each source reports its own status — 'ok', 'empty' (searched, nothing found), or 'unavailable' (could not be reached). Treat 'empty' as evidence about the world; treat 'unavailable' as missing evidence, not as a negative signal.

Score the idea 0-100 on exactly five dimensions:
1. marketPull — Is there evidence people actively want this? Weigh the provided signals heavily: pain expressed in communities, search/discussion volume, existing demand workarounds.
2. differentiation — Is there a defensible wedge? Consider the GitHub competition signals and obvious incumbents.
3. timing — Why now? Technology shifts, regulation, behavior changes.
4. distribution — Is there a credible, specific path to the first 100 customers? Channels, communities, buyer access.
5. monetization — Who pays, how much, and how soon? Pricing power, budget line, willingness to pay.

Then produce a bear case: the 3-5 strongest reasons this fails, as if you were the skeptical partner trying to kill the deal. Rate each severity 1-5 (5 = company killer) and give the founder's best counterplay.

Finally give a viability verdict: one of "strong", "promising", "uphill", "weak" and a 2-3 sentence overall summary that references the evidence.

Be a tough grader. Cite specific signals in your reasoning when they exist (e.g. "a 900-upvote r/medicine thread complains about exactly this"). If signals are unavailable or empty, say what that absence implies.

Respond with ONLY a JSON object:
{
  "dimensions": [ { "key": "marketPull", "score": 0, "summary": "…", "actionableFeedback": ["…"] }, … all five … ],
  "bearCase": [ { "claim": "…", "severity": 3, "counterplay": "…" } ],
  "viabilityScore": 0,
  "verdict": "promising",
  "summary": "…"
}`;

const QUERY_SYSTEM_PROMPT = `Given a startup idea, produce the 4 best web search queries for gauging real-world demand and competition. Each should attack a different angle, in this order:
1. the pain/frustration people express about the status quo (community discussion wording, not product wording)
2. existing products, tools, or repositories that already solve it
3. the market/industry framing a journalist or analyst would use
4. the technical problem an engineer would search when building it
Keep each under 6 words and avoid repeating the same nouns across all four. Respond ONLY with JSON: {"queries": ["…", "…", "…", "…"]}`;

const REFINE_SYSTEM_PROMPT = `You are a startup pitch editor. Rewrite the pitch to directly address the analyst feedback, deepest on the focus dimension — keep the founder's core idea and voice, add concrete specifics (ICP, wedge, channel, pricing) as plans rather than fabricated traction. Sharpen the title only if it stays recognizable. Respond ONLY with JSON: {"title": "…", "pitch": "…", "changes": ["…"]}`;

const BLUEPRINT_SYSTEM_PROMPT = `You are a ForkLaunch solutions architect. Given a validated startup idea, design the ForkLaunch application that implements its MVP.

ForkLaunch is a TypeScript modular-monolith platform: an application contains services (HTTP APIs with controllers/routes/entities via MikroORM), workers (bullmq | kafka | database | redis), and libraries. Standard modules available out of the box: iam-better-auth (auth), billing-stripe (payments). Postgres + Redis ship by default; deployment is containerized with releases and per-environment config.

Design 2-4 services, 0-2 workers, and any shared libraries. The app name must be kebab-case; service/worker names must be kebab-case, must NOT contain numbers, and must not be substrings of the app name.

Also produce a mermaid flowchart (graph TD) showing clients, services, workers, and datastores, and a build prompt: a single, detailed prompt a developer would paste into an AI coding agent to implement the MVP on the scaffolded codebase (entities, routes, key business logic, integrations).

Respond ONLY with JSON:
{
  "appName": "…", "database": "postgresql", "rationale": "…",
  "services": [{"name": "…", "description": "…"}],
  "workers": [{"name": "…", "type": "bullmq", "description": "…"}],
  "libraries": [{"name": "…", "description": "…"}],
  "diagram": "graph TD\\n …",
  "buildPrompt": "…"
}`;

function clampScore(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}

export class GtmService {
  constructor(
    private readonly em: EntityManager,
    private readonly foundry: FoundryService,
    private readonly signals: SignalsService,
    private readonly openTelemetryCollector: OpenTelemetryCollector<Metrics>
  ) {}

  /** Full pipeline: queries → signals → themed analysis + adversarial pass. */
  analyze = async (data: {
    title: string;
    pitch: string;
    founder: { name: string; email: string; company?: string };
  }): Promise<ReportPayload> => {
    const emailLookupHash = createHash('sha256')
      .update(data.founder.email.trim().toLowerCase())
      .digest('hex');
    let founder = await this.em.findOne(FounderEntity, { emailLookupHash });
    if (!founder) {
      founder = this.em.create(FounderEntity, {
        name: data.founder.name,
        email: data.founder.email.trim().toLowerCase(),
        emailLookupHash,
        company: data.founder.company ?? null,
        organizationId: GTM_TENANT_ID
      });
    }
    const idea = this.em.create(StartupIdeaEntity, {
      title: data.title,
      pitch: data.pitch,
      founder,
      organizationId: GTM_TENANT_ID
    });
    await this.em.flush();
    return this.runAnalysis(idea, 1);
  };

  /** Marketing funnel export: founders with their ideas and outcomes. */
  funnel = async () => {
    const founders = await this.em.find(
      FounderEntity,
      {},
      { orderBy: { createdAt: 'DESC' } }
    );
    const out = [];
    for (const f of founders) {
      const ideas = await this.em.find(
        StartupIdeaEntity,
        { founder: f.id },
        { orderBy: { createdAt: 'DESC' } }
      );
      const enriched = [];
      for (const idea of ideas) {
        const latest = await this.em.findOne(
          GtmReportEntity,
          { idea: idea.id },
          { orderBy: { version: 'DESC' } }
        );
        enriched.push({
          id: idea.id,
          title: idea.title,
          latestScore: latest?.viabilityScore,
          latestVerdict: latest?.verdict,
          versions: latest?.version ?? 0,
          blueprintGenerated: Boolean(latest?.blueprint),
          createdAt: idea.createdAt.toISOString()
        });
      }
      out.push({
        id: f.id,
        name: f.name,
        email: f.email,
        company: f.company ?? undefined,
        firstSeenAt: f.createdAt.toISOString(),
        ideas: enriched
      });
    }
    return out;
  };

  /** Re-run analysis on a (possibly user-edited) pitch as a new version. */
  reanalyze = async (
    ideaId: string,
    data: { title?: string; pitch?: string }
  ): Promise<ReportPayload> => {
    const idea = await this.em.findOne(StartupIdeaEntity, { id: ideaId });
    if (!idea) throw new IdeaNotFoundError(ideaId);
    if (data.title) idea.title = data.title;
    if (data.pitch) idea.pitch = data.pitch;
    const version = (await this.latestVersion(ideaId)) + 1;
    await this.em.flush();
    return this.runAnalysis(idea, version);
  };

  /** AI rewrites the pitch toward a focus dimension, then re-analyzes. */
  refine = async (
    ideaId: string,
    focus: string,
    feedback: string[]
  ): Promise<{ report: ReportPayload; changes: string[] }> => {
    const idea = await this.em.findOne(StartupIdeaEntity, { id: ideaId });
    if (!idea) throw new IdeaNotFoundError(ideaId);
    const focusName =
      GTM_DIMENSIONS[focus as GtmDimensionKey] ?? GTM_DIMENSIONS.marketPull;

    let changes: string[] = [];
    if (this.foundry.isConfigured()) {
      const revised = await this.foundry.completeJson<{
        title?: string;
        pitch?: string;
        changes?: string[];
      }>(
        REFINE_SYSTEM_PROMPT,
        [
          `Focus dimension: ${focusName}`,
          `Title: ${idea.title}`,
          `Pitch:\n${idea.pitch}`,
          `Analyst feedback to address:`,
          ...feedback.map((f) => `- ${f}`)
        ].join('\n')
      );
      if (revised.pitch?.trim()) {
        idea.title = revised.title?.trim() || idea.title;
        idea.pitch = revised.pitch.trim();
        changes = (revised.changes ?? []).filter(
          (c): c is string => typeof c === 'string'
        );
      }
    } else {
      idea.pitch = `${idea.pitch}\n\n${focusName} plan (offline sample): configure FOUNDRY_* for a real AI revision.`;
      changes = ['Appended offline sample plan section'];
    }
    const version = (await this.latestVersion(ideaId)) + 1;
    await this.em.flush();
    const report = await this.runAnalysis(idea, version);
    return { report, changes };
  };

  /** Generate the ForkLaunch build blueprint for the idea's latest report. */
  blueprint = async (ideaId: string): Promise<ReportPayload> => {
    const idea = await this.em.findOne(StartupIdeaEntity, { id: ideaId });
    if (!idea) throw new IdeaNotFoundError(ideaId);
    const report = await this.em.findOne(
      GtmReportEntity,
      { idea: ideaId },
      { orderBy: { version: 'DESC' } }
    );
    if (!report) throw new IdeaNotFoundError(`No report for idea ${ideaId}`);

    const arch = this.foundry.isConfigured()
      ? await this.foundry.completeJson<Partial<Blueprint>>(
          BLUEPRINT_SYSTEM_PROMPT,
          [
            `Startup: ${idea.title}`,
            `Pitch:\n${idea.pitch}`,
            `Viability: ${report.viabilityScore}/100 (${report.verdict})`,
            `Analysis summary: ${report.summary}`
          ].join('\n'),
          6000
        )
      : this.offlineArch(idea);

    const blueprint = this.renderBlueprint(arch, idea);
    report.blueprint = blueprint as unknown as Record<string, unknown>;
    await this.em.flush();
    return this.toPayload(report, idea);
  };

  get = async (ideaId: string): Promise<ReportPayload[]> => {
    const idea = await this.em.findOne(StartupIdeaEntity, { id: ideaId });
    if (!idea) throw new IdeaNotFoundError(ideaId);
    const reports = await this.em.find(
      GtmReportEntity,
      { idea: ideaId },
      { orderBy: { version: 'DESC' } }
    );
    return reports.map((r) => this.toPayload(r, idea));
  };

  list = async (): Promise<
    Array<{ id: string; title: string; latestScore?: number; latestVerdict?: string; versions: number; createdAt: string }>
  > => {
    const ideas = await this.em.find(
      StartupIdeaEntity,
      {},
      { orderBy: { createdAt: 'DESC' } }
    );
    const out = [];
    for (const idea of ideas) {
      const latest = await this.em.findOne(
        GtmReportEntity,
        { idea: idea.id },
        { orderBy: { version: 'DESC' } }
      );
      out.push({
        id: idea.id,
        title: idea.title,
        latestScore: latest?.viabilityScore,
        latestVerdict: latest?.verdict,
        versions: latest?.version ?? 0,
        createdAt: idea.createdAt.toISOString()
      });
    }
    return out;
  };

  // ── internals ──────────────────────────────────────────

  private latestVersion = async (ideaId: string): Promise<number> => {
    const latest = await this.em.findOne(
      GtmReportEntity,
      { idea: ideaId },
      { orderBy: { version: 'DESC' } }
    );
    return latest?.version ?? 0;
  };

  private runAnalysis = async (
    idea: StartupIdea,
    version: number
  ): Promise<ReportPayload> => {
    const queries = await this.searchQueries(idea);
    const signals = await this.signals.gather(
      queries,
      `${idea.title} ${idea.pitch}`
    );

    let analysis: {
      dimensions: GtmDimension[];
      bearCase: BearCaseItem[];
      viabilityScore: number;
      verdict: string;
      summary: string;
      generatedBy: string;
    };

    if (this.foundry.isConfigured()) {
      const raw = await this.foundry.completeJson<{
        dimensions?: Array<Partial<GtmDimension>>;
        bearCase?: Array<Partial<BearCaseItem>>;
        viabilityScore?: number;
        verdict?: string;
        summary?: string;
      }>(
        ANALYSIS_SYSTEM_PROMPT,
        [
          `Startup: ${idea.title}`,
          `Pitch:\n${idea.pitch}`,
          '',
          'Real-world signals:',
          JSON.stringify(this.compactSignals(signals), null, 1)
        ].join('\n'),
        6000
      );
      const byKey = new Map((raw.dimensions ?? []).map((d) => [d.key, d]));
      analysis = {
        dimensions: (
          Object.entries(GTM_DIMENSIONS) as Array<[GtmDimensionKey, string]>
        ).map(([key, name]) => {
          const d = byKey.get(key);
          return {
            key,
            name,
            score: clampScore(d?.score),
            summary: d?.summary?.trim() || 'No assessment returned.',
            actionableFeedback: (d?.actionableFeedback ?? []).filter(
              (f): f is string => typeof f === 'string' && f.trim() !== ''
            )
          };
        }),
        bearCase: (raw.bearCase ?? [])
          .filter((b) => typeof b?.claim === 'string')
          .map((b) => ({
            claim: String(b.claim),
            severity: Math.max(1, Math.min(5, Math.round(Number(b.severity ?? 3)))),
            counterplay: String(b.counterplay ?? '')
          })),
        viabilityScore: clampScore(raw.viabilityScore),
        verdict: raw.verdict?.trim() || 'uphill',
        summary: raw.summary?.trim() || 'No summary returned.',
        generatedBy: 'foundry'
      };
    } else {
      analysis = this.offlineAnalysis(idea);
    }

    const report = this.em.create(GtmReportEntity, {
      idea,
      version,
      pitchSnapshot: idea.pitch,
      viabilityScore: analysis.viabilityScore,
      verdict: analysis.verdict,
      summary: analysis.summary,
      dimensions: analysis.dimensions as unknown as Record<string, unknown>[],
      signals: signals as unknown as Record<string, unknown>[],
      bearCase: analysis.bearCase as unknown as Record<string, unknown>[],
      blueprint: null,
      organizationId: GTM_TENANT_ID
    });
    await this.em.flush();
    return this.toPayload(report, idea);
  };

  private searchQueries = async (idea: StartupIdea): Promise<string[]> => {
    if (this.foundry.isConfigured()) {
      try {
        const out = await this.foundry.completeJson<{ queries?: string[] }>(
          QUERY_SYSTEM_PROMPT,
          `${idea.title}\n\n${idea.pitch.slice(0, 600)}`,
          1200
        );
        const queries = (out.queries ?? []).filter(
          (q): q is string => typeof q === 'string' && q.trim() !== ''
        );
        if (queries.length) return queries.slice(0, 4);
      } catch (error) {
        this.openTelemetryCollector.info(
          `[gtm] query generation failed, falling back to title: ${(error as Error).message}`
        );
      }
    }
    // No model available: derive varied fallbacks from the idea itself
    // rather than trawling the same string four times.
    const words = idea.title
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3);
    const core = words.slice(0, 3).join(' ') || idea.title;
    return [
      idea.title,
      core,
      `${core} software`,
      `${core} alternatives`
    ];
  };

  /** Trim signals for prompt economy: top items only, no long snippets. */
  private compactSignals = (signals: SourceSignals[]) =>
    signals.map((s) => ({
      source: s.source,
      status: s.status,
      queriesTrawled: s.queries ?? [s.query],
      note: s.note,
      items: s.items.slice(0, 6).map((i) => ({
        title: i.title,
        score: i.score,
        comments: i.comments,
        context: i.context,
        matchedQuery: i.matchedQuery,
        snippet: i.snippet?.slice(0, 160)
      }))
    }));

  private toPayload = (report: GtmReport, idea: StartupIdea): ReportPayload => ({
    id: report.id,
    ideaId: idea.id,
    version: report.version,
    title: idea.title,
    pitch: report.pitchSnapshot,
    viabilityScore: report.viabilityScore,
    verdict: report.verdict,
    summary: report.summary,
    generatedBy: this.foundry.isConfigured() ? 'foundry' : 'offline-sample',
    dimensions: report.dimensions as unknown as GtmDimension[],
    signals: report.signals as unknown as SourceSignals[],
    bearCase: report.bearCase as unknown as BearCaseItem[],
    blueprint: (report.blueprint as unknown as Blueprint) ?? undefined,
    createdAt: report.createdAt.toISOString()
  });

  private offlineAnalysis = (idea: StartupIdea) => {
    const detail = Math.min(30, Math.floor(idea.pitch.length / 60));
    return {
      dimensions: (
        Object.entries(GTM_DIMENSIONS) as Array<[GtmDimensionKey, string]>
      ).map(([key, name], i) => ({
        key,
        name,
        score: clampScore(35 + detail + i * 4),
        summary: `Offline sample for ${name} — configure FOUNDRY_* for a real analysis.`,
        actionableFeedback: [
          `Add specifics a ${name.toLowerCase()} analysis can grade.`,
          'Set FOUNDRY_ENDPOINT / FOUNDRY_API_KEY / FOUNDRY_MODEL.'
        ]
      })),
      bearCase: [
        {
          claim: 'Offline sample bear case — no AI configured.',
          severity: 3,
          counterplay: 'Configure the Foundry endpoint for a real adversarial pass.'
        }
      ],
      viabilityScore: clampScore(40 + detail),
      verdict: 'uphill',
      summary:
        'Offline sample analysis — scores are placeholders based on pitch length only.',
      generatedBy: 'offline-sample'
    };
  };

  private offlineArch = (idea: StartupIdea): Partial<Blueprint> => ({
    appName: idea.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30)
      .replace(/[0-9]/g, '') || 'startup-mvp',
    database: 'postgresql',
    rationale: 'Offline sample architecture — configure FOUNDRY_* for a tailored design.',
    services: [{ name: 'api', description: 'Core product API' }],
    workers: [],
    libraries: [],
    diagram: 'graph TD\n  Client-->API[api service]\n  API-->PG[(Postgres)]',
    buildPrompt: 'Implement the MVP described in the pitch on the scaffolded ForkLaunch app.'
  });

  /**
   * Deterministically render CLI commands from the AI's architecture so the
   * scaffolding/release/deploy steps are always exact, current CLI syntax.
   */
  private renderBlueprint = (
    arch: Partial<Blueprint>,
    idea: StartupIdea
  ): Blueprint => {
    const appName = (arch.appName ?? 'startup-mvp').replace(/[^a-z-]/g, '') || 'startup-mvp';
    const database = arch.database ?? 'postgresql';
    const services = (arch.services ?? []).filter((s) => s?.name);
    const workers = (arch.workers ?? []).filter((w) => w?.name);
    const libraries = (arch.libraries ?? []).filter((l) => l?.name);

    const scaffoldCommands = [
      `forklaunch init application ${appName} --path ./${appName} --modules-path src/modules --database ${database} --runtime node --validator zod --http-framework express --formatter biome --linter oxlint --test-framework vitest --license MIT --author "you" --description "${idea.title.replaceAll('"', "'")}"`,
      ...services.map(
        (s) =>
          `forklaunch init service ${s.name} --path ./${appName} --database ${database} --description "${(s.description ?? '').replaceAll('"', "'")}"`
      ),
      ...workers.map(
        (w) =>
          `forklaunch init worker ${w.name} --path ./${appName} --type ${w.type || 'bullmq'} --description "${(w.description ?? '').replaceAll('"', "'")}"`
      ),
      ...libraries.map(
        (l) =>
          `forklaunch init library ${l.name} --path ./${appName} --description "${(l.description ?? '').replaceAll('"', "'")}"`
      ),
      `cd ${appName}/src/modules && pnpm install && pnpm build`
    ];

    const shipSteps = [
      {
        title: 'Build the MVP',
        detail:
          'Paste the build prompt below into your AI coding agent (or hand it to an engineer) from the scaffolded repo root.'
      },
      {
        title: 'Create the platform application',
        detail:
          'In the ForkLaunch dashboard, create an application, then link your checkout to it.',
        command: 'forklaunch integrate --app <application-id>'
      },
      {
        title: 'Cut a release',
        detail: 'Package local code and upload it to the platform.',
        command: `forklaunch release create --version 0.1.0 --notes "MVP" --local -y`
      },
      {
        title: 'Configure the environment',
        detail:
          'Pull the env template, fill user-supplied values, and push back. Platform-provisioned values (DB, Redis) are injected at deploy.',
        command:
          'forklaunch config pull -r us-east-2 -e production && forklaunch config push -r us-east-2 -e production'
      },
      {
        title: 'Deploy',
        detail:
          'Deploys to the shared cluster on shared-infra plans; watch progress on the dashboard.',
        command:
          'forklaunch deploy create --release 0.1.0 --environment production --region us-east-2 --node-env production'
      }
    ];

    return {
      appName,
      database,
      rationale: arch.rationale ?? '',
      services,
      workers: workers.map((w) => ({ ...w, type: w.type || 'bullmq' })),
      libraries,
      diagram: arch.diagram ?? 'graph TD\n  Client-->API',
      scaffoldCommands,
      buildPrompt: arch.buildPrompt ?? '',
      shipSteps
    };
  };
}
