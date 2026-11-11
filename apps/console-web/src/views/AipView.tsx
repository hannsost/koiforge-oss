import { useEffect, useState, type FormEvent } from "react";
import {
  fetchAipConfig,
  fetchAipSessions,
  fetchDatasets,
  fetchDatasetPreview,
  deleteAipSession,
  sendAipMessage,
  type AipProviderConfig,
  type AipMessage,
  type ChatSession,
  type DatasetRecord,
} from "../api";
import { ChatTranscript } from "../components/AssistantUi";
import { UiIcon } from "../components/ProductIdentity";
import "../agent-workspace.css";
export function AipView() {
  const [config, setConfig] = useState<AipProviderConfig | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [id, setId] = useState<string>();
  const [messages, setMessages] = useState<AipMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [datasets, setDatasets] = useState<DatasetRecord[]>([]);
  const [contextId, setContextId] = useState("");
  const load = async () => {
    try {
      const [c, s, ds] = await Promise.all([
        fetchAipConfig(),
        fetchAipSessions(),
        fetchDatasets(),
      ]);
      setConfig(c);
      setSessions(s);
      setDatasets(ds);
      setLoaded(true);
      setError("");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Chat konnte nicht geladen werden.",
      );
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const fresh = () => {
    setId(undefined);
    setMessages([]);
    setError("");
    setContextId("");
  };
  const send = async (event: FormEvent) => {
    event.preventDefault();
    const message = draft.trim();
    if (!message || busy || !config) return;
    setBusy(true);
    setError("");
    try {
      const preview = contextId
        ? await fetchDatasetPreview(contextId, { limit: 50 })
        : null;
      const response = await sendAipMessage({
        message,
        sessionId: id,
        context: preview
          ? {
              datasetName: datasets.find((d) => d.id === contextId)?.name,
              datasetRows: preview.rows as Record<string, unknown>[],
            }
          : undefined,
      });
      setId(response.sessionId);
      setMessages((current) => [
        ...current,
        { role: "user", content: message },
        response.message,
      ]);
      setDraft("");
      try {
        setSessions(await fetchAipSessions());
      } catch {
        setError(
          "Antwort erhalten. Die Chatliste konnte noch nicht aktualisiert werden.",
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Antwort fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!id || !confirm("Diesen Chat und seinen Verlauf löschen?")) return;
    setBusy(true);
    try {
      await deleteAipSession(id);
      setSessions((current) => current.filter((s) => s.id !== id));
      fresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Löschen fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="nf-agent-page nf-agent-page--chat">
      <h1>KI-Assistent</h1>
      <div className="nf-agent-toolbar">
        <p>Antworten prüfen, Vorschläge bewusst übernehmen.</p>
        <a href="#/agents">
          <UiIcon name="settings" />
          Agenten &amp; KI
        </a>
      </div>
      {!loaded ? (
        <>
          <p role="status">
            {error ? "Chat nicht verfügbar." : "Chat wird geladen…"}
          </p>
          {error && (
            <div role="alert">
              {error}
              <button onClick={() => void load()}>Erneut versuchen</button>
            </div>
          )}
        </>
      ) : !config ? (
        <section className="nf-agent-empty">
          <UiIcon name="spark" />
          <h2>Verbinde zuerst ein KI-Modell</h2>
          <p>Lege Anbieter und Modell für diesen Arbeitsbereich fest.</p>
          <a href="#/agents">Agenten &amp; KI öffnen</a>
        </section>
      ) : (
        <>
          <div className="nf-agent-toolbar">
            <span>
              Modell: <strong>{config.model}</strong>
            </span>
            <button disabled={busy} onClick={fresh}>
              <UiIcon name="plus" />
              Neuer Chat
            </button>
          </div>
          <div className="nf-agent-history">
            <label htmlFor="chat-history">Deine Chats</label>
            <select
              id="chat-history"
              disabled={busy}
              value={id ?? ""}
              onChange={(e) => {
                const s = sessions.find((item) => item.id === e.target.value);
                setId(s?.id);
                setMessages(s?.messages ?? []);
                setError("");
                setContextId("");
              }}
            >
              <option value="">Neuer Chat</option>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
            {id && (
              <button
                disabled={busy}
                onClick={() => void remove()}
                aria-label="Aktuellen Chat löschen"
              >
                <UiIcon name="trash" />
              </button>
            )}
          </div>
          <div className="nf-agent-context">
            <label htmlFor="chat-context">Datenkontext</label>
            <select
              id="chat-context"
              disabled={busy}
              value={contextId}
              onChange={(e) => setContextId(e.target.value)}
            >
              <option value="">Ohne zusätzliche Daten</option>
              {datasets.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <p className="nf-agent-hint">
              {contextId
                ? "Mit dem Senden übermittelst du bis zu 50 Zeilen dieser Quelle an den KI-Dienst. Das ist eine Vorschau, keine vollständige Auswertung."
                : "Nur deine Nachrichten und dieser Chatverlauf werden übermittelt."}
            </p>
          </div>
          <ChatTranscript
            messages={messages
              .filter((m) => m.role !== "system")
              .map((m, i) => ({
                id: String(i),
                role: m.role as "user" | "assistant",
                content: m.content,
              }))}
            busy={busy}
            error={error}
            emptyText="Welche Geschäftsfrage möchtest du klären? Wähle bei Bedarf eine Quelle als Kontext."
          />
          <form className="nf-agent-composer" onSubmit={send}>
            <label htmlFor="chat-message">Nachricht</label>
            <textarea
              id="chat-message"
              rows={2}
              maxLength={16000}
              value={draft}
              disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Stelle eine Frage zu deinen Daten…"
            />
            <div className="nf-agent-toolbar">
              <p className="nf-agent-hint">
                KI kann sich irren. Ergebnisse und Quellen prüfen.
              </p>
              <button
                className="nf-agent-primary"
                disabled={busy || !draft.trim()}
              >
                <UiIcon name="arrow" />
                {busy ? "Antwort wird erstellt…" : "Senden"}
              </button>
            </div>
          </form>
        </>
      )}
    </div>
  );
}
