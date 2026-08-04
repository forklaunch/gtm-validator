import { forklaunchRouter, schemaValidator } from '@gtm-validator/core';
import {
  generateBlueprint,
  getIdeaReports,
  listIdeas,
  reanalyzeIdea,
  refineIdea,
  submitIdea
} from '../controllers/gtm.controller';
import { ci, tokens } from '../../bootstrapper';

const openTelemetryCollector = ci.resolve(tokens.OtelCollector);

export const gtmRouter = forklaunchRouter(
  '/gtm',
  schemaValidator,
  openTelemetryCollector
);

export const submitIdeaRoute = gtmRouter.post('/ideas', submitIdea);
export const listIdeasRoute = gtmRouter.get('/ideas', listIdeas);
export const getIdeaReportsRoute = gtmRouter.get('/ideas/:id', getIdeaReports);
export const reanalyzeIdeaRoute = gtmRouter.post(
  '/ideas/:id/reanalyze',
  reanalyzeIdea
);
export const refineIdeaRoute = gtmRouter.post('/ideas/:id/refine', refineIdea);
export const generateBlueprintRoute = gtmRouter.post(
  '/ideas/:id/blueprint',
  generateBlueprint
);
