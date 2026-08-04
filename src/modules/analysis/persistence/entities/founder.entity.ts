import { defineComplianceEntity, fp } from '@forklaunch/core/persistence';
import type { InferEntity } from '@mikro-orm/core';
import { sqlBaseProperties } from '@gtm-validator/core';

/**
 * The person trying the validator — the top of the marketing funnel.
 * Identity fields are encrypted at rest; the email lookup hash lets us
 * dedupe returning founders without decrypting anything.
 */
export const FounderEntity = defineComplianceEntity({
  name: 'Founder',
  properties: {
    ...sqlBaseProperties,
    name: fp.string().compliance('pii'),
    email: fp.string().compliance('pii'),
    emailLookupHash: fp.string().index().compliance('none'),
    company: fp.string().nullable().compliance('pii'),
    organizationId: fp.string().index().compliance('none')
  }
});

export type Founder = InferEntity<typeof FounderEntity>;
