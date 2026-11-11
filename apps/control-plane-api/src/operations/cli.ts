import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackupError, createBackup, restoreBackup, verifyBackup, type VerifiedBackup } from './backup.js';
import { StateLeaseError } from './state-lease.js';

const usage = 'Aufruf: backup --root PATH --output PATH | verify --backup PATH | restore --backup PATH --target PATH';
function argumentsFor(args: string[]): { command: 'backup' | 'verify' | 'restore'; options: Map<string, string> } {
  const [command, ...rest] = args;
  if (command !== 'backup' && command !== 'verify' && command !== 'restore') throw new BackupError(usage);
  const allowed = command === 'backup' ? ['--root', '--output'] : command === 'verify' ? ['--backup'] : ['--backup', '--target'];
  const options = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]; const value = rest[index + 1];
    if (!key || !allowed.includes(key) || options.has(key) || !value?.trim() || value.startsWith('--') || value.includes('\0')) throw new BackupError(usage);
    options.set(key, value);
  }
  if (options.size !== allowed.length) throw new BackupError(usage);
  return { command, options };
}
function summary(value: VerifiedBackup): string {
  return `${value.fileCount} Dateien, ${value.directoryCount} Verzeichnisse, ${value.totalBytes} Bytes`;
}
export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const { command, options } = argumentsFor(args);
    if (command === 'backup') {
      const value = await createBackup({ root: options.get('--root')!, output: options.get('--output')! });
      process.stdout.write(`Sicherung erstellt und verifiziert: ${summary(value)}.\n`);
    } else if (command === 'verify') {
      const value = await verifyBackup(options.get('--backup')!);
      process.stdout.write(`Sicherung verifiziert: ${summary(value)}. SHA-256 prüft Integrität, keine Authentizität.\n`);
    } else {
      const value = await restoreBackup({ backup: options.get('--backup')!, target: options.get('--target')! });
      process.stdout.write(`State am ursprünglichen Pfad wiederhergestellt: ${summary(value)}.\n`);
    }
    return 0;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    const message = error instanceof BackupError || error instanceof StateLeaseError ? error.message
      : code === 'ENOENT' ? 'Ein erforderlicher Pfad oder ein lokales Hilfsprogramm fehlt.'
        : code === 'EACCES' || code === 'EPERM' ? 'Dateisystemzugriff nicht erlaubt.'
          : 'State-Vorgang fehlgeschlagen. Prüfe Pfade, Offline-Zustand und Dateisystemrechte.';
    process.stderr.write(`${message}\n`);
    return 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
