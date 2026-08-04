import {
  array,
  boolean,
  number,
  optional,
  string,
  unknown,
  uuid
} from '@gtm-validator/core';

export const SubmitIdeaSchema = {
  title: string,
  pitch: string
};

export const ReanalyzeSchema = {
  title: optional(string),
  pitch: optional(string)
};

export const RefineSchema = {
  // one of: marketPull | differentiation | timing | distribution | monetization
  focus: string,
  feedback: array(string)
};

export const GtmDimensionSchema = {
  key: string,
  name: string,
  score: number,
  summary: string,
  actionableFeedback: array(string)
};

export const SignalItemSchema = {
  title: string,
  url: string,
  score: number,
  comments: optional(number),
  context: optional(string),
  snippet: optional(string)
};

export const SourceSignalsSchema = {
  source: string,
  status: string,
  query: string,
  items: array(SignalItemSchema),
  note: optional(string)
};

export const BearCaseItemSchema = {
  claim: string,
  severity: number,
  counterplay: string
};

export const BlueprintSchema = {
  appName: string,
  database: string,
  rationale: string,
  services: array({ name: string, description: string }),
  workers: array({ name: string, type: string, description: string }),
  libraries: array({ name: string, description: string }),
  diagram: string,
  scaffoldCommands: array(string),
  buildPrompt: string,
  shipSteps: array({ title: string, detail: string, command: optional(string) })
};

export const ReportSchema = {
  id: uuid,
  ideaId: uuid,
  version: number,
  title: string,
  pitch: string,
  viabilityScore: number,
  verdict: string,
  summary: string,
  generatedBy: string,
  dimensions: array(GtmDimensionSchema),
  signals: array(SourceSignalsSchema),
  bearCase: array(BearCaseItemSchema),
  blueprint: optional(unknown),
  createdAt: string
};

export const RefineResponseSchema = {
  report: ReportSchema,
  changes: array(string)
};

export const IdeaListItemSchema = {
  id: uuid,
  title: string,
  latestScore: optional(number),
  latestVerdict: optional(string),
  versions: number,
  createdAt: string
};

export const IdeaListResponseSchema = {
  ideas: array(IdeaListItemSchema)
};

export const ReportsResponseSchema = {
  reports: array(ReportSchema)
};

// keep boolean referenced for validators that need it later
export const _internal = { boolean };
