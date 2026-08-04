import { defineComplianceEntity, fp } from '@forklaunch/core/persistence';
import type { InferEntity } from '@mikro-orm/core';
import { sqlBaseProperties } from '@gtm-validator/core';

/** A startup idea under GTM validation. The pitch evolves across report versions. */
export const StartupIdeaEntity = defineComplianceEntity({
  name: 'StartupIdea',
  properties: {
    ...sqlBaseProperties,
    title: fp.string().compliance('none'),
    pitch: fp.text().compliance('none'),
    organizationId: fp.string().index().compliance('none')
  }
});

export type StartupIdea = InferEntity<typeof StartupIdeaEntity>;
