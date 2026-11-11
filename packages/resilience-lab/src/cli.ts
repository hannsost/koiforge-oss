import { readdir } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import { runResilienceScenario } from './runner.js';
import { buildAiHandoff, buildAiHandoffMarkdown, buildTriageSummary, loadBundleArtifacts } from './triage.js';

async function listScenarios(): Promise<void> {
  const directory = resolve(process.env.INIT_CWD ?? process.cwd(), 'scenarios', 'resilience');
  const files = await readdir(directory);
  for (const file of files.filter((entry) => entry.endsWith('.json')).sort()) {
    console.log(basename(file, '.json'));
  }
}

function parseArgs(argv: string[]) {
  const args = new Map<string, string | boolean>();

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current) continue;
    if (!current.startsWith('--')) continue;

    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      args.set(current, next);
      index += 1;
    } else {
      args.set(current, true);
    }
  }

  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.has('--list')) {
  await listScenarios();
  process.exit(0);
}

if (args.has('--triage')) {
  const fs = await import('node:fs/promises');
  const bundlePath = (args.get('--bundle') as string | undefined)
    ?? (await fs.readFile(resolve(process.env.INIT_CWD ?? process.cwd(), '.koiforge', 'resilience-runs', 'latest-run.txt'), 'utf8')).trim();
  const artifacts = await loadBundleArtifacts(bundlePath);
  const triage = buildTriageSummary(artifacts);
  const handoff = buildAiHandoff(triage, bundlePath);
  console.log(JSON.stringify({ triage, handoff }, null, 2));
  console.log(buildAiHandoffMarkdown(handoff));
  process.exit(0);
}

const scenarioId = (args.get('--scenario') as string | undefined) ?? 'identity-drift-001';
const withRegression = args.has('--with-regression');

const summary = await runResilienceScenario({ scenarioId, withRegression });
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.status === 'passed' ? 0 : 1);
