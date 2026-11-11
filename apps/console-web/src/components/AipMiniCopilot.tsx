import { useEffect, useRef, useState, type ReactNode } from 'react';

import { sendAipMessage } from '../api';
import { UiIcon } from './ProductIdentity';
import { ChatTranscript } from './AssistantUi';

export interface CopilotSkillBinding {
  skillId: string;
  label: string;
  contextSummary: string;
  buildPromptContext: () => string;
  parseAssistantMessage?: (content: string) => {
    visibleText: string;
    proposal?: unknown;
    issues: string[];
  };
  renderProposal?: (proposal: unknown) => ReactNode;
  applyProposal?: (proposal: unknown) => Promise<string>;
}

interface AipMiniCopilotProps {
  activePageLabel: string;
  skillBinding?: CopilotSkillBinding | null;
}

interface CopilotTurn {
  role: 'user' | 'assistant';
  content: string;
  proposal?: unknown;
  proposalIssues?: string[];
  applyStatus?: 'idle' | 'applying' | 'applied' | 'failed';
  applyMessage?: string;
}

function getInitialAssistantMessage(skillBinding?: CopilotSkillBinding | null): string {
  if (skillBinding?.skillId === 'pipelines') {
    return 'Ich bin dein KI-Assistent. In der Datenaufbereitung kann ich passende Quelldatasets, Verknüpfungsschlüssel und Transformationsschritte aus dem aktuellen Datenkontext vorschlagen. Du prüfst jeden Vorschlag und bestätigst vor der Anwendung.';
  }

  return 'In dieser Ansicht beantworte ich Fragen zu deinem Datenkontext; ich ändere hier keine Daten.';
}

