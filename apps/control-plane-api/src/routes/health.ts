import type { FastifyInstance } from 'fastify';

import type { AppConfig } from '../config.js';

export function registerHealthRoute(app: FastifyInstance, config: AppConfig): void {
  app.get('/health', async () => ({
    status: 'ok',
    service: 'koiforge-control-plane-api',
    coreVersion: config.coreVersion,
  }));
}
