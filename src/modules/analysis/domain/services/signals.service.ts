import { OpenTelemetryCollector } from '@forklaunch/core/http';
import { Metrics } from '@gtm-validator/monitoring';

export interface SignalItem {
  title: string;
  url: string;
  /** Upvotes / points / stars, depending on source */
  score: number;
  /** Comment count where the source has one */
  comments?: number;
  /** Subreddit, HN, repo owner, etc. */
  context?: string;
  snippet?: string;
}

export interface SourceSignals {
  source: 'reddit' | 'hackernews' | 'github' | 'linkedin';
  status: 'ok' | 'empty' | 'unavailable';
  query: string;
  items: SignalItem[];
  note?: string;
}

const UA = 'gtm-validator/0.1 (startup idea research; contact: ops@forklaunch.com)';

async function fetchJson(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Pulls real-world demand/competition signals for an idea from public APIs:
 * Reddit search (community pain and chatter), Hacker News via Algolia
 * (builder/early-adopter attention), and GitHub repository search (existing
 * open-source competition). LinkedIn requires a partner API and is surfaced
 * as unavailable unless LINKEDIN_API_TOKEN is configured.
 *
 * Every source degrades independently — a blocked or empty source is
 * reported with its status rather than failing the analysis.
 */
const STOPWORDS = new Set([
  'the', 'for', 'and', 'with', 'that', 'from', 'into', 'your', 'their',
  'startup', 'app', 'platform', 'tool', 'using', 'based'
]);

/** Reduce a query to its 2-3 most significant words for a broadened retry. */
function broaden(query: string): string {
  return query
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w))
    .slice(0, 3)
    .join(' ');
}

export class SignalsService {
  private redditToken: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly openTelemetryCollector: OpenTelemetryCollector<Metrics>,
    private readonly linkedinApiToken: string,
    private readonly redditClientId: string = '',
    private readonly redditClientSecret: string = ''
  ) {}

  gather = async (queries: string[]): Promise<SourceSignals[]> => {
    const primary = queries[0] ?? '';
    const results = await Promise.all([
      this.withBroadenRetry(primary, this.reddit),
      this.withBroadenRetry(primary, this.hackerNews),
      this.withBroadenRetry(queries[1] ?? primary, this.github),
      this.linkedin(primary)
    ]);
    return results;
  };

  /** Retry a source once with a broadened query when the first pass is empty. */
  private withBroadenRetry = async (
    query: string,
    fetcher: (q: string) => Promise<SourceSignals>
  ): Promise<SourceSignals> => {
    const first = await fetcher(query);
    if (first.status !== 'empty') return first;
    const wider = broaden(query);
    if (!wider || wider === query.toLowerCase()) return first;
    const second = await fetcher(wider);
    return second.status === 'ok' ? second : first;
  };

  /** App-only OAuth token via client_credentials (free Reddit script app). */
  private redditAuth = async (): Promise<string | null> => {
    if (!this.redditClientId || !this.redditClientSecret) return null;
    if (this.redditToken && this.redditToken.expiresAt > Date.now() + 60_000) {
      return this.redditToken.value;
    }
    const res = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${this.redditClientId}:${this.redditClientSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': UA
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) throw new Error(`reddit auth HTTP ${res.status}`);
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error('reddit auth: no token');
    this.redditToken = {
      value: json.access_token,
      expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000
    };
    return this.redditToken.value;
  };

  private reddit = async (query: string): Promise<SourceSignals> => {
    try {
      const token = await this.redditAuth();
      const base = token
        ? `https://oauth.reddit.com/search.json`
        : `https://www.reddit.com/search.json`;
      const json = await fetchJson(
        `${base}?q=${encodeURIComponent(query)}&sort=relevance&t=year&limit=8`,
        token ? { authorization: `Bearer ${token}` } : {}
      );
      const items: SignalItem[] = (json?.data?.children ?? [])
        .map((c: { data: Record<string, unknown> }) => c.data)
        .filter(Boolean)
        .map((d: Record<string, unknown>) => ({
          title: String(d.title ?? ''),
          url: `https://www.reddit.com${String(d.permalink ?? '')}`,
          score: Number(d.score ?? 0),
          comments: Number(d.num_comments ?? 0),
          context: `r/${String(d.subreddit ?? '')}`,
          snippet: String(d.selftext ?? '').slice(0, 220) || undefined
        }));
      return {
        source: 'reddit',
        status: items.length ? 'ok' : 'empty',
        query,
        items
      };
    } catch (error) {
      this.openTelemetryCollector.info(
        `[signals] reddit unavailable: ${(error as Error).message}`
      );
      return {
        source: 'reddit',
        status: 'unavailable',
        query,
        items: [],
        note: this.redditClientId
          ? 'Reddit search could not be reached'
          : 'Reddit blocks unauthenticated search — set REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET (free script app) to enable'
      };
    }
  };

  private hackerNews = async (query: string): Promise<SourceSignals> => {
    try {
      const json = await fetchJson(
        `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=8`
      );
      const items: SignalItem[] = (json?.hits ?? []).map(
        (h: Record<string, unknown>) => ({
          title: String(h.title ?? ''),
          url:
            String(h.url ?? '') ||
            `https://news.ycombinator.com/item?id=${String(h.objectID ?? '')}`,
          score: Number(h.points ?? 0),
          comments: Number(h.num_comments ?? 0),
          context: 'Hacker News'
        })
      );
      return {
        source: 'hackernews',
        status: items.length ? 'ok' : 'empty',
        query,
        items
      };
    } catch (error) {
      this.openTelemetryCollector.info(
        `[signals] hackernews unavailable: ${(error as Error).message}`
      );
      return {
        source: 'hackernews',
        status: 'unavailable',
        query,
        items: [],
        note: 'Hacker News search could not be reached'
      };
    }
  };

  private github = async (query: string): Promise<SourceSignals> => {
    try {
      const json = await fetchJson(
        `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=6`
      );
      const items: SignalItem[] = (json?.items ?? []).map(
        (r: Record<string, unknown>) => ({
          title: String(r.full_name ?? ''),
          url: String(r.html_url ?? ''),
          score: Number(r.stargazers_count ?? 0),
          context: 'GitHub',
          snippet: String(r.description ?? '').slice(0, 220) || undefined
        })
      );
      return {
        source: 'github',
        status: items.length ? 'ok' : 'empty',
        query,
        items
      };
    } catch (error) {
      this.openTelemetryCollector.info(
        `[signals] github unavailable: ${(error as Error).message}`
      );
      return {
        source: 'github',
        status: 'unavailable',
        query,
        items: [],
        note: 'GitHub search could not be reached'
      };
    }
  };

  private linkedin = async (query: string): Promise<SourceSignals> => {
    if (!this.linkedinApiToken) {
      return {
        source: 'linkedin',
        status: 'unavailable',
        query,
        items: [],
        note: 'LinkedIn requires a partner API token (LINKEDIN_API_TOKEN); skipped'
      };
    }
    // Placeholder for a LinkedIn partner API integration — kept behind the
    // token gate so the rest of the pipeline is honest about what ran.
    return {
      source: 'linkedin',
      status: 'unavailable',
      query,
      items: [],
      note: 'LinkedIn integration not yet implemented'
    };
  };
}