export function AipMiniCopilot({ activePageLabel, skillBinding }: AipMiniCopilotProps) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState('');
  const epoch = useRef(0);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [turns, setTurns] = useState<CopilotTurn[]>([
    {
      role: 'assistant',
      content: getInitialAssistantMessage(skillBinding),
    },
  ]);
  const endRef = useRef<HTMLDivElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const fitPanel = () => {
      const panel = panelRef.current;
      if (!panel) return;
      const availableHeight = window.innerHeight - panel.getBoundingClientRect().top - 16;
      panel.style.maxHeight = `${Math.max(0, Math.min(620, availableHeight))}px`;
    };
    fitPanel();
    window.addEventListener('resize', fitPanel);
    return () => window.removeEventListener('resize', fitPanel);
  }, [open]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && open) { setOpen(false); toggleRef.current?.focus(); }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);

  useEffect(() => {
    const messages = endRef.current?.parentElement;
    messages?.scrollTo({ top: messages.scrollHeight, behavior: 'instant' });
  }, [turns, open]);

  useEffect(() => {
    epoch.current++; setSending(false); setFailure('');
    setOpen(false);
    setSessionId(null);
    setTurns([{ role: 'assistant', content: getInitialAssistantMessage(skillBinding) }]);
  }, [activePageLabel, skillBinding?.skillId]);

  const submit = async () => {
    const message = input.trim();
    if (!message || sending) return;

    const requestEpoch = epoch.current;
    setFailure('');
    setSending(true);
    setOpen(true);
    setTurns((current) => [...current, { role: 'user', content: message }]);

    try {
      const contextText = [
        `ACTIVE_PAGE: ${activePageLabel}`,
        skillBinding
          ? `ACTIVE_SKILL: ${skillBinding.skillId}\n${skillBinding.buildPromptContext()}`
          : 'ACTIVE_SKILL: none\nNo page skill is available here yet. Answer read-only and do not propose config mutations.',
      ].join('\n\n');

      const response = await sendAipMessage({
        sessionId: sessionId ?? undefined,
        message,
        context: { extra: contextText },
        maxTokens: 1800,
      });

      if (requestEpoch !== epoch.current) return;
      setSessionId(response.sessionId); setInput('');

      const parsed = skillBinding?.parseAssistantMessage
        ? skillBinding.parseAssistantMessage(response.message.content)
        : { visibleText: response.message.content, proposal: undefined, issues: [] };

      setTurns((current) => [
        ...current,
        {
          role: 'assistant',
          content: parsed.visibleText || response.message.content,
          proposal: parsed.proposal,
          proposalIssues: parsed.issues,
          applyStatus: parsed.proposal ? 'idle' : undefined,
        },
      ]);
    } catch (error) {
      if (requestEpoch === epoch.current) {
        setTurns(current => current.slice(0, -1));
        setFailure(error instanceof Error ? error.message : 'Die Anfrage ist fehlgeschlagen.');
      }
    } finally {
      if (requestEpoch === epoch.current) setSending(false);
    }
  };

  const applyProposalAt = async (index: number) => {
    const turn = turns[index];
    if (!turn?.proposal || !skillBinding?.applyProposal || turn.applyStatus === 'applying') return;

    setTurns((current) => current.map((entry, i) => (
      i === index ? { ...entry, applyStatus: 'applying', applyMessage: 'Vorschlag wird übernommen…' } : entry
    )));

    try {
      const summary = await skillBinding.applyProposal(turn.proposal);
      setTurns((current) => current.map((entry, i) => (
        i === index ? { ...entry, applyStatus: 'applied', applyMessage: summary } : entry
      )));
    } catch (error) {
      setTurns((current) => current.map((entry, i) => (
        i === index
          ? {
              ...entry,
              applyStatus: 'failed',
              applyMessage: error instanceof Error ? error.message : 'Der Vorschlag konnte nicht übernommen werden.',
            }
          : entry
      )));
    }
  };

  return (
    <div
      className="kf-copilot"
      onBlurCapture={(event) => {
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
        setOpen(false);
      }}
    >
      {open && (
        <section
          ref={panelRef}
          id="ki-assistant-panel" role="region" aria-label="KI-Assistent"
          className="kf-copilot-panel overflow-hidden"
        >
          <div
            className="flex items-center justify-between gap-3 px-4 py-3"
            style={{ borderBottom: '1px solid rgb(var(--rim))' }}
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <UiIcon name="spark" size={20} />
                <span className="text-[length:var(--nf-text-section)] font-semibold leading-[var(--nf-leading-section)]" style={{ color: 'var(--text-hi)' }}>KI-Assistent</span>
              </div>
              <div className="mt-1">
                <span className="kf-copilot-scope rounded px-1.5 py-0.5 text-[length:var(--nf-text-caption)] font-medium leading-[var(--nf-leading-caption)]" style={{ background: 'rgb(var(--brand-rgb) / 0.12)', color: 'rgb(var(--brand-rgb))' }}>
                  {skillBinding?.label ?? activePageLabel}
                </span>
              </div>
              <div className="kf-copilot-context mt-0.5 truncate text-[length:var(--nf-text-caption)] leading-[var(--nf-leading-caption)]" style={{ color: 'var(--text-lo)' }}>
                {skillBinding?.contextSummary ?? 'Nur Seitenname und Chatverlauf als Kontext'}
              </div>
            </div>

            <button
              type="button"
              className="kf-copilot-close transition hover:bg-brand-muted"
              onClick={() => { setOpen(false); toggleRef.current?.focus(); }}
              style={{ color: 'var(--text-lo)' }}
              aria-label="KI-Assistent schließen"
            >
              <UiIcon name="close" size={20} />
            </button>
          </div>

          <div className="kf-copilot-messages space-y-3 overflow-y-auto px-4 py-3">
            <ChatTranscript messages={turns.map((turn, index) => ({ id: String(index), role: turn.role, content: turn.content }))} busy={sending} error={failure} />
            {turns.map((turn, index) => (
              <div key={`${turn.role}-${index}`}>
                <div>
                  {turn.proposalIssues && turn.proposalIssues.length > 0 && (
                    <div
                      className="mt-2 rounded-xl border px-3 py-2 text-[length:var(--nf-text-caption)] leading-[var(--nf-leading-caption)]"
                      style={{
                        borderColor: 'rgba(245,158,11,0.35)',
                        background: 'rgba(245,158,11,0.08)',
                        color: '#805412',
                      }}
                    >
                      {turn.proposalIssues.join(' ')}
                    </div>
                  )}

                  {turn.proposal !== undefined && skillBinding?.renderProposal && (
                    <div
                      className="mt-2 rounded-xl border p-3"
                      style={{
                        borderColor: 'rgb(var(--brand-rgb) / 0.28)',
                        background: 'rgb(var(--brand-rgb) / 0.06)',
                      }}
                    >
                      {skillBinding.renderProposal(turn.proposal)}
                      <div className="mt-3 flex items-center justify-between gap-2">
                        <button
                          type="button"
                          className="kf-button rounded px-3 py-1.5 transition"
                          style={{
                            background: turn.applyStatus === 'applied'
                              ? 'rgba(34,197,94,0.12)'
                              : 'rgb(var(--brand-rgb))',
                            color: turn.applyStatus === 'applied' ? '#286339' : '#fff',
                            opacity: turn.applyStatus === 'applying' ? 0.6 : 1,
                          }}
                          disabled={turn.applyStatus === 'applying' || turn.applyStatus === 'applied'}
                          onClick={() => void applyProposalAt(index)}
                        >
                          {turn.applyStatus === 'applied'
                            ? 'Übernommen'
                            : turn.applyStatus === 'applying'
                              ? 'Wird übernommen…'
                              : 'Vorschlag übernehmen'}
                        </button>
                        {turn.applyMessage && (
                          <span className="text-[length:var(--nf-text-caption)] leading-[var(--nf-leading-caption)]" style={{ color: 'var(--text-lo)' }}>
                            {turn.applyMessage}
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))}

            <div ref={endRef} />
          </div>

          <div
            className="px-3 py-3"
            style={{ borderTop: '1px solid rgb(var(--rim))' }}
          >
            <div className="flex items-center gap-2">
              <input ref={inputRef} aria-label="Nachricht an den KI-Assistenten"
                className="min-w-0 flex-1 rounded-xl border bg-transparent px-3 py-2 outline-none"
                style={{
                  borderColor: 'rgb(var(--rim))',
                  color: 'var(--text-hi)',
                }}
                value={input}
                disabled={sending}
                maxLength={16000}
                placeholder={skillBinding?.skillId === 'pipelines'
                  ? 'Frage zur Datenaufbereitung…'
                  : 'Frage zu deinen Daten…'}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void submit();
                  }
                }}
              />
              <button
                type="button"
                className="rounded-xl px-3 py-2 transition"
                style={{
                  background: 'rgb(var(--brand-rgb))',
                  color: '#fff',
                  opacity: !input.trim() || sending ? 0.6 : 1,
                }}
                disabled={!input.trim() || sending}
                onClick={() => void submit()}
                aria-label="Nachricht senden"
              >
                <UiIcon name="arrow" size={16} />
              </button>
            </div>
          </div>
        </section>
      )}

      <button
        type="button"
        className="kf-copilot-toggle transition hover:bg-brand-muted"
        style={{ color: 'rgb(var(--brand-rgb))' }}
        onClick={() => setOpen((current) => !current)}
        ref={toggleRef}
        aria-controls="ki-assistant-panel" aria-expanded={open}
        aria-label="KI-Assistent öffnen oder schließen"
      >
        <UiIcon name="spark" size={20} />
        <span>KI-Assistent</span>
      </button>
    </div>
  );
}
