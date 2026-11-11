import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';

import { fetchAppStore, installApp, uninstallApp, type AppEntry } from '../api';
import { Badge, Card } from '../components/ui';

type Category = 'all' | 'legacy' | 'sandbox';

const CATEGORY_LABEL: Record<'legacy' | 'sandbox', string> = {
  legacy: 'Beispielmodule',
  sandbox: 'Sandbox-Module',
};

const CATEGORY_DESC: Record<'legacy' | 'sandbox', string> = {
  legacy: 'Beispielmodelle für Lieferanten und Bestellungen. Sie schaffen eine Grundlage für die Einrichtung mit deinen eigenen Daten.',
  sandbox: 'Beispielmodelle zum Erproben von Ereignissen und Kennzahlen. Prüfe den Umfang vor der Installation.',
};

const APP_SCOPE: Record<string, { summary: string; install: string }> = {
  'platform-core': {
    summary: 'Stellt ein Beispielmodell für Plattformereignisse und Kennzahlen bereit.',
    install: 'Registriert Objekttypen, Abfragen und eine Objektansicht. Eigene Datenquellen müssen separat verbunden werden.',
  },
  'procurement-core-pack': {
    summary: 'Stellt ein Beispielmodell für Lieferanten und Bestellungen mit einer vorgesehenen Freigabeaktion bereit.',
    install: 'Registriert die Modell- und Aktionsdefinitionen. Setzt das Plattformmodul voraus; ein betrieblicher Freigabeablauf muss gesondert eingerichtet und geprüft werden.',
  },
  'supplier-risk-pack': {
    summary: 'Ergänzt das Lieferantenmodell um eine Risikogruppe und die Abweichung der Lieferzeit.',
    install: 'Registriert zusätzliche Felder und einen Beitrag zur Objektansicht. Setzt das Beschaffungsmodul voraus; eine fachlich abgenommene Risikobewertung ist separat nachzuweisen.',
  },
};

const APP_TAGS: Record<string, string[]> = {
  'platform-core': ['Ereignisse', 'Kennzahlen', 'Beispiel'],
  'procurement-core-pack': ['Einkauf', 'Lieferanten', 'Bestellungen'],
  'supplier-risk-pack': ['Einkauf', 'Lieferanten', 'Zusätzliche Felder'],
};

function appScope(app: AppEntry): { summary: string; install: string } {
  return APP_SCOPE[app.id] ?? {
    summary: app.description,
    install: 'Installiert und aktiviert die im Katalog hinterlegte Moduldatei.',
  };
}

