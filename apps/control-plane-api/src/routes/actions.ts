import type { FastifyInstance } from 'fastify';
import type { ActionContribution } from '@koiforge/module-manifest';

import type { AppRegistries } from '../registries.js';
import { createSessionGuard } from './_guard.js';

export interface ActionDefinition {
  name: string;
  moduleId: string;
  contractVersion: number;
  input: string;       // object type the action applies to, e.g. "procurement-order@^3"
  permissions: string[];
  sideEffects: string[];
  executable: false;
  unavailableReason: string;
}

export interface ExecuteActionBody {
  objectId: string;
  objectType: string;
  params?: Record<string, unknown>;
}

const unavailableReason = 'Für diese Aktion ist noch keine Ausführung eingerichtet. Es wurden keine Änderungen vorgenommen.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isExecuteActionBody(value: unknown): value is ExecuteActionBody {
  return isRecord(value)
    && typeof value.objectId === 'string' && value.objectId.trim().length > 0
    && typeof value.objectType === 'string' && value.objectType.trim().length > 0
    && (value.params === undefined || isRecord(value.params));
}

function parseObjectType(input: string): string {
  // "procurement-order@^3" → "procurement-order"
  return input.split('@')[0]!.trim();
}

export function registerActionsRoutes(app: FastifyInstance, registries: AppRegistries): void {
  const { guard } = createSessionGuard(registries.security);

  // List available action types from enabled modules
  app.get('/api/actions', async (request, reply) => {
    if (!(await guard(request, reply, ['modules.read']))) return reply;

    const state = await registries.module.getState();
    const actions: ActionDefinition[] = [];

    for (const [moduleId, record] of Object.entries(state.modules)) {
      if (record.status !== 'enabled') continue;
      const latestVersion = record.versions[record.versions.length - 1];
      if (!latestVersion) continue;
      const manifest = latestVersion.manifest as { contributes?: { actions?: ActionContribution[] } };
      for (const action of manifest.contributes?.actions ?? []) {
        actions.push({
          name: action.name,
          moduleId,
          contractVersion: action['contract-version'],
          input: action.input,
          permissions: action.permissions,
          sideEffects: action['side-effects'] ?? [],
          executable: false,
          unavailableReason,
        });
      }
    }

    return { items: actions };
  });

  // Module manifests declare actions; no execution handlers are installed yet.
  app.post<{ Body: unknown }>('/api/actions/:actionName/execute', async (request, reply) => {
    if (!(await guard(request, reply, ['modules.read']))) return reply;
    const { actionName } = request.params as { actionName: string };
    if (!isExecuteActionBody(request.body)) {
      reply.code(400);
      return { error: 'Bitte eine Objekt-ID und einen Objekttyp angeben. Optionale Parameter müssen ein Objekt sein.' };
    }
    const { objectType } = request.body;

    // Find action definition
    const state = await registries.module.getState();
    let actionDef: ActionDefinition | null = null;

    for (const [moduleId, record] of Object.entries(state.modules)) {
      if (record.status !== 'enabled') continue;
      const latestVersion = record.versions[record.versions.length - 1];
      if (!latestVersion) continue;
      const manifest = latestVersion.manifest as { contributes?: { actions?: ActionContribution[] } };
      const found = manifest.contributes?.actions?.find((a) => a.name === actionName);
      if (found) {
        actionDef = {
          name: found.name,
          moduleId,
          contractVersion: found['contract-version'],
          input: found.input,
          permissions: found.permissions,
          sideEffects: found['side-effects'] ?? [],
          executable: false,
          unavailableReason,
        };
        break;
      }
    }

    if (!actionDef) {
      reply.code(404);
      return { error: `Die Aktion '${actionName}' ist in keinem aktivierten Modul vorhanden.` };
    }

    if (!(await guard(request, reply, actionDef.permissions))) return reply;

    // Validate that action applies to the given object type
    const expectedType = parseObjectType(actionDef.input);
    if (expectedType !== objectType) {
      reply.code(400);
      return { error: `Die Aktion '${actionName}' gilt für den Objekttyp '${expectedType}', nicht für '${objectType}'.` };
    }

    // A declaration is not a completed action. Do not create success records or
    // imply that declared side effects happened without an execution handler.
    reply.code(501);
    return {
      code: 'ACTION_NOT_IMPLEMENTED',
      error: unavailableReason,
      action: actionName,
      moduleId: actionDef.moduleId,
      executable: false,
    };
  });
}
