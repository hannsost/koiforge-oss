import type { ConfigState } from './types.js';

export function createDefaultConfigState(): ConfigState {
  const now = new Date().toISOString();

  return {
    secrets: [
      {
        id: 'secret-global-s3-access-key',
        name: 'global.s3.access-key',
        scope: 'global',
        description: 'Global S3 access key for object storage.',
        tags: ['s3', 'storage'],
        value: 'AKIA-DEMO-KOIFORGE',
        createdAt: now,
        updatedAt: now,
      },
    ],
    entries: [
      {
        id: 'cfg-global-s3-bucket',
        key: 'storage.s3.bucket',
        scope: 'global',
        valueType: 'string',
        value: 'koiforge-dev-artifacts',
        description: 'Default S3 bucket for artifacts.',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'cfg-global-s3-access-key',
        key: 'storage.s3.accessKey',
        scope: 'global',
        valueType: 'secret-ref',
        value: 'secret-global-s3-access-key',
        description: 'Secret reference for S3 access key.',
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
}
