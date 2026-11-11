import type { FastifyInstance } from 'fastify';
import {
  DatasetConflictError, DatasetInputError, DatasetStorageError,
  decodeUtf8, parseCsvRowsStrict, TABULAR_LIMITS,
  type InlineDatasetInput,
} from '@koiforge/data-registry';

import type { AppRegistries } from '../registries.js';
import { createSessionGuard } from './_guard.js';

export async function registerIngestRoutes(app: FastifyInstance, registries: AppRegistries): Promise<void> {
  const { guard } = createSessionGuard(registries.security);

  // These pre-session paths bypassed candidate verification / complete readback.
  // Keep an authenticated migration response, but never execute code, call a
  // provider, or extract an archive here. The active UI already uses sessions.
  for (const path of ['/api/datasets/ai-import', '/api/datasets/extract-archive']) {
    app.post(path, async (request, reply) => {
      if (!(await guard(request, reply, ['datasets.manage']))) return reply;
      return reply.code(410).send({
        code: 'IMPORT_WORKSPACE_REQUIRED',
        error: 'Dieser Importweg wurde abgelöst. Bitte unter Datenquellen „Datenquelle hinzufügen“ verwenden und den geprüften Import bestätigen.',
        replacement: '/api/import/sessions',
      });
    });
  }

  // Compatibility CSV endpoint: exactly the parser and limits used by sessions.
  app.post('/api/datasets/upload', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.manage']))) return reply;
    const fields: Record<string, string> = {};
    let bytes: Buffer | undefined;
    try {
      for await (const part of request.parts({ limits: {
        fileSize: TABULAR_LIMITS.maxInputBytes, files: 1, fields: 4, parts: 5, fieldSize: 8192,
      } })) {
        if (part.type === 'file') {
          if (part.fieldname !== 'file' || bytes) throw new DatasetInputError('Genau eine Datei im Feld „file“ ist erforderlich.');
          bytes = await part.toBuffer();
          if (part.file.truncated) return reply.code(413).send({ error: 'Datei überschreitet 10 MiB; es wurde kein Ausschnitt importiert.' });
        } else {
          if (!['name', 'namespace', 'description', 'delimiter'].includes(part.fieldname)
            || Object.hasOwn(fields, part.fieldname) || part.valueTruncated || typeof part.value !== 'string') {
            throw new DatasetInputError('Importfelder sind ungültig, doppelt oder zu lang.');
          }
          fields[part.fieldname] = part.value;
        }
      }
      if (!bytes?.length) throw new DatasetInputError('Keine Datei empfangen.');
      if (!fields.name?.trim()) throw new DatasetInputError('Feld „name“ ist erforderlich.');
      const rows = parseCsvRowsStrict(decodeUtf8(bytes), fields.delimiter ?? ',');
      if (rows.length === 0) throw new DatasetInputError('Die Datei enthält keine Datenzeilen.');
      const dataset = await registries.dataset.registerInlineDataset({
        name: fields.name, namespace: fields.namespace ?? 'uploads', description: fields.description, rows,
      });
      return reply.code(201).send(dataset);
    } catch (error) {
      if (error instanceof DatasetStorageError || error instanceof DatasetConflictError || error instanceof DatasetInputError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      const multipartCode = (error as { code?: string })?.code;
      if (['FST_REQ_FILE_TOO_LARGE', 'FST_FILES_LIMIT', 'FST_FIELDS_LIMIT', 'FST_PARTS_LIMIT'].includes(multipartCode ?? '')) {
        return reply.code(413).send({ error: 'Importgrenze überschritten: maximal eine Datei mit 10 MiB und vier Felder. Es wurde nichts importiert.' });
      }
      return reply.code(400).send({ error: 'Die Datei konnte nicht vollständig gelesen werden. Bitte den Upload prüfen.' });
    }
  });

  app.post<{ Body: InlineDatasetInput }>('/api/datasets/inline', {
    bodyLimit: TABULAR_LIMITS.maxOutputBytes + 64 * 1024,
  }, async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.manage']))) return reply;
    const input = request.body;
    if (!input || !Array.isArray(input.rows) || input.rows.length === 0) {
      return reply.code(400).send({ error: 'rows muss ein nicht-leeres Array sein.' });
    }
    try {
      const dataset = await registries.dataset.registerInlineDataset({
        ...input, namespace: input.namespace ?? 'uploads',
      });
      return reply.code(201).send(dataset);
    } catch (error) {
      const statusCode = error instanceof DatasetStorageError || error instanceof DatasetConflictError || error instanceof DatasetInputError ? error.statusCode : 400;
      return reply.code(statusCode).send({ error: error instanceof Error ? error.message : 'Registrierung fehlgeschlagen.' });
    }
  });
}
