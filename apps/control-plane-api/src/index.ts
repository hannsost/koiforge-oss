import { buildServer } from './server.js';
import { getConfig } from './config.js';

const config = getConfig();
const startup = buildServer();
let stopping = false;
let shutdown: Promise<void> | undefined;

function stop(exitCode: number): Promise<void> {
  stopping = true;
  return shutdown ??= (async () => {
    // A stalled worker must not keep an operator's stop request hanging. Until
    // orderly close completes, leases remain held; process exit releases them.
    const timeout = setTimeout(() => {
      console.error('Das Beenden hat 15 Sekunden überschritten. Der Prozess wird beendet; unvollständige Aufträge bleiben unterbrochen.');
      process.exit(1);
    }, 15_000);
    try {
      const app = await startup.catch(() => undefined);
      if (app) await app.close();
    } catch (error) {
      console.error('Fehler beim Beenden des API-Prozesses:', error); exitCode = 1;
    } finally {
      clearTimeout(timeout);
      process.exit(exitCode);
    }
  })();
}
process.once('SIGTERM', () => { void stop(0); });
process.once('SIGINT', () => { void stop(0); });

try {
  const app = await startup;
  if (!stopping) await app.listen({ host: config.host, port: config.port });
} catch (error) {
  if (!stopping) {
    console.error('API-Start fehlgeschlagen:', error);
    await stop(1);
  }
}
