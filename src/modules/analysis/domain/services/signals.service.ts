import { OpenTelemetryCollector } from '@forklaunch/core/http';
import { Metrics } from '@gtm-validator/monitoring';

export interface SignalItem {
  title: string;
  url: string;
  /** Upvotes / points / stars / reactions, depending on source */
  score: number;
  /** Comment/answer count where the source has one */
  comments?: number;
  /** Subreddit, HN, repo owner, publication, etc. */
  context?: string;
  snippet?: string;
  /** Which of the trawled queries surfaced this item. */
  matchedQuery?: string;
}

export type SignalSource =
  | 'reddit'
  | 'hackernews'
  | 'github'
  | 'stackoverflow'
  | 'devto'
  | 'npm'
  | 'news'
  | 'linkedin';

export interface SourceSignals {
  source: SignalSource;
  status: 'ok' | 'empty' | 'unavailable';
  /** Every query actually trawled for this source. */
  query: string;
  queries?: string[];
  items: SignalItem[];
  note?: string;
}

const UA =
  'gtm-validator/0.2 (startup idea research; contact: ops@forklaunch.com)';

/** Per-source cap so one loud source can't crowd out the others. */
const MAX_ITEMS_PER_SOURCE = 10;
/** Queries trawled per source — the rest of the list is still deduped in. */
const MAX_QUERIES = 4;

async function fetchJson(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(9000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchText(url: string) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA },
    redirect: 'follow',
    signal: AbortSignal.timeout(9000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<[^>]+>/g, '')
    .trim();
}

const STOPWORDS = new Set([
  'the', 'for', 'and', 'with', 'that', 'from', 'into', 'your', 'their',
  'startup', 'app', 'platform', 'tool', 'using', 'based'
]);

/** Meaningful terms in a string: lowercase, de-stopworded, length > 3. */
function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w));
}

/** Shared-stem match, tolerant of plurals but not of short coincidences. */
function overlap(needles: string[], haystack: string[]): number {
  const hay = new Set(haystack);
  return needles.filter(
    (t) =>
      hay.has(t) ||
      haystack.some(
        (h) =>
          (h.length >= 5 || t.length >= 5) &&
          (h.startsWith(t) || t.startsWith(h))
      )
  ).length;
}

/**
 * Whether an item is actually about what was searched for. Keyword search
 * across broad sources returns confident nonsense — npm answers "vets hate
 * charting after hours" with `ag-charts-types`, Google News with a story
 * about anti-Jewish hate — and a misleading signal is worse for the analysis
 * than a thinner evidence set, so this errs toward dropping.
 *
 * An item passes on a strong query match alone, or on a weaker query match
 * corroborated by the idea's own vocabulary.
 */
function isRelevant(
  item: SignalItem,
  query: string,
  ideaTerms: string[]
): boolean {
  const queryTerms = terms(query);
  if (queryTerms.length === 0) return true;
  // Title and context only — body text shares some word with almost any
  // query. This is a cheap prefilter to bound how much goes to the model;
  // GtmService.curateSignals does the actual relevance judgement.
  const haystack = terms(`${item.title} ${item.context ?? ''}`);
  if (haystack.length === 0) return false;
  return (
    overlap(queryTerms, haystack) > 0 ||
    (ideaTerms.length > 0 && overlap(ideaTerms, haystack) >= 2)
  );
}

/** Reduce a query to its 2-3 most significant words for a broadened retry. */
function broaden(query: string): string {
  return query
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w))
    .slice(0, 3)
    .join(' ');
}

/**
 * Pulls real-world demand, competition, and market signals for an idea from
 * public APIs. Every query in the list is trawled against every source (not
 * just the first), results are deduplicated by URL and ranked by engagement.
 *
 * Free and keyless: Hacker News (stories + comments, via Algolia), GitHub
 * repositories, Stack Overflow (via StackExchange), Dev.to, the npm registry,
 * and Google News. Reddit needs a free script app's client credentials;
 * LinkedIn needs partner API access. Every source degrades independently — a
 * blocked, empty, or slow source is reported with its status and never fails
 * the analysis.
 */