function AppCard({ app, onInstall, onUninstall, busy }: {
  app: AppEntry;
  onInstall: (id: string) => void;
  onUninstall: (id: string) => void;
  busy: string | null;
}) {
  const isBusy = busy === app.id;
  const scope = appScope(app);
  const tags = APP_TAGS[app.id] ?? app.tags;

  return (
    <div
      className="flex min-w-0 flex-col rounded border transition"
      style={{
        borderColor: app.enabled ? 'rgba(79,121,231,0.35)' : 'rgb(var(--rim))',
        background: app.enabled ? 'rgba(79,121,231,0.05)' : 'rgb(var(--panel))',
      }}
    >
      {/* Header */}
      <div className="flex items-start gap-3 p-4">
        <span style={{ fontSize: '32px', lineHeight: 1 }}>{app.icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="break-words font-semibold" style={{ fontSize: '15px', color: 'var(--text-hi)' }}>
              {app.name}
            </span>
            <span className="font-mono" style={{ fontSize: '11px', color: 'var(--text-lo)' }}>
              v{app.version}
            </span>
            {app.enabled && <Badge tone="success">Aktiv</Badge>}
            {app.installed && !app.enabled && <Badge tone="warning">Deaktiviert</Badge>}
          </div>
          <p className="mt-1 leading-5" style={{ fontSize: '13px', color: 'var(--text-mid)' }}>
            {scope.summary}
          </p>
          <p className="mt-2 break-words text-xs leading-5" style={{ color: 'var(--text-lo)' }}>
            <strong>Installationsumfang:</strong> {scope.install}
          </p>
        </div>
      </div>

      {/* Tags */}
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1 px-4 pb-3">
          {tags.map((tag) => (
            <span
              key={tag}
              className="rounded px-1.5 py-0.5"
              style={{ fontSize: '11px', background: 'rgb(var(--rim))', color: 'var(--text-mid)' }}
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Footer */}
      <div
        className="mt-auto flex min-w-0 flex-wrap items-center justify-between gap-3 px-4 py-3"
        style={{ borderTop: '1px solid rgb(var(--rim))', fontSize: '12px' }}
      >
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 break-words" style={{ color: 'var(--text-lo)' }}>
          <span>{app.author}</span>
          <span>{app.license}</span>
          {app.requires.length > 0 && (
            <span>Voraussetzungen: {app.requires.join(', ')}</span>
          )}
        </div>

        <div className="flex w-full shrink-0 flex-wrap items-center justify-end gap-2 sm:w-auto">
          <a
            href={app.homepage}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`${app.name} im Repository öffnen`}
            className="flex items-center gap-1 rounded px-2 py-1 transition"
            style={{ color: 'var(--text-lo)', border: '1px solid rgb(var(--rim))' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.color = 'var(--text-hi)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.color = 'var(--text-lo)'; }}
          >
            <ExternalLink size={12} />
          </a>

          {app.enabled ? (
            <button
              className="rounded px-3 py-1 font-medium transition"
              style={{
                fontSize: '12px',
                border: '1px solid rgba(239,68,68,0.30)',
                color: '#f87171',
                background: 'rgba(239,68,68,0.06)',
                opacity: isBusy ? 0.5 : 1,
                cursor: isBusy ? 'not-allowed' : 'pointer',
              }}
              disabled={isBusy}
              onClick={() => onUninstall(app.id)}
              type="button"
            >
              {isBusy ? 'Wird deaktiviert…' : 'Deaktivieren'}
            </button>
          ) : (
            <button
              className="rounded px-3 py-1 font-semibold transition"
              style={{
                fontSize: '12px',
                background: '#4F79E7',
                color: '#ffffff',
                opacity: isBusy ? 0.5 : 1,
                cursor: isBusy ? 'not-allowed' : 'pointer',
              }}
              disabled={isBusy}
              onClick={() => onInstall(app.id)}
              type="button"
            >
              {isBusy ? 'Wird installiert…' : app.installed ? 'Aktivieren' : 'Installieren'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function AppStoreView() {
  const [apps, setApps] = useState<AppEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<Category>('all');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchAppStore()
      .then(setApps)
      .catch((e) => setError(e instanceof Error ? e.message : 'Der Katalog konnte nicht geladen werden.'))
      .finally(() => setLoading(false));
  }, []);

  const handleInstall = async (appId: string) => {
    setBusy(appId);
    setError(null);
    try {
      const updated = await installApp(appId);
      setApps(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Das Modul konnte nicht installiert werden.');
    } finally {
      setBusy(null);
    }
  };

  const handleUninstall = async (appId: string) => {
    setBusy(appId);
    setError(null);
    try {
      const updated = await uninstallApp(appId);
      setApps(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Das Modul konnte nicht deaktiviert werden.');
    } finally {
      setBusy(null);
    }
  };

  const visibleApps = activeCategory === 'all'
    ? apps
    : apps.filter((a) => a.category === activeCategory);

  const categories: ('legacy' | 'sandbox')[] = ['legacy', 'sandbox'];

  return (
    <>
      {/* Category tabs */}
      <div className="flex flex-wrap items-center gap-2">
        {(['all', ...categories] as Category[]).map((cat) => {
          const active = activeCategory === cat;
          const count = cat === 'all' ? apps.length : apps.filter((a) => a.category === cat).length;
          return (
            <button
              key={cat}
              className="rounded px-3 py-1.5 font-medium transition"
              style={{
                fontSize: '13px',
                background: active ? '#4F79E7' : 'transparent',
                color: active ? '#ffffff' : 'var(--text-mid)',
                border: active ? '1px solid transparent' : '1px solid rgb(var(--rim))',
              }}
              onClick={() => setActiveCategory(cat)}
              type="button"
            >
              {cat === 'all' ? 'Alle Module' : CATEGORY_LABEL[cat]}
              <span className="ml-2 tabular-nums" style={{ fontSize: '11px', opacity: 0.7 }}>{count}</span>
            </button>
          );
        })}
      </div>

      {/* Category description */}
      {activeCategory !== 'all' && (
        <p style={{ fontSize: '14px', color: 'var(--text-lo)' }}>{CATEGORY_DESC[activeCategory]}</p>
      )}

      {error && (
        <div className="rounded border px-4 py-3" style={{ borderColor: 'rgba(239,68,68,0.30)', background: 'rgba(239,68,68,0.06)', fontSize: '13px', color: '#f87171' }}>
          {error}
        </div>
      )}

      {/* App grid by category */}
      {loading ? (
        <div style={{ fontSize: '14px', color: 'var(--text-lo)' }}>Module werden geladen…</div>
      ) : activeCategory === 'all' ? (
        categories.map((cat) => {
          const catApps = apps.filter((a) => a.category === cat);
          if (catApps.length === 0) return null;
          return (
            <Card key={cat} title={CATEGORY_LABEL[cat]}>
              <p className="mb-4" style={{ fontSize: '13px', color: 'var(--text-lo)' }}>{CATEGORY_DESC[cat]}</p>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {catApps.map((app) => (
                  <AppCard key={app.id} app={app} busy={busy} onInstall={handleInstall} onUninstall={handleUninstall} />
                ))}
              </div>
            </Card>
          );
        })
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {visibleApps.map((app) => (
            <AppCard key={app.id} app={app} busy={busy} onInstall={handleInstall} onUninstall={handleUninstall} />
          ))}
        </div>
      )}

      {/* Contribute CTA */}
      <Card title="Eigene Module">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <p style={{ fontSize: '14px', color: 'var(--text-hi)' }}>
              Modelle für deinen Anwendungsfall ergänzen
            </p>
            <p className="mt-1" style={{ fontSize: '13px', color: 'var(--text-lo)' }}>
              Eigene Module können Objekttypen, Aktionen und Ansichten ergänzen. Einrichtung und Prüfung erfolgen gemeinsam mit der Entwicklung.
            </p>
            <details className="mt-3 break-words text-xs leading-5 text-[color:var(--text-lo)]"><summary className="cursor-pointer">Hinweise für die Entwicklung</summary><p className="mt-2">Ein Katalogeintrag besteht aus <code>module.yaml</code> und <code>app.json</code> unter <code className="break-all">examples/modules/dein-app-name/</code>. Die Moduldatei beschreibt Anforderungen, Fähigkeiten und Beiträge.</p></details>
          </div>
          <a
            href="https://github.com/koiforge/koiforge"
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 inline-flex items-center gap-2 rounded px-4 py-2 font-semibold transition"
            style={{ fontSize: '13px', background: '#4F79E7', color: '#ffffff' }}
          >
            <ExternalLink size={14} />
            Repository öffnen
          </a>
        </div>
      </Card>
    </>
  );
}
