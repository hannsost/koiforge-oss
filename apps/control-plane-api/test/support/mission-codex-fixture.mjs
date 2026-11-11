#!/usr/bin/env node
// Deterministic CLI double for browser tests only. Never used by the app launcher.
import { writeFile } from 'node:fs/promises';
if (process.argv.includes('login')) {
  process.stdout.write('Logged in using ChatGPT\n');
} else {
  let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
  const task = JSON.parse(prompt.split('\n\nTask:\n')[1].split('\n\nReturn the requested')[0]);
  const unsupported = task.question.includes('Lieferungen');
  const freshness = task.question.includes('Quellenalter');
  const relationship = Boolean(task.relationship);
  const orders = relationship && /offene Bestellungen|Bestellungen.*offen/i.test(task.question);
  const plan = { capabilityId: unsupported ? null : orders ? 'order_review' : relationship ? 'relationship_integrity' : freshness ? 'source_freshness' : 'data_quality',
    summary: unsupported ? 'Lieferprognosen sind noch nicht verfügbar.' : orders ? 'Offene Bestellungen mit bestätigten Statuswerten und Lieferkalendertagen klären.' : relationship ? 'Fehlende und mehrdeutige Zuordnungen anhand der bestätigten Beziehung prüfen.' : freshness ? 'Quellenalter anhand der bestätigten Zeitregel prüfen.' : 'Fehlende Werte und doppelte Schlüssel prüfen.',
    suggestedBinding: unsupported ? {} : orders ? { statusField: 'status', dueDateField: 'due' } : relationship ? {} : freshness ? { keyField: 'id', timestampField: 'updated' } : { keyField: 'id' },
    unsupportedReason: unsupported ? 'Für Lieferprognosen fehlt eine ausführbare Fähigkeit.' : null };
  await writeFile(process.argv[process.argv.indexOf('--output-last-message') + 1], JSON.stringify({ artifact: JSON.stringify(plan) }));
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: {} }) + '\n');
}