export class SignalsService {
  private redditToken: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly openTelemetryCollector: OpenTelemetryCollector<Metrics>,
    private readonly linkedinApiToken: string,
    private readonly redditClientId: string = '',
    private readonly redditClientSecret: string = '',
    private readonly braveApiKey: string = ''
  ) {}

  gather = async (
    queries: string[],
    ideaContext = ''
  ): Promise<SourceSignals[]> => {
    const ideaTerms = [...new Set(terms(ideaContext))];
    const trawl = [...new Set(queries.map((q) => q.trim()).filter(Boolean))]
      .slice(0, MAX_QUERIES);
    if (trawl.length === 0) trawl.push('');

    // `paceMs` serialises a source's queries with a delay between them.
    // Reddit's public RSS 429s immediately on parallel bursts; everything
    // else tolerates a concurrent fan-out.
    const sources: Array<
      [SignalSource, (q: string) => Promise<SignalItem[]>, number?]
    > = [
      ['reddit', this.reddit, 1100],
      ['hackernews', this.hackerNews],
      ['github', this.github],
      ['stackoverflow', this.stackOverflow],
      ['devto', this.devTo],
      ['npm', this.npm],
      ['news', this.news],
      // Web search restricted to linkedin.com — LinkedIn has no public
      // search API, but its public posts and company pages are indexed.
      ['linkedin', this.linkedin, this.braveApiKey ? 0 : 1100]
    ];

    const gathered = await Promise.all(
      sources.map(([source, fetcher, paceMs]) =>
        this.trawlSource(source, fetcher, trawl, ideaTerms, paceMs)
      )
    );
    return gathered;
  };

  /**
   * Runs one source across every query, merges and dedupes the results, and
   * broadens the query set only if the whole sweep came back empty. A source
   * that throws on every query is unavailable; one that simply found nothing
   * is empty — the distinction matters to the analysis.
   */
  private trawlSource = async (
    source: SignalSource,
    fetcher: (q: string) => Promise<SignalItem[]>,
    queries: string[],
    ideaTerms: string[] = [],
    paceMs = 0
  ): Promise<SourceSignals> => {
    const runQuery = async (q: string) =>
      (await fetcher(q)).map((i) => ({ ...i, matchedQuery: q }));

    const run = async (qs: string[]) => {
      let settled: PromiseSettledResult<SignalItem[]>[];
      if (paceMs > 0) {
        // Sequential with a gap — rate-limited sources would 429 the burst.
        settled = [];
        for (const [i, q] of qs.entries()) {
          if (i > 0) await new Promise((r) => setTimeout(r, paceMs));
          settled.push(
            await runQuery(q).then(
              (value) => ({ status: 'fulfilled' as const, value }),
              (reason) => ({ status: 'rejected' as const, reason })
            )
          );
        }
      } else {
        settled = await Promise.allSettled(qs.map(runQuery));
      }
      const items: SignalItem[] = [];
      const seen = new Set<string>();
      let failures = 0;
      let lastError = '';
      for (const result of settled) {
        if (result.status === 'rejected') {
          failures += 1;
          lastError = String(result.reason?.message ?? result.reason);
          continue;
        }
        for (const item of result.value) {
          const key = item.url || item.title;
          if (!key || seen.has(key)) continue;
          if (!isRelevant(item, item.matchedQuery ?? '', ideaTerms)) continue;
          seen.add(key);
          items.push(item);
        }
      }
      items.sort(
        (a, b) => b.score + (b.comments ?? 0) - (a.score + (a.comments ?? 0))
      );
      return { items: items.slice(0, MAX_ITEMS_PER_SOURCE), failures, lastError };
    };

    let { items, failures, lastError } = await run(queries);

    // Nothing found anywhere: retry once on broadened terms before concluding
    // the absence is real.
    if (items.length === 0 && failures < queries.length) {
      const wider = [...new Set(queries.map(broaden).filter(Boolean))].filter(
        (w) => !queries.map((q) => q.toLowerCase()).includes(w)
      );
      if (wider.length) {
        const retry = await run(wider);
        if (retry.items.length) {
          items = retry.items;
          queries = wider;
        }
      }
    }

    if (failures === queries.length && items.length === 0) {
      this.openTelemetryCollector.info(
        `[signals] ${source} unavailable: ${lastError}`
      );
      return {
        source,
        status: 'unavailable',
        query: queries[0] ?? '',
        queries,
        items: [],
        note: this.unavailableNote(source, lastError)
      };
    }

    return {
      source,
      status: items.length ? 'ok' : 'empty',
      query: queries[0] ?? '',
      queries,
      items
    };
  };

  private unavailableNote = (source: SignalSource, error: string): string => {
    if (source === 'linkedin') {
      return this.braveApiKey
        ? `LinkedIn web search could not be reached (${error})`
        : 'LinkedIn is reached via web search — the keyless engine is rate-limited and refused this batch; set BRAVE_API_KEY (free tier) for reliable results';
    }
    if (source === 'reddit') {
      return this.redditClientId
        ? `Reddit search could not be reached (${error})`
        : `Reddit public RSS search could not be reached (${error}) — set REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET (free script app) for the authenticated API, which also returns scores and comment counts`;
    }
    return `${source} search could not be reached (${error})`;
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
      signal: AbortSignal.timeout(9000)
    });
    if (!res.ok) throw new Error(`reddit auth HTTP ${res.status}`);
    const json = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!json.access_token) throw new Error('reddit auth: no token');
    this.redditToken = {
      value: json.access_token,
      expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000
    };
    return this.redditToken.value;
  };

  /**
   * OAuth when credentials exist (richer: scores and comment counts), and
   * the public RSS search when they don't. Reddit hard-403s the JSON
   * endpoints unauthenticated, but `search.rss` is still served — no
   * engagement metrics, but the threads themselves are the signal.
   */
  private reddit = async (query: string): Promise<SignalItem[]> => {
    const token = await this.redditAuth().catch(() => null);
    if (!token) return this.redditRss(query);
    const json = await fetchJson(
      `https://oauth.reddit.com/search?q=${encodeURIComponent(query)}&sort=relevance&t=year&limit=8`,
      { authorization: `Bearer ${token}` }
    );
    return (json?.data?.children ?? [])
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
  };

  private redditRss = async (query: string): Promise<SignalItem[]> => {
    const xml = await fetchText(
      `https://www.reddit.com/search.rss?q=${encodeURIComponent(query)}&sort=relevance&t=year&limit=8`
    );
    const entries = xml.match(/<entry>([\s\S]*?)<\/entry>/g) ?? [];
    return entries
      .map((raw) => {
        const title = decodeEntities(
          raw.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? ''
        );
        const url = raw.match(/<link[^>]*href="([^"]+)"/)?.[1] ?? '';
        const sub = url.match(/reddit\.com\/r\/([^/]+)/)?.[1];
        const body = decodeEntities(
          raw.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1] ?? ''
        );
        return {
          title,
          url,
          // RSS carries no score; rank by presence, not popularity.
          score: 0,
          context: sub ? `r/${sub}` : 'Reddit',
          snippet: body.slice(0, 220) || undefined
        };
      })
      // Subreddit landing pages come back as bare /r/<sub>/ links.
      .filter((i) => i.title && /\/comments\//.test(i.url));
  };

  /** Stories and comments: comments are where the unmet pain is stated. */
  private hackerNews = async (query: string): Promise<SignalItem[]> => {
    const [stories, comments] = await Promise.all([
      fetchJson(
        `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=6`
      ),
      fetchJson(
        `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=comment&hitsPerPage=4`
      ).catch(() => ({ hits: [] }))
    ]);
    const storyItems: SignalItem[] = (stories?.hits ?? []).map(
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
    const commentItems: SignalItem[] = (comments?.hits ?? [])
      .filter((h: Record<string, unknown>) => h.comment_text)
      .map((h: Record<string, unknown>) => ({
        title: `Comment on “${String(h.story_title ?? 'HN thread')}”`,
        url: `https://news.ycombinator.com/item?id=${String(h.objectID ?? '')}`,
        score: Number(h.points ?? 0),
        context: 'Hacker News · comment',
        snippet: decodeEntities(String(h.comment_text ?? '')).slice(0, 240)
      }));
    return [...storyItems, ...commentItems];
  };

  private github = async (query: string): Promise<SignalItem[]> => {
    const json = await fetchJson(
      `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=6`
    );
    return (json?.items ?? []).map((r: Record<string, unknown>) => ({
      title: String(r.full_name ?? ''),
      url: String(r.html_url ?? ''),
      score: Number(r.stargazers_count ?? 0),
      context: 'GitHub',
      snippet: String(r.description ?? '').slice(0, 220) || undefined
    }));
  };

  /** Developer pain, phrased as questions people actually needed answered. */
  private stackOverflow = async (query: string): Promise<SignalItem[]> => {
    const json = await fetchJson(
      `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=votes&q=${encodeURIComponent(query)}&site=stackoverflow&pagesize=6&filter=default`
    );
    return (json?.items ?? []).map((q: Record<string, unknown>) => ({
      title: decodeEntities(String(q.title ?? '')),
      url: String(q.link ?? ''),
      score: Number(q.score ?? 0),
      comments: Number(q.answer_count ?? 0),
      context: Array.isArray(q.tags)
        ? `Stack Overflow · ${(q.tags as string[]).slice(0, 3).join(', ')}`
        : 'Stack Overflow',
      snippet: q.is_answered === false ? 'Unanswered question' : undefined
    }));
  };

  private devTo = async (query: string): Promise<SignalItem[]> => {
    const json = await fetchJson(
      `https://dev.to/api/articles/search?per_page=6&q=${encodeURIComponent(query)}`
    ).catch(async () =>
      // The search endpoint is not always available; fall back to the tag feed
      // using the most significant word in the query.
      fetchJson(
        `https://dev.to/api/articles?per_page=6&tag=${encodeURIComponent(
          broaden(query).split(' ')[0] ?? ''
        )}`
      )
    );
    const rows = Array.isArray(json) ? json : (json?.result ?? []);
    return rows.map((a: Record<string, unknown>) => ({
      title: String(a.title ?? ''),
      url: String(a.url ?? ''),
      score: Number(a.public_reactions_count ?? a.positive_reactions_count ?? 0),
      comments: Number(a.comments_count ?? 0),
      context: 'Dev.to',
      snippet: String(a.description ?? '').slice(0, 220) || undefined
    }));
  };

  /** Shipped packages solving adjacent problems — direct competition. */
  private npm = async (query: string): Promise<SignalItem[]> => {
    const json = await fetchJson(
      `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=6`
    );
    return (json?.objects ?? []).map((o: Record<string, any>) => ({
      title: String(o.package?.name ?? ''),
      url: String(
        o.package?.links?.npm ?? `https://www.npmjs.com/package/${o.package?.name}`
      ),
      // Popularity is 0-1; scale so it ranks sensibly against upvote counts.
      score: Math.round(Number(o.score?.detail?.popularity ?? 0) * 1000),
      context: 'npm',
      snippet: String(o.package?.description ?? '').slice(0, 220) || undefined
    }));
  };

  /** Market and competitor coverage, via Google News RSS (no key required). */
  private news = async (query: string): Promise<SignalItem[]> => {
    const xml = await fetchText(
      `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`
    );
    const items = xml.match(/<item>([\s\S]*?)<\/item>/g) ?? [];
    return items.slice(0, 6).map((raw) => {
      const pick = (tag: string) =>
        decodeEntities(
          raw.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1] ?? ''
        );
      const source = pick('source');
      return {
        title: pick('title'),
        url: pick('link'),
        // RSS carries no engagement metric; recency is the ranking signal.
        score: 0,
        context: source ? `News · ${source}` : 'News',
        snippet: pick('pubDate') || undefined
      };
    });
  };

  /**
   * Web search, used to reach sources that have no API of their own.
   * Brave's API when a key is configured; otherwise Mojeek, which serves
   * a keyless HTML result page from its own independent index.
   */
  private webSearch = async (
    query: string,
    site?: string
  ): Promise<SignalItem[]> => {
    const q = site ? `site:${site} ${query}` : query;

    if (this.braveApiKey) {
      const json = await fetchJson(
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=6`,
        { 'x-subscription-token': this.braveApiKey }
      );
      return (json?.web?.results ?? []).map((r: Record<string, unknown>) => ({
        title: decodeEntities(String(r.title ?? '')),
        url: String(r.url ?? ''),
        score: 0,
        context: site ?? 'Web',
        snippet: decodeEntities(String(r.description ?? '')).slice(0, 240)
      }));
    }

    const html = await fetchText(
      `https://www.mojeek.com/search?q=${encodeURIComponent(q)}`
    );
    const block = html.match(
      /<ul class="results-standard">([\s\S]*?)<\/ul>/
    )?.[1];
    // No results container means we were served a block/captcha page, not an
    // empty result set — report it as unavailable rather than as "searched,
    // found nothing", which would be a lie the analysis acts on.
    if (block === undefined) {
      throw new Error('keyless web search returned no result markup');
    }
    const rows = block.match(/<li class="r\d+">[\s\S]*?<\/li>/g) ?? [];
    return rows.slice(0, 6).map((row) => ({
      title: decodeEntities(
        row.match(/<a class="title"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? ''
      ),
      url: row.match(/<a class="title"[^>]*href="([^"]+)"/)?.[1] ?? '',
      score: 0,
      context: site ?? 'Web',
      snippet: decodeEntities(
        row.match(/<p class="s">([\s\S]*?)<\/p>/)?.[1] ?? ''
      ).slice(0, 240)
    }));
  };

  /**
   * LinkedIn posts, company pages, and Pulse articles via web search.
   * LinkedIn sells no public search API at any tier, but the public
   * surface is indexed — this reaches the professional/market conversation
   * without scraping LinkedIn itself.
   */
  private linkedin = async (query: string): Promise<SignalItem[]> => {
    const items = await this.webSearch(query, 'linkedin.com');
    return items
      .filter((i) => /linkedin\.com/.test(i.url))
      .map((i) => ({
        ...i,
        context: /\/pulse\//.test(i.url)
          ? 'LinkedIn · article'
          : /\/company\//.test(i.url)
            ? 'LinkedIn · company'
            : /\/posts\/|\/feed\//.test(i.url)
              ? 'LinkedIn · post'
              : 'LinkedIn'
      }));
  };
}
