import type { FileSecurityRegistry, SessionContext } from '@koiforge/security-core';
import type { FastifyReply, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    koiforgeSession: SessionContext;
  }
}

export function createSessionGuard(securityRegistry: FileSecurityRegistry) {
  async function attachSession(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    if (request.koiforgeSession?.user?.id) return true;
    reply.code(401).send({ error: 'Bitte anmelden.' });
    return false;
  }

  async function guard(
    request: FastifyRequest,
    reply: FastifyReply,
    permissions: string[],
  ): Promise<boolean> {
    if (!(await attachSession(request, reply))) {
      return false;
    }
    try {
      securityRegistry.assertPermissions(request.koiforgeSession, permissions);
      return true;
    } catch (error) {
      reply.code(403);
      reply.send({ error: error instanceof Error ? error.message : 'Zugriff verweigert.' });
      return false;
    }
  }

  return { attachSession, guard };
}
