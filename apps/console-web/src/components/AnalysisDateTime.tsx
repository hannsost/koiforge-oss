import { useState } from 'react';
import { inputCls, selectCls } from './ui';

function localValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function localInstant(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) return null;
  const full = value.length === 16 ? `${value}:00` : value;
  const date = new Date(full);
  // Reject normalized nonexistent clock times and ambiguous daylight-saving times.
  if (Number.isNaN(date.getTime()) || localValue(date) !== full) return null;
  for (const minutes of [30, 60, 90, 120]) {
    if (localValue(new Date(date.getTime() + minutes * 60_000)) === full) return null;
  }
  return date.toISOString();
}

export function AnalysisDateTime({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [mode, setMode] = useState('local');
  const [local, setLocal] = useState(() => Number.isNaN(Date.parse(value)) ? '' : localValue(new Date(value)));
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return <div className="space-y-2">
    <label className="block text-sm font-medium text-[color:var(--text-hi)]">
      <span className="mb-1.5 block">Zeitzone des Stichtags</span>
      <select className={selectCls} value={mode} onChange={event => {
        const next = event.target.value;
        setMode(next);
        if (next === 'local') {
          const date = new Date(value);
          const nextLocal = Number.isNaN(date.getTime()) ? local : localValue(date);
          setLocal(nextLocal);
          onChange(localInstant(nextLocal) ?? '');
        }
      }}>
        <option value="local">Ortszeit · {zone}</option>
        <option value="iso">Zeitpunkt mit eigener Zeitzone eingeben</option>
      </select>
    </label>
    <label className="block text-sm font-medium text-[color:var(--text-hi)]">
      <span className="mb-1.5 block">Stichtag</span>
      {mode === 'local' ? <input className={`${inputCls} min-w-0 max-w-full`} type="datetime-local" step="1" value={local}
        onChange={event => { setLocal(event.target.value); onChange(localInstant(event.target.value) ?? ''); }} />
        : <input className={inputCls} type="text" value={value} onChange={event => onChange(event.target.value)} placeholder="2026-09-23T12:00:00+02:00" aria-label="Stichtag mit explizitem Offset" />}
    </label>
    <p className="text-xs leading-5 text-[color:var(--text-lo)]">
      {mode === 'local' ? value ? `Vergleichszeitpunkt in UTC: ${new Date(value).toLocaleString('de-DE', { timeZone: 'UTC' })}.` : 'Bitte einen eindeutigen Zeitpunkt wählen. Bei einer Zeitumstellung kannst du die Zeitzone ausdrücklich eingeben.'
        : 'Datum und Uhrzeit mit Zeitzone, zum Beispiel +02:00 oder Z für UTC.'}
    </p>
  </div>;
}
