import { handlers, schemaValidator, string, uuid } from '@gtm-validator/core';
import { getEnvVar } from '@forklaunch/core/services';
import {
  FunnelResponseSchema,
  IdeaListResponseSchema,
  ReanalyzeSchema,
  RefineResponseSchema,
  RefineSchema,
  ReportSchema,
  ReportsResponseSchema,
  SubmitIdeaSchema
} from '../../domain/schemas/gtm.schema';
import { AiUnavailableError } from '../../domain/services/foundry.service';
import { IdeaNotFoundError } from '../../domain/services/gtm.service';
import { ci, tokens } from '../../bootstrapper';

const scopeFactory = () => ci.createScope();
const gtmServiceFactory = ci.scopedResolver(tokens.GtmService);
const gtmService = () => gtmServiceFactory({ scope: scopeFactory() });

const handleKnown = (
  error: unknown,
  res: { status: (code: 404 | 502) => { send: (msg: string) => void } }
): boolean => {
  if (error instanceof IdeaNotFoundError) {
    res.status(404).send('Idea not found');
    return true;
  }
  if (error instanceof AiUnavailableError) {
    res.status(502).send(error.message);
    return true;
  }
  return false;
};

export const submitIdea = handlers.post(
  schemaValidator,
  '/ideas',
  {
    name: 'Analyze Idea',
    summary:
      'Analyzes a startup idea: real-world signals (Reddit, Hacker News, GitHub), themed GTM scoring, adversarial bear case, viability verdict',
    access: 'public',
    body: SubmitIdeaSchema,
    responses: { 201: ReportSchema, 502: string }
  },
  async (req, res) => {
    try {
      res.status(201).json(await gtmService().analyze(req.body));
    } catch (error) {
      if (!handleKnown(error, res)) throw error;
    }
  }
);

export const listIdeas = handlers.get(
  schemaValidator,
  '/ideas',
  {
    name: 'List Ideas',
    summary: 'Lists analyzed ideas with latest viability',
    access: 'public',
    responses: { 200: IdeaListResponseSchema }
  },
  async (req, res) => {
    res.status(200).json({ ideas: await gtmService().list() });
  }
);

export const getIdeaReports = handlers.get(
  schemaValidator,
  '/ideas/:id',
  {
    name: 'Get Idea Reports',
    summary: 'All report versions for an idea, newest first',
    access: 'public',
    params: { id: uuid },
    responses: { 200: ReportsResponseSchema, 404: string }
  },
  async (req, res) => {
    try {
      res.status(200).json({ reports: await gtmService().get(req.params.id) });
    } catch (error) {
      if (!handleKnown(error, res)) throw error;
    }
  }
);

export const reanalyzeIdea = handlers.post(
  schemaValidator,
  '/ideas/:id/reanalyze',
  {
    name: 'Reanalyze Idea',
    summary: 'Re-runs the full analysis on an edited pitch as a new version',
    access: 'public',
    params: { id: uuid },
    body: ReanalyzeSchema,
    responses: { 201: ReportSchema, 404: string, 502: string }
  },
  async (req, res) => {
    try {
      res
        .status(201)
        .json(await gtmService().reanalyze(req.params.id, req.body));
    } catch (error) {
      if (!handleKnown(error, res)) throw error;
    }
  }
);

export const refineIdea = handlers.post(
  schemaValidator,
  '/ideas/:id/refine',
  {
    name: 'Refine Idea',
    summary:
      'AI rewrites the pitch toward a focus dimension, then re-analyzes as a new version',
    access: 'public',
    params: { id: uuid },
    body: RefineSchema,
    responses: { 201: RefineResponseSchema, 404: string, 502: string }
  },
  async (req, res) => {
    try {
      res
        .status(201)
        .json(
          await gtmService().refine(
            req.params.id,
            req.body.focus,
            req.body.feedback
          )
        );
    } catch (error) {
      if (!handleKnown(error, res)) throw error;
    }
  }
);

export const getFunnel = handlers.get(
  schemaValidator,
  '/funnel',
  {
    name: 'Marketing Funnel',
    summary:
      'Founders who tried the validator with their ideas and outcomes (internal; requires x-funnel-token)',
    access: 'public',
    requestHeaders: { 'x-funnel-token': string },
    responses: { 200: FunnelResponseSchema, 403: string }
  },
  async (req, res) => {
    const expected = getEnvVar('FUNNEL_TOKEN') ?? '';
    if (!expected || req.headers['x-funnel-token'] !== expected) {
      res.status(403).send('Funnel access requires a valid x-funnel-token');
      return;
    }
    res.status(200).json({ founders: await gtmService().funnel() });
  }
);

export const generateBlueprint = handlers.post(
  schemaValidator,
  '/ideas/:id/blueprint',
  {
    name: 'Generate Build Blueprint',
    summary:
      'Generates the ForkLaunch architecture (diagram, scaffold commands, build prompt, ship steps) for the idea',
    access: 'public',
    params: { id: uuid },
    responses: { 200: ReportSchema, 404: string, 502: string }
  },
  async (req, res) => {
    try {
      res.status(200).json(await gtmService().blueprint(req.params.id));
    } catch (error) {
      if (!handleKnown(error, res)) throw error;
    }
  }
);
