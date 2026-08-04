const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8000';

export type GtmFocus =
  | 'marketPull'
  | 'differentiation'
  | 'timing'
  | 'distribution'
  | 'monetization';

export interface GtmDimension {
  key: GtmFocus;
  name: string;
  score: number;
  summary: string;
  actionableFeedback: string[];
}

export interface SignalItem {
  title: string;
  url: string;
  score: number;
  comments?: number;
  context?: string;
  snippet?: string;
}

export interface SourceSignals {
  source: string;
  status: 'ok' | 'empty' | 'unavailable';
  query: string;
  items: SignalItem[];
  note?: string;
}

export interface BearCaseItem {
  claim: string;
  severity: number;
  counterplay: string;
}

export interface Blueprint {
  appName: string;
  database: string;
  rationale: string;
  services: Array<{ name: string; description: string }>;
  workers: Array<{ name: string; type: string; description: string }>;
  libraries: Array<{ name: string; description: string }>;
  diagram: string;
  scaffoldCommands: string[];
  buildPrompt: string;
  shipSteps: Array<{ title: string; detail: string; command?: string }>;
}

export interface Report {
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

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export const analyzeIdea = (data: { title: string; pitch: string }) =>
  post<Report>('/gtm/ideas', data);

export const reanalyzeIdea = (
  ideaId: string,
  data: { title?: string; pitch?: string }
) => post<Report>(`/gtm/ideas/${ideaId}/reanalyze`, data);

export const refineIdea = (
  ideaId: string,
  focus: GtmFocus,
  feedback: string[]
) =>
  post<{ report: Report; changes: string[] }>(`/gtm/ideas/${ideaId}/refine`, {
    focus,
    feedback
  });

export const generateBlueprint = (ideaId: string) =>
  post<Report>(`/gtm/ideas/${ideaId}/blueprint`);
