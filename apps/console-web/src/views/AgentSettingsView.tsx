import { useEffect, useState, type FormEvent } from "react";
import {
  fetchAipConfiguration,
  saveAipConfig,
  type AipProviderConfig,
  type SessionContext,
} from "../api";
import {
  fetchFreshnessReadiness,
  type FreshnessReadiness,
} from "../freshness-api";
import { AgentSettingsSection } from "../components/AssistantUi";
import { UiIcon } from "../components/ProductIdentity";
import "../agent-workspace.css";
const defaults: AipProviderConfig = {
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  model: "",
  systemPrompt: "",
};

function generationLabel(readiness: FreshnessReadiness): string | null {
  const generation = readiness.generation;
  if (!generation) return null;
  if (generation.backend === "codex") {
    const model = generation.model.toLowerCase().includes("astra")
      ? "Astra"
      : generation.model;
    return `Codex · ${model || "Astra"} · ${generation.reasoningEffort || "xhigh"}`;
  }
  return `API · ${generation.model || "Modell"} · ${generation.reasoningEffort || "Modellstandard"}`;
}

export function AgentSettingsView({ session }: { session: SessionContext }) {
  const [config, setConfig] = useState<AipProviderConfig>(defaults);
  const [revision, setRevision] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [freshnessReadiness, setFreshnessReadiness] =
    useState<FreshnessReadiness | null>(null);
  const [freshnessReadinessError, setFreshnessReadinessError] = useState("");
  const [freshnessReadinessLoading, setFreshnessReadinessLoading] =
    useState(true);
  const [freshnessReadinessAttempt, setFreshnessReadinessAttempt] = useState(0);
  const canManage = session.permissions.includes("modules.manage");
  const load = async () => {
    setError("");
    try {
      const result = await fetchAipConfiguration();
      setConfig(result.config ?? defaults);
      setRevision(result.revision);
      setLoaded(true);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Konfiguration konnte nicht geladen werden.",
      );
    }
  };
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    let active = true;
    setFreshnessReadiness(null);
    setFreshnessReadinessError("");
    setFreshnessReadinessLoading(true);
    fetchFreshnessReadiness()
      .then((result) => {
        if (active) setFreshnessReadiness(result);
      })
      .catch((reason: unknown) => {
        if (active) {
          setFreshnessReadinessError(
            reason instanceof Error
              ? reason.message
              : "Status der lokalen Selbsterweiterung konnte nicht geprüft werden.",
          );
        }
      })
      .finally(() => {
        if (active) setFreshnessReadinessLoading(false);
      });
    return () => {
      active = false;
    };
  }, [freshnessReadinessAttempt]);
  const update = (value: Partial<AipProviderConfig>) => {
    setConfig((c) => ({ ...c, ...value }));
    setSaved(false);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const result = await saveAipConfig({ ...config, revision });
      setConfig(result.config ?? defaults);
      setRevision(result.revision);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Speichern fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="nf-agent-page">
      <h1>Agenten &amp; KI</h1>
      <div className="nf-agent-toolbar">
        <p>Anbieter, Modell und Arbeitsweise für deinen Arbeitsbereich.</p>
        <a href="#/aip">
          <UiIcon name="spark" />
          KI-Assistent öffnen
        </a>
      </div>
      <AgentSettingsSection
        title="Lokale Selbsterweiterung"
        description="Quellenalter- und Import-Erweiterungen können fehlende Fähigkeiten über die lokal installierte Codex-CLI ergänzen; beide nutzen denselben geprüften Adapter. Dieser Status ist unabhängig von der Chat-Konfiguration darunter."
      >
        {freshnessReadinessLoading ? (
          <p className="nf-agent-hint" role="status">
            Status wird geprüft…
          </p>
        ) : freshnessReadinessError ? (
          <div>
            <p className="nf-agent-hint" role="alert">
              {freshnessReadinessError}
            </p>
            <button
              className="nf-agent-primary"
              type="button"
              onClick={() =>
                setFreshnessReadinessAttempt((attempt) => attempt + 1)
              }
            >
              Erneut prüfen
            </button>
          </div>
        ) : freshnessReadiness ? (
          <div>
            {generationLabel(freshnessReadiness) && (
              <p className="nf-agent-hint">
                <strong>Ausführungsweg:</strong> {generationLabel(freshnessReadiness)}.
              </p>
            )}
            {freshnessReadiness.generation?.backend === "codex" ? (
              <p className="nf-agent-hint">
                <strong>Lokale Anmeldung:</strong>{" "}
                {freshnessReadiness.provider === "disabled"
                  ? "Die Erzeugung ist durch den Betreiber deaktiviert."
                  : freshnessReadiness.generation.available
                    ? "Die lokale Anmeldung ist verfügbar; der Modellzugang wird erst beim echten Aufruf geprüft. Ein separater API-Schlüssel ist dafür nicht erforderlich."
                    : freshnessReadiness.generation.reason ??
                      "Die lokale Codex-CLI ist noch nicht verfügbar. Prüfe Installation und Login und starte danach eine neue Prüfung."}
              </p>
            ) : null}
            <p className="nf-agent-hint">
              <strong>Geschützte Ausführung:</strong>{" "}
              {freshnessReadiness.runtime === "ready"
                ? "erfolgreich geprüft."
                : "gerade nicht verfügbar; bitte später erneut prüfen."}
            </p>
            <p className="nf-agent-hint">
              <strong>Status:</strong>{" "}
              {freshnessReadiness.provider === "disabled"
                ? "Die Erzeugung neuer Fähigkeiten ist deaktiviert."
                : freshnessReadiness.capability === "available"
                  ? "Eine geprüfte Fähigkeit ist gespeichert und kann wiederverwendet werden."
                  : "Für die erste Nutzung ist noch keine geprüfte Fähigkeit gespeichert."}
            </p>
            <button
              className="nf-agent-primary"
              type="button"
              onClick={() =>
                setFreshnessReadinessAttempt((attempt) => attempt + 1)
              }
            >
              Erneut prüfen
            </button>
          </div>
        ) : null}
      </AgentSettingsSection>
      {error && (
        <div role="alert">
          {error}
          <button
            type="button"
            onClick={() => {
              if (
                !loaded ||
                confirm("Neu laden und ungespeicherte Änderungen verwerfen?")
              )
                void load();
            }}
          >
            Neu laden
          </button>
        </div>
      )}
      {!loaded ? (
        <p role="status">
          {error
            ? "Konfiguration nicht verfügbar."
            : "Konfiguration wird geladen…"}
        </p>
      ) : (
        <form onSubmit={save} className="nf-agent-form">
          <AgentSettingsSection
            title="Chat-Verbindung & Modell"
            description="Der API-Schlüssel bleibt auf dem Server. Ein leeres Schlüsselfeld behält den vorhandenen Schlüssel für denselben Endpunkt."
          >
            <fieldset disabled={!canManage || busy}>
              <label htmlFor="agent-provider">Anbieter</label>
              <select
                id="agent-provider"
                value={config.provider}
                onChange={(e) =>
                  update({
                    provider: e.target.value as AipProviderConfig["provider"],
                    baseUrl:
                      e.target.value === "openai"
                        ? "https://api.openai.com/v1"
                        : e.target.value === "ollama"
                          ? "http://localhost:11434/v1"
                          : "",
                    apiKey: "",
                    hasKey: false,
                    model: "",
                  })
                }
              >
                <option value="openai">OpenAI</option>
                <option value="ollama">Ollama</option>
                <option value="custom">OpenAI-kompatibler Dienst</option>
                {config.provider === "anthropic" && (
                  <option value="anthropic" disabled>
                    Alte Anthropic-Konfiguration – bitte kompatiblen Dienst
                    wählen
                  </option>
                )}
              </select>
              <label htmlFor="agent-model">Modell</label>
              <input
                id="agent-model"
                required
                maxLength={200}
                value={config.model}
                onChange={(e) => update({ model: e.target.value })}
                placeholder="Modellkennung deines Anbieters"
              />
              <label htmlFor="agent-url">API-Endpunkt</label>
              <input
                id="agent-url"
                type="url"
                required
                value={config.baseUrl}
                onChange={(e) => update({ baseUrl: e.target.value })}
              />
              <p className="nf-agent-hint">
                Eigene Dienste müssen vom Betreiber für diesen Arbeitsbereich
                freigegeben sein.
              </p>
              <label htmlFor="agent-key">
                API-Schlüssel{" "}
                {config.hasKey ? "(hinterlegt)" : "(nicht hinterlegt)"}
              </label>
              <input
                id="agent-key"
                type="password"
                autoComplete="new-password"
                maxLength={4096}
                value={config.apiKey ?? ""}
                onChange={(e) => update({ apiKey: e.target.value })}
                placeholder={
                  config.hasKey
                    ? "Neuen Schlüssel hinterlegen"
                    : "Schlüssel deines Anbieters"
                }
              />
              {config.hasKey && (
                <label className="nf-agent-checkbox">
                  <input
                    type="checkbox"
                    checked={config.clearKey ?? false}
                    onChange={(e) =>
                      update({ clearKey: e.target.checked, apiKey: "" })
                    }
                  />
                  Gespeicherten Schlüssel entfernen
                </label>
              )}
            </fieldset>
          </AgentSettingsSection>
          <AgentSettingsSection
            title="Arbeitsweise"
            description="Vorgaben ergänzen die Produktregeln. Sie erteilen keine neuen Zugriffsrechte."
          >
            <fieldset disabled={!canManage || busy}>
              <label htmlFor="agent-instructions">Anweisungen</label>
              <textarea
                id="agent-instructions"
                rows={5}
                maxLength={8000}
                value={config.systemPrompt ?? ""}
                onChange={(e) => update({ systemPrompt: e.target.value })}
                placeholder="Sprache, Tonalität und fachlicher Schwerpunkt"
              />
              <label htmlFor="agent-reasoning">Denktiefe</label>
              <select
                id="agent-reasoning"
                value={config.reasoningEffort ?? ""}
                onChange={(e) =>
                  update({
                    reasoningEffort: (e.target.value ||
                      undefined) as AipProviderConfig["reasoningEffort"],
                  })
                }
              >
                <option value="">Modellstandard</option>
                <option value="low">Niedrig</option>
                <option value="medium">Mittel</option>
                <option value="high">Hoch</option>
                <option value="xhigh">Sehr hoch</option>
              </select>
              <p className="nf-agent-hint">
                Wird nur an unterstützte Reasoning-Modelle übermittelt.
              </p>
            </fieldset>
          </AgentSettingsSection>
          <AgentSettingsSection
            title="Daten & Aktionen"
            description="Im Chat wird nur der von dir ausgewählte Kontext an den eingerichteten Dienst übermittelt. Vorschläge verändern deine Daten nicht automatisch."
          >
            <p>
              Chats werden für deinen Zugang gespeichert. Werkzeuge mit
              Schreibzugriff brauchen weiterhin ihre eigene Freigabe.
            </p>
          </AgentSettingsSection>
          {saved && <p role="status">Konfiguration gespeichert.</p>}
          {canManage ? (
            <button
              className="nf-agent-primary"
              disabled={busy || !config.model.trim()}
            >
              {busy ? "Speichern…" : "Konfiguration speichern"}
            </button>
          ) : (
            <p>Die Konfiguration verwaltet der Inhaber des Arbeitsbereichs.</p>
          )}
        </form>
      )}
    </div>
  );
}
