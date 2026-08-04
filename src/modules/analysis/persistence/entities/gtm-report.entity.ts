import { defineComplianceEntity, fp } from '@forklaunch/core/persistence';
import type { InferEntity } from '@mikro-orm/core';
import { sqlBaseProperties } from '@gtm-validator/core';
import { StartupIdeaEntity } from './startup-idea.entity';

/**
 * One versioned GTM analysis of an idea: themed dimension scores, real-world
 * signals, the adversarial bear case, the viability verdict, and (optionally)
 * the ForkLaunch build blueprint generated after validation.
 */
export const GtmReportEntity = defineComplianceEntity({
  name: 'GtmReport',
  properties: {
    ...sqlBaseProperties,
    idea: () => fp.manyToOne(StartupIdeaEntity),
    version: fp.integer().compliance('none'),
    /** Snapshot of the pitch this report analyzed */
    pitchSnapshot: fp.text().compliance('pii'),
    viabilityScore: fp.integer().compliance('none'),
    verdict: fp.string().compliance('none'),
    summary: fp.text().compliance('pii'),
    dimensions: fp.json().compliance('none'),
    signals: fp.json().compliance('none'),
    bearCase: fp.json().compliance('none'),
    blueprint: fp.json().nullable().compliance('none'),
    organizationId: fp.string().index().compliance('none')
  }
});

export type GtmReport = InferEntity<typeof GtmReportEntity>;
