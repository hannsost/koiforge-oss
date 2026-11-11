import { useCallback, useEffect, useRef, useState } from 'react';
import * as XLSX from 'xlsx';

import {
  aiImportFile,
  extractArchive,
  fetchConnectors,
  registerConnectorDataset,
  uploadCsvDataset,
  uploadInlineDataset,
  type AiImportResult,
  type ArchiveExtractedFile,
  type ConnectorDefinition,
  type DatasetRecord,
} from '../api';
import { ActionButton, Badge, ghostBtnCls, inputCls, saveViewBtnCls, selectCls } from './ui';
import { UiIcon } from './ProductIdentity';

interface ImportDialogProps {
  onClose: () => void;
  onImported: (dataset: DatasetRecord) => void;
}

// ── Small helper components ───────────────────────────────────────────────────

function Label(props: { text: string; required?: boolean }) {
  return (
    <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.1em] text-[#4a5e7a]">
      {props.text}{props.required && <span className="ml-1 text-[#ef4444]">*</span>}
    </div>
  );
}

function FieldRow(props: { children: React.ReactNode }) {
  return <div className="space-y-1">{props.children}</div>;
}

function ErrorMsg(props: { msg: string }) {
  return (
    <div className="rounded border border-[rgba(239,68,68,0.30)] bg-[rgba(239,68,68,0.08)] px-3 py-2 text-[12px] text-[#f87171]">
      {props.msg}
    </div>
  );
}

// ── CSV tab ───────────────────────────────────────────────────────────────────

function CsvTab(props: { onImported: (ds: DatasetRecord) => void; initialFile?: File }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [namespace, setNamespace] = useState('uploads');
  const [delimiter, setDelimiter] = useState(',');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<{ headers: string[]; rows: string[][] } | null>(null);

  const parseCsvPreview = useCallback((text: string, delim: string) => {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length === 0) { setPreview(null); return; }
    const split = (line: string) => line.split(delim === '\t' ? '\t' : delim);
    const headers = split(lines[0]!);
    const rows = lines.slice(1, 6).map(split);
    setPreview({ headers, rows });
  }, []);

  const onFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    setError('');
    if (!f) { setPreview(null); return; }
    if (!name) setName(f.name.replace(/\.[^.]+$/, ''));
    const reader = new FileReader();
    reader.onload = (ev) => parseCsvPreview(ev.target?.result as string, delimiter);
    reader.readAsText(f, 'utf-8');
  }, [delimiter, name, parseCsvPreview]);

  const onDelimiterChange = useCallback((d: string) => {
    setDelimiter(d);
    if (file) {
      const reader = new FileReader();
      reader.onload = (ev) => parseCsvPreview(ev.target?.result as string, d);
      reader.readAsText(file, 'utf-8');
    }
  }, [file, parseCsvPreview]);

  useEffect(() => {
    if (!props.initialFile) return;
    const f = props.initialFile;
    setFile(f);
    setName(f.name.replace(/\.[^.]+$/, ''));
    const reader = new FileReader();
    reader.onload = (ev) => parseCsvPreview(ev.target?.result as string, delimiter);
    reader.readAsText(f, 'utf-8');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = useCallback(async () => {
    if (!file) { setError('Bitte eine Datei wählen.'); return; }
    if (!name.trim()) { setError('Name ist erforderlich.'); return; }
    setBusy(true);
    setError('');
    try {
      const ds = await uploadCsvDataset(file, { name: name.trim(), namespace, delimiter });
      props.onImported(ds);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }, [file, name, namespace, delimiter, props]);

  return (
    <div className="space-y-4">
      {/* Drop zone */}
      <div
        className="flex cursor-pointer flex-col items-center justify-center rounded border-2 border-dashed border-rim bg-ink/40 py-8 text-center transition hover:border-brand-border"
        onClick={() => fileRef.current?.click()}
      >
        <div className="text-[28px] text-[#2e415a]">↑</div>
        <div className="mt-1 text-[13px] font-medium text-[#6b82a0]">CSV / TSV wählen oder ablegen</div>
        <div className="mt-0.5 text-[11px] text-[#2e415a]">max. 50 MB</div>
        {file && <div className="mt-2"><Badge tone="success">{file.name}</Badge></div>}
      </div>
      <input ref={fileRef} type="file" accept=".csv,.tsv,.txt" className="hidden" onChange={onFileChange} />

      <div className="grid gap-3 md:grid-cols-3">
        <FieldRow>
          <Label text="Dataset-Name" required />
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="mein_dataset" />
        </FieldRow>
        <FieldRow>
          <Label text="Namespace" />
          <input className={inputCls} value={namespace} onChange={(e) => setNamespace(e.target.value)} placeholder="uploads" />
        </FieldRow>
        <FieldRow>
          <Label text="Trennzeichen" />
          <select className={selectCls} value={delimiter} onChange={(e) => onDelimiterChange(e.target.value)}>
            <option value=",">Komma  (,)</option>
            <option value=";">Semikolon  (;)</option>
            <option value="\t">Tab  (\t)</option>
            <option value="|">Pipe  (|)</option>
          </select>
        </FieldRow>
      </div>

      {/* Preview */}
      {preview && (
        <div className="overflow-auto rounded border border-rim">
          <div className="mb-0 px-3 py-2 text-[10px] uppercase tracking-wide text-[#3a4e6a]">
            Vorschau ({preview.headers.length} Spalten)
          </div>
          <table className="min-w-full border-collapse text-[11px]">
            <thead>
              <tr className="border-b border-rim bg-ink/70">
                {preview.headers.map((h) => (
                  <th key={h} className="px-3 py-1.5 text-left text-[10px] uppercase tracking-wide text-[#3a4e6a]">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((row, i) => (
                <tr key={i} className="border-b border-rim/50 last:border-b-0">
                  {row.map((cell, j) => (
                    <td key={j} className="px-3 py-1.5 text-[#8a9fc0]">{cell || <span className="text-[#1e2e45]">—</span>}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {error && <ErrorMsg msg={error} />}

      <div className="flex justify-end">
        <ActionButton onClick={() => void submit()} busy={busy} label="Importieren" busyLabel="Lädt…" />
      </div>
    </div>
  );
}

// ── Excel tab ─────────────────────────────────────────────────────────────────

function ExcelTab(props: { onImported: (ds: DatasetRecord) => void; initialFile?: File }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [sheets, setSheets] = useState<string[]>([]);
  const [activeSheet, setActiveSheet] = useState('');
  const [parsedRows, setParsedRows] = useState<Array<Record<string, string | number | boolean | null>>>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [namespace, setNamespace] = useState('uploads');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const parseSheet = useCallback((wb: XLSX.WorkBook, sheetName: string) => {
    const ws = wb.Sheets[sheetName];
    if (!ws) return;
    const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: null });
    const rows = raw.map((r) =>
      Object.fromEntries(
        Object.entries(r).map(([k, v]) => [
          k,
          typeof v === 'number' || typeof v === 'boolean' ? v : v === null ? null : String(v),
        ]),
      ) as Record<string, string | number | boolean | null>,
    );
    const cols = rows.length > 0 ? Object.keys(rows[0]!) : [];
    setHeaders(cols);
    setParsedRows(rows);
  }, []);

  const onFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    setError('');
    setParsedRows([]);
    setSheets([]);
    if (!f) return;
    if (!name) setName(f.name.replace(/\.[^.]+$/, ''));
    const reader = new FileReader();
    reader.onload = (ev) => {
      const data = new Uint8Array(ev.target?.result as ArrayBuffer);
      const wb = XLSX.read(data, { type: 'array' });
      setSheets(wb.SheetNames);
      const first = wb.SheetNames[0] ?? '';
      setActiveSheet(first);
      parseSheet(wb, first);
      // store workbook ref via closure — re-parse on sheet switch
      (fileRef.current as unknown as { _wb: XLSX.WorkBook })._wb = wb;
    };
    reader.readAsArrayBuffer(f);
  }, [name, parseSheet]);

  const onSheetChange = useCallback((sheetName: string) => {
    setActiveSheet(sheetName);
    const wb = (fileRef.current as unknown as { _wb?: XLSX.WorkBook })._wb;
    if (wb) parseSheet(wb, sheetName);
  }, [parseSheet]);

  useEffect(() => {
    if (!props.initialFile) return;
    const f = props.initialFile;
    setFile(f);
    setName(f.name.replace(/\.[^.]+$/, ''));
    const reader = new FileReader();
    reader.onload = (ev) => {
      const data = new Uint8Array(ev.target?.result as ArrayBuffer);
      const wb = XLSX.read(data, { type: 'array' });
      setSheets(wb.SheetNames);
      const first = wb.SheetNames[0] ?? '';
      setActiveSheet(first);
      parseSheet(wb, first);
      (fileRef.current as unknown as { _wb: XLSX.WorkBook })._wb = wb;
    };
    reader.readAsArrayBuffer(f);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = useCallback(async () => {
    if (!parsedRows.length) { setError('Keine Daten geladen.'); return; }
    if (!name.trim()) { setError('Name ist erforderlich.'); return; }
    setBusy(true);
    setError('');
    try {
      const ds = await uploadInlineDataset(parsedRows, { name: name.trim(), namespace });
      props.onImported(ds);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }, [parsedRows, name, namespace, props]);

  return (
    <div className="space-y-4">
      <div
        className="flex cursor-pointer flex-col items-center justify-center rounded border-2 border-dashed border-rim bg-ink/40 py-8 text-center transition hover:border-brand-border"
        onClick={() => fileRef.current?.click()}
      >
        <div className="text-[28px] text-[#2e415a]">↑</div>
        <div className="mt-1 text-[13px] font-medium text-[#6b82a0]">Excel-Datei wählen (.xlsx, .xls)</div>
        <div className="mt-0.5 text-[11px] text-[#2e415a]">Wird im Browser geparst — keine Datei wird gespeichert</div>
        {file && <div className="mt-2"><Badge tone="success">{file.name}</Badge></div>}
      </div>
      <input ref={fileRef} type="file" accept=".xlsx,.xls,.ods" className="hidden" onChange={onFileChange} />

      {sheets.length > 1 && (
        <FieldRow>
          <Label text="Tabellenblatt" />
          <select className={selectCls} value={activeSheet} onChange={(e) => onSheetChange(e.target.value)}>
            {sheets.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </FieldRow>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <FieldRow>
          <Label text="Dataset-Name" required />
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="mein_excel" />
        </FieldRow>
        <FieldRow>
          <Label text="Namespace" />
          <input className={inputCls} value={namespace} onChange={(e) => setNamespace(e.target.value)} placeholder="uploads" />
        </FieldRow>
      </div>

      {parsedRows.length > 0 && (
        <div className="overflow-auto rounded border border-rim">
          <div className="px-3 py-2 text-[10px] uppercase tracking-wide text-[#3a4e6a]">
            Vorschau — {parsedRows.length.toLocaleString('de-DE')} Zeilen · {headers.length} Spalten
          </div>
          <table className="min-w-full border-collapse text-[11px]">
            <thead>
              <tr className="border-b border-rim bg-ink/70">
                {headers.map((h) => <th key={h} className="px-3 py-1.5 text-left text-[10px] uppercase tracking-wide text-[#3a4e6a]">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {parsedRows.slice(0, 5).map((row, i) => (
                <tr key={i} className="border-b border-rim/50 last:border-b-0">
                  {headers.map((h) => (
                    <td key={h} className="px-3 py-1.5 text-[#8a9fc0]">
                      {row[h] === null ? <span className="text-[#1e2e45]">null</span> : String(row[h])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {error && <ErrorMsg msg={error} />}

      <div className="flex justify-end">
        <ActionButton onClick={() => void submit()} busy={busy} label="Importieren" busyLabel="Lädt…" />
      </div>
    </div>
  );
}

// ── JSON tab ──────────────────────────────────────────────────────────────────

function JsonTab(props: { onImported: (ds: DatasetRecord) => void; initialFile?: File }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<Array<Record<string, string | number | boolean | null>>>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [namespace, setNamespace] = useState('uploads');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const parseJson = useCallback((text: string) => {
    try {
      const parsed = JSON.parse(text);
      let arr: unknown[] = [];
      if (Array.isArray(parsed)) {
        arr = parsed;
      } else if (parsed && typeof parsed === 'object') {
        // Try to find the first array value in the root object
        const found = Object.values(parsed as Record<string, unknown>).find(Array.isArray);
        arr = (found as unknown[]) ?? [parsed];
      }
      const normalized = arr.map((item) => {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          return Object.fromEntries(
            Object.entries(item as Record<string, unknown>).map(([k, v]) => [
              k,
              v === null ? null : typeof v === 'object' ? JSON.stringify(v) : (v as string | number | boolean),
            ])
          ) as Record<string, string | number | boolean | null>;
        }
        return { value: String(item) };
      });
      const cols = normalized.length > 0 ? Object.keys(normalized[0]!) : [];
      setRows(normalized);
      setHeaders(cols);
      setError('');
    } catch (e) {
      setError(`JSON Parse-Fehler: ${e instanceof Error ? e.message : String(e)}`);
      setRows([]);
      setHeaders([]);
    }
  }, []);

  const onFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    setRows([]);
    setHeaders([]);
    setError('');
    if (!f) return;
    if (!name) setName(f.name.replace(/\.[^.]+$/, ''));
    const reader = new FileReader();
    reader.onload = (ev) => parseJson(ev.target?.result as string);
    reader.readAsText(f, 'utf-8');
  }, [name, parseJson]);

  useEffect(() => {
    if (!props.initialFile) return;
    const f = props.initialFile;
    setFile(f);
    setName(f.name.replace(/\.[^.]+$/, ''));
    const reader = new FileReader();
    reader.onload = (ev) => parseJson(ev.target?.result as string);
    reader.readAsText(f, 'utf-8');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = useCallback(async () => {
    if (!rows.length) { setError('Keine Daten geladen.'); return; }
    if (!name.trim()) { setError('Name ist erforderlich.'); return; }
    setBusy(true);
    setError('');
    try {
      const ds = await uploadInlineDataset(rows, { name: name.trim(), namespace });
      props.onImported(ds);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }, [rows, name, namespace, props]);

  return (
    <div className="space-y-4">
      <div
        className="flex cursor-pointer flex-col items-center justify-center rounded border-2 border-dashed border-rim bg-ink/40 py-8 text-center transition hover:border-brand-border"
        onClick={() => fileRef.current?.click()}
      >
        <div className="text-[28px] text-[#2e415a]">↑</div>
        <div className="mt-1 text-[13px] font-medium text-[#6b82a0]">JSON-Datei wählen (.json)</div>
        <div className="mt-0.5 text-[11px] text-[#2e415a]">Array of objects oder {'{'} key: [...] {'}'}</div>
        {file && <div className="mt-2"><Badge tone="success">{file.name}</Badge></div>}
      </div>
      <input ref={fileRef} type="file" accept=".json" className="hidden" onChange={onFileChange} />

      <div className="grid gap-3 md:grid-cols-2">
        <FieldRow>
          <Label text="Dataset-Name" required />
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="mein_dataset" />
        </FieldRow>
        <FieldRow>
          <Label text="Namespace" />
          <input className={inputCls} value={namespace} onChange={(e) => setNamespace(e.target.value)} placeholder="uploads" />
        </FieldRow>
      </div>

      {rows.length > 0 && (
        <div className="overflow-auto rounded border border-rim">
          <div className="px-3 py-2 text-[10px] uppercase tracking-wide text-[#3a4e6a]">
            Vorschau — {rows.length.toLocaleString('de-DE')} Zeilen · {headers.length} Spalten
          </div>
          <table className="min-w-full border-collapse text-[11px]">
            <thead>
              <tr className="border-b border-rim bg-ink/70">
                {headers.map((h) => <th key={h} className="px-3 py-1.5 text-left text-[10px] uppercase tracking-wide text-[#3a4e6a]">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 5).map((row, i) => (
                <tr key={i} className="border-b border-rim/50 last:border-b-0">
                  {headers.map((h) => (
                    <td key={h} className="px-3 py-1.5 text-[#8a9fc0]">
                      {row[h] === null ? <span className="text-[#1e2e45]">null</span> : String(row[h])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {error && <ErrorMsg msg={error} />}
      <div className="flex justify-end">
        <ActionButton onClick={() => void submit()} busy={busy} label="Importieren" busyLabel="Lädt…" />
      </div>
    </div>
  );
}

// ── XML tab ───────────────────────────────────────────────────────────────────

function XmlTab(props: { onImported: (ds: DatasetRecord) => void; initialFile?: File }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<Array<Record<string, string | number | boolean | null>>>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [namespace, setNamespace] = useState('uploads');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const parseXml = useCallback((text: string) => {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(text, 'application/xml');
      const parseError = doc.querySelector('parsererror');
      if (parseError) { setError(`XML Parse-Fehler: ${parseError.textContent ?? 'Unbekannt'}`); return; }

      // Find the most repeated element — treat each as a row
      const root = doc.documentElement;
      const childTagCounts = new Map<string, number>();
      for (const child of Array.from(root.children)) {
        childTagCounts.set(child.tagName, (childTagCounts.get(child.tagName) ?? 0) + 1);
      }
      const rowTag = [...childTagCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      const elements = rowTag ? Array.from(root.getElementsByTagName(rowTag)) : [root];

      const normalized = elements.map((el) => {
        const row: Record<string, string | number | boolean | null> = {};
        // Attributes
        for (const attr of Array.from(el.attributes)) {
          row[attr.name] = attr.value;
        }
        // Child text elements
        for (const child of Array.from(el.children)) {
          const val = child.textContent?.trim() ?? '';
          const num = Number(val);
          row[child.tagName] = val === '' ? null : !isNaN(num) && val !== '' ? num : val;
        }
        return row;
      });

      const cols = normalized.length > 0 ? [...new Set(normalized.flatMap(Object.keys))] : [];
      setRows(normalized);
      setHeaders(cols);
      setError('');
    } catch (e) {
      setError(`Fehler: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  const onFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    setRows([]);
    setHeaders([]);
    setError('');
    if (!f) return;
    if (!name) setName(f.name.replace(/\.[^.]+$/, ''));
    const reader = new FileReader();
    reader.onload = (ev) => parseXml(ev.target?.result as string);
    reader.readAsText(f, 'utf-8');
  }, [name, parseXml]);

  useEffect(() => {
    if (!props.initialFile) return;
    const f = props.initialFile;
    setFile(f);
    setName(f.name.replace(/\.[^.]+$/, ''));
    const reader = new FileReader();
    reader.onload = (ev) => parseXml(ev.target?.result as string);
    reader.readAsText(f, 'utf-8');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = useCallback(async () => {
    if (!rows.length) { setError('Keine Daten geladen.'); return; }
    if (!name.trim()) { setError('Name ist erforderlich.'); return; }
    setBusy(true);
    setError('');
    try {
      const ds = await uploadInlineDataset(rows, { name: name.trim(), namespace });
      props.onImported(ds);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }, [rows, name, namespace, props]);

  return (
    <div className="space-y-4">
      <div
        className="flex cursor-pointer flex-col items-center justify-center rounded border-2 border-dashed border-rim bg-ink/40 py-8 text-center transition hover:border-brand-border"
        onClick={() => fileRef.current?.click()}
      >
        <div className="text-[28px] text-[#2e415a]">↑</div>
        <div className="mt-1 text-[13px] font-medium text-[#6b82a0]">XML-Datei wählen (.xml)</div>
        <div className="mt-0.5 text-[11px] text-[#2e415a]">Wiederkehrende Elemente werden als Zeilen erkannt</div>
        {file && <div className="mt-2"><Badge tone="success">{file.name}</Badge></div>}
      </div>
      <input ref={fileRef} type="file" accept=".xml" className="hidden" onChange={onFileChange} />

      <div className="grid gap-3 md:grid-cols-2">
        <FieldRow>
          <Label text="Dataset-Name" required />
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="mein_dataset" />
        </FieldRow>
        <FieldRow>
          <Label text="Namespace" />
          <input className={inputCls} value={namespace} onChange={(e) => setNamespace(e.target.value)} placeholder="uploads" />
        </FieldRow>
      </div>

      {rows.length > 0 && (
        <div className="overflow-auto rounded border border-rim">
          <div className="px-3 py-2 text-[10px] uppercase tracking-wide text-[#3a4e6a]">
            Vorschau — {rows.length.toLocaleString('de-DE')} Elemente · {headers.length} Felder
          </div>
          <table className="min-w-full border-collapse text-[11px]">
            <thead>
              <tr className="border-b border-rim bg-ink/70">
                {headers.map((h) => <th key={h} className="px-3 py-1.5 text-left text-[10px] uppercase tracking-wide text-[#3a4e6a]">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 5).map((row, i) => (
                <tr key={i} className="border-b border-rim/50 last:border-b-0">
                  {headers.map((h) => (
                    <td key={h} className="px-3 py-1.5 text-[#8a9fc0]">
                      {row[h] === null ? <span className="text-[#1e2e45]">—</span> : String(row[h])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {error && <ErrorMsg msg={error} />}
      <div className="flex justify-end">
        <ActionButton onClick={() => void submit()} busy={busy} label="Importieren" busyLabel="Lädt…" />
      </div>
    </div>
  );
}

// ── Database tab ──────────────────────────────────────────────────────────────

function DatabaseTab(props: { onImported: (ds: DatasetRecord) => void }) {
  const [connectors, setConnectors] = useState<ConnectorDefinition[]>([]);
  const [selectedConnectorId, setSelectedConnectorId] = useState('');
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [name, setName] = useState('');
  const [namespace, setNamespace] = useState('');
  const [mode, setMode] = useState<'virtual' | 'materialized'>('virtual');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);

  const loadConnectors = useCallback(async () => {
    if (loaded) return;
    setLoaded(true);
    try {
      const all = await fetchConnectors();
      // exclude file-only connectors from the DB tab
      const dbLike = all.filter((c) => c.category === 'database' || c.category === 'object-storage' || c.category === 'stream');
      setConnectors(dbLike);
      if (dbLike[0]) setSelectedConnectorId(dbLike[0].id);
    } catch {
      // silent
    }
  }, [loaded]);

  // Load connectors on first render
  useState(() => { void loadConnectors(); });

  const selectedConnector = connectors.find((c) => c.id === selectedConnectorId);

  const setField = useCallback((key: string, value: string) => {
    setFieldValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const submit = useCallback(async () => {
    if (!name.trim()) { setError('Name ist erforderlich.'); return; }
    if (!selectedConnectorId) { setError('Connector wählen.'); return; }

    const source: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fieldValues)) {
      if (v.trim()) source[k] = v.trim();
    }

    setBusy(true);
    setError('');
    try {
      const ds = await registerConnectorDataset({
        name: name.trim(),
        namespace: namespace.trim() || selectedConnectorId,
        connectorId: selectedConnectorId,
        mode,
        source,
      });
      props.onImported(ds);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registrierung fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }, [name, namespace, selectedConnectorId, fieldValues, mode, props]);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2">
        <FieldRow>
          <Label text="Connector" required />
          <select
            className={selectCls}
            value={selectedConnectorId}
            onChange={(e) => { setSelectedConnectorId(e.target.value); setFieldValues({}); }}
          >
            {connectors.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </FieldRow>
        <FieldRow>
          <Label text="Modus" />
          <select className={selectCls} value={mode} onChange={(e) => setMode(e.target.value as 'virtual' | 'materialized')}>
            <option value="virtual">Virtual (Schema-only)</option>
            <option value="materialized">Materialized (Snapshot)</option>
          </select>
        </FieldRow>
      </div>

      {/* Dynamic config fields */}
      {selectedConnector && (
        <div className="rounded border border-rim bg-ink/40 p-3">
          <div className="mb-3 text-[10px] uppercase tracking-wide text-[#3a4e6a]">
            {selectedConnector.name} · Verbindungsparameter
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {selectedConnector.configFields
              .filter((f) => f.key !== 'columns') // columns managed separately
              .map((field) => (
                <FieldRow key={field.key}>
                  <Label text={field.label} required={field.required} />
                  <input
                    className={inputCls}
                    placeholder={field.required ? 'Erforderlich' : 'Optional'}
                    value={fieldValues[field.key] ?? ''}
                    onChange={(e) => setField(field.key, e.target.value)}
                  />
                </FieldRow>
              ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {selectedConnector.capabilities.map((cap) => <Badge key={cap}>{cap}</Badge>)}
          </div>
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <FieldRow>
          <Label text="Dataset-Name" required />
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="mein_dataset" />
        </FieldRow>
        <FieldRow>
          <Label text="Namespace" />
          <input className={inputCls} value={namespace} onChange={(e) => setNamespace(e.target.value)} placeholder={selectedConnectorId || 'database'} />
        </FieldRow>
      </div>

      <div className="rounded border border-rim/50 bg-brand-muted px-3 py-2 text-[11px] text-[#6b82a0]">
        Hinweis: KOIForge stellt aktuell keine Live-Verbindung her — das Dataset wird als Schema-Registrierung angelegt. Echtverbindungen folgen in Phase 3 (SQLite → externe DB-Adapter).
      </div>

      {error && <ErrorMsg msg={error} />}

      <div className="flex justify-end">
        <ActionButton onClick={() => void submit()} busy={busy} label="Registrieren" busyLabel="Registriert…" />
      </div>
    </div>
  );
}

// ── Smart detection helpers ───────────────────────────────────────────────────

type Phase = 'drop' | 'detecting' | 'extracting' | 'archive' | 'ai-importing' | 'ai-result' | 'csv' | 'excel' | 'json' | 'xml' | 'database';
type KnownType = Exclude<Phase, 'drop' | 'detecting' | 'extracting' | 'archive' | 'ai-importing' | 'ai-result'>;

const ARCHIVE_EXTS = new Set(['zip', '7z', 'tar', 'gz', 'bz2', 'xz', 'rar', 'tgz', 'tar.gz', 'tar.bz2']);

function detectByExtension(fileName: string): KnownType | 'archive' | null {
  const lower = fileName.toLowerCase();
  // Multi-part extensions first
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tar.bz2') || lower.endsWith('.tar.xz')) return 'archive';
  const ext = lower.split('.').pop() ?? '';
  if (ARCHIVE_EXTS.has(ext)) return 'archive';
  if (['csv', 'tsv', 'txt'].includes(ext)) return 'csv';
  if (['xlsx', 'xls', 'ods'].includes(ext)) return 'excel';
  if (ext === 'json') return 'json';
  if (ext === 'xml') return 'xml';
  return null;
}

function base64ToFile(b64: string, name: string): File {
  const byteChars = atob(b64);
  const bytes = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
  return new File([bytes], name);
}

const TAB_LABELS: Record<KnownType, string> = {
  csv: 'CSV / TSV',
  excel: 'Excel',
  json: 'JSON',
  xml: 'XML',
  database: 'Datenbank',
};
const KNOWN_TYPES: KnownType[] = ['csv', 'excel', 'json', 'xml', 'database'];

// ── Main dialog ───────────────────────────────────────────────────────────────

export function ImportDialog(props: ImportDialogProps) {
  const [phase, setPhase] = useState<Phase>('drop');
  const [droppedFile, setDroppedFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [detectError, setDetectError] = useState('');
  const [archiveFiles, setArchiveFiles] = useState<ArchiveExtractedFile[]>([]);
  const [aiResult, setAiResult] = useState<(AiImportResult & { impossible: false }) | null>(null);
  const [aiImportName, setAiImportName] = useState('');
  const [aiImportNamespace, setAiImportNamespace] = useState('uploads');
  const [aiSaving, setAiSaving] = useState(false);
  const dropInputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    setDroppedFile(file);
    setDetectError('');

    const detected = detectByExtension(file.name);

    // Archive → extract server-side
    if (detected === 'archive') {
      setPhase('extracting');
      try {
        const { files } = await extractArchive(file);
        setArchiveFiles(files);
        // If only one file and its type is known, jump directly to the import tab
        if (files.length === 1 && files[0]) {
          const single = files[0];
          const singleType = detectByExtension(single.name);
          if (singleType && singleType !== 'archive' && single.contentBase64) {
            const blob = base64ToFile(single.contentBase64, single.name);
            setDroppedFile(blob);
            setPhase(singleType);
            return;
          }
        }
        setPhase('archive');
      } catch (err) {
        setDetectError(err instanceof Error ? err.message : 'Extraktion fehlgeschlagen.');
        setPhase('drop');
      }
      return;
    }

    // Known data format → straight to tab
    if (detected) {
      setPhase(detected);
      return;
    }

    // Unknown extension → let AI inspect, plan, and parse
    setPhase('ai-importing');
    try {
      const result = await aiImportFile(file);
      if (result.impossible) {
        setDetectError(result.reason);
        setPhase('drop');
        return;
      }
      setAiResult(result);
      setAiImportName(file.name.replace(/\.[^.]+$/, ''));
      setPhase('ai-result');
    } catch (err) {
      setDetectError(err instanceof Error ? err.message : 'AI-Import fehlgeschlagen.');
      setPhase('drop');
    }
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) void handleFile(file);
  }, [handleFile]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const switchTab = useCallback((id: KnownType) => {
    setDroppedFile(null);
    setDetectError('');
    setPhase(id);
  }, []);

  const isKnown = !['drop', 'detecting', 'extracting', 'archive', 'ai-importing', 'ai-result'].includes(phase);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/80 backdrop-blur-sm">
      <div className="w-full max-w-2xl rounded border border-rim bg-panel shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-rim px-5 py-4">
          <div>
            <div className="text-[15px] font-semibold text-white">Daten importieren</div>
            <div className="text-[11px] text-[#3a4e6a]">
              {phase === 'archive' ? 'Archiv entpackt · Datei zum Importieren wählen'
                : phase === 'ai-result' ? 'KI hat Daten extrahiert · Namen vergeben und speichern'
                : isKnown ? 'Format erkannt · Typ oben ändern falls nötig'
                : 'Datei ablegen — KI versucht jedes Format zu importieren'}
            </div>
          </div>
          <button className={ghostBtnCls} onClick={props.onClose} type="button"><UiIcon name="close" size={16} /> Schließen</button>
        </div>

        {/* Smart drop zone */}
        {phase === 'drop' && (
          <div className="p-5">
            <div
              className={`flex cursor-pointer flex-col items-center justify-center rounded border-2 border-dashed py-16 text-center transition ${
                dragOver ? 'border-[#3b82f6] bg-[rgba(59,130,246,0.05)]' : 'border-rim bg-ink/40 hover:border-brand-border'
              }`}
              onDrop={onDrop}
              onDragOver={onDragOver}
              onDragLeave={() => setDragOver(false)}
              onClick={() => dropInputRef.current?.click()}
            >
              <div className="text-[52px] text-[#2e415a]">↑</div>
              <div className="mt-2 text-[15px] font-semibold text-[#6b82a0]">Datei hier ablegen</div>
              <div className="mt-1 text-[12px] text-[#3a4e6a]">oder klicken zum Auswählen</div>
              <div className="mt-4 flex flex-wrap justify-center gap-1.5">
                {['CSV', 'TSV', 'Excel', 'JSON', 'XML'].map((f) => (
                  <span key={f} className="rounded bg-ink/60 px-2 py-0.5 text-[10px] text-[#4a5e7a]">{f}</span>
                ))}
                <span className="rounded bg-ink/60 px-2 py-0.5 text-[10px] text-[#4a5e7a]">+ beliebige Formate</span>
              </div>
            </div>
            <input
              ref={dropInputRef}
              type="file"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); }}
            />
            <div className="mt-4">
              <div className="mb-2 text-[10px] uppercase tracking-wide text-[#2e415a]">oder Typ manuell wählen</div>
              <div className="flex flex-wrap gap-1.5">
                {KNOWN_TYPES.map((id) => (
                  <button key={id} className={`${ghostBtnCls} px-3 py-1.5 text-[11px]`} onClick={() => switchTab(id)} type="button">
                    {TAB_LABELS[id]}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Detecting spinner (unknown extension → AIP classification) */}
        {phase === 'detecting' && (
          <div className="flex flex-col items-center justify-center py-20">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#3b82f6] border-t-transparent" />
            <div className="mt-4 text-[13px] text-[#6b82a0]">KI erkennt Dateiformat…</div>
            <div className="mt-1 text-[11px] text-[#3a4e6a]">{droppedFile?.name}</div>
          </div>
        )}

        {/* AI Import spinner (unknown format) */}
        {phase === 'ai-importing' && (
          <div className="flex flex-col items-center justify-center py-20">
            <div className="relative h-12 w-12">
              <div className="absolute inset-0 animate-spin rounded-full border-2 border-[#3b82f6] border-t-transparent" style={{ animationDuration: '1s' }} />
              <div className="absolute inset-1.5 animate-spin rounded-full border-2 border-[#6b82a0] border-t-transparent" style={{ animationDuration: '0.7s', animationDirection: 'reverse' }} />
              <div className="absolute inset-3.5 rounded-full bg-[#3b82f6] opacity-20" />
            </div>
            <div className="mt-5 text-[13px] font-medium text-[#6b82a0]">KI analysiert und importiert…</div>
            <div className="mt-1 text-[11px] text-[#3a4e6a]">{droppedFile?.name}</div>
            <div className="mt-3 space-y-1 text-center text-[10px] text-[#2e415a]">
              <div>Inspiziert Dateiinhalt · Plant Parsing-Strategie</div>
              <div>Führt Parsing aus · Validiert Ergebnis</div>
            </div>
          </div>
        )}

        {/* AI Import result */}
        {phase === 'ai-result' && aiResult && (
          <div className="p-5 space-y-4">
            <div className="rounded border border-[rgba(59,130,246,0.3)] bg-[rgba(59,130,246,0.05)] px-3 py-2.5">
              <div className="text-[10px] uppercase tracking-wide text-[#4a5e7a]">KI-Strategie: {aiResult.strategy}</div>
              <div className="mt-1 text-[12px] text-[#6b82a0]">{aiResult.reasoning}</div>
            </div>
            <div className="overflow-auto rounded border border-rim">
              <div className="px-3 py-2 text-[10px] uppercase tracking-wide text-[#3a4e6a]">
                Vorschau — {aiResult.rows.length.toLocaleString('de-DE')} Zeilen · {aiResult.schema.length} Spalten
              </div>
              <table className="min-w-full border-collapse text-[11px]">
                <thead>
                  <tr className="border-b border-rim bg-ink/70">
                    {aiResult.schema.map((col) => (
                      <th key={col.name} className="px-3 py-1.5 text-left text-[10px] uppercase tracking-wide text-[#3a4e6a]">{col.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {aiResult.rows.slice(0, 5).map((row, i) => (
                    <tr key={i} className="border-b border-rim/50 last:border-b-0">
                      {aiResult.schema.map((col) => (
                        <td key={col.name} className="px-3 py-1.5 text-[#8a9fc0]">
                          {row[col.name] === null ? <span className="text-[#1e2e45]">—</span> : String(row[col.name])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <FieldRow>
                <Label text="Dataset-Name" required />
                <input className={inputCls} value={aiImportName} onChange={(e) => setAiImportName(e.target.value)} placeholder="mein_dataset" />
              </FieldRow>
              <FieldRow>
                <Label text="Namespace" />
                <input className={inputCls} value={aiImportNamespace} onChange={(e) => setAiImportNamespace(e.target.value)} placeholder="uploads" />
              </FieldRow>
            </div>
            {detectError && <ErrorMsg msg={detectError} />}
            <div className="flex items-center justify-between">
              <button className={`${ghostBtnCls} text-[11px]`} onClick={() => { setPhase('drop'); setAiResult(null); setDetectError(''); }} type="button">
                ← Andere Datei
              </button>
              <ActionButton
                onClick={() => {
                  if (!aiImportName.trim()) { setDetectError('Name ist erforderlich.'); return; }
                  setAiSaving(true);
                  setDetectError('');
                  void uploadInlineDataset(aiResult.rows, { name: aiImportName.trim(), namespace: aiImportNamespace })
                    .then((ds) => { props.onImported(ds); })
                    .catch((err) => { setDetectError(err instanceof Error ? err.message : 'Speichern fehlgeschlagen.'); })
                    .finally(() => { setAiSaving(false); });
                }}
                busy={aiSaving}
                label="Dataset speichern"
                busyLabel="Speichert…"
              />
            </div>
          </div>
        )}

        {/* Extracting spinner (archive) */}
        {phase === 'extracting' && (
          <div className="flex flex-col items-center justify-center py-20">
            <div className="relative h-10 w-10">
              <div className="absolute inset-0 animate-spin rounded-full border-2 border-[#3b82f6] border-t-transparent" />
              <div className="absolute inset-2 animate-spin rounded-full border-2 border-[#6b82a0] border-b-transparent" style={{ animationDirection: 'reverse', animationDuration: '0.6s' }} />
            </div>
            <div className="mt-5 text-[13px] text-[#6b82a0]">Archiv wird entpackt…</div>
            <div className="mt-1 text-[11px] text-[#3a4e6a]">{droppedFile?.name}</div>
          </div>
        )}

        {/* Archive file picker */}
        {phase === 'archive' && (
          <div className="p-5 space-y-3">
            <div className="text-[11px] uppercase tracking-wide text-[#3a4e6a]">
              {archiveFiles.length} importierbare Datei{archiveFiles.length !== 1 ? 'en' : ''} im Archiv
            </div>
            <div className="space-y-1.5">
              {archiveFiles.map((f) => {
                const fType = detectByExtension(f.name);
                const canImport = fType && fType !== 'archive' && f.contentBase64;
                return (
                  <button
                    key={f.name}
                    disabled={!canImport}
                    className={`flex w-full items-center gap-3 rounded border px-3 py-2.5 text-left text-[12px] transition ${
                      canImport
                        ? 'border-rim bg-ink/40 hover:border-brand-border hover:bg-ink/60 cursor-pointer'
                        : 'border-rim/30 bg-ink/20 text-[#3a4e6a] cursor-not-allowed'
                    }`}
                    onClick={() => {
                      if (!canImport || !f.contentBase64) return;
                      const blob = base64ToFile(f.contentBase64, f.name.split('/').pop()!);
                      setDroppedFile(blob);
                      setPhase(fType as KnownType);
                    }}
                    type="button"
                  >
                    <span className="shrink-0 rounded bg-ink/60 px-1.5 py-0.5 text-[10px] uppercase text-[#4a5e7a]">
                      {f.ext.replace('.', '')}
                    </span>
                    <span className="flex-1 truncate text-[#8a9fc0]">{f.name}</span>
                    <span className="shrink-0 text-[10px] text-[#3a4e6a]">
                      {f.size > 1024 * 1024
                        ? `${(f.size / 1024 / 1024).toFixed(1)} MB`
                        : `${(f.size / 1024).toFixed(0)} KB`}
                    </span>
                    {canImport && <span className="shrink-0 text-[11px] text-[#4a5e7a]">→</span>}
                    {!canImport && <span className="shrink-0 text-[10px] text-[#2e415a]">zu groß</span>}
                  </button>
                );
              })}
            </div>
            <button
              className={`${ghostBtnCls} text-[11px]`}
              onClick={() => { setPhase('drop'); setArchiveFiles([]); }}
              type="button"
            >
              ← Andere Datei wählen
            </button>
          </div>
        )}

        {/* Known-type content */}
        {isKnown && (
          <>
            <div className="flex border-b border-rim">
              {KNOWN_TYPES.map((id) => (
                <button
                  key={id}
                  className={`relative px-5 py-3 text-[12px] font-medium transition ${
                    phase === id ? 'text-white' : 'text-[#4a5e7a] hover:text-[#8a9fc0]'
                  }`}
                  onClick={() => switchTab(id)}
                  type="button"
                >
                  {TAB_LABELS[id]}
                  {phase === id && <span className="absolute inset-x-0 bottom-0 h-[2px] rounded-t bg-brand" />}
                </button>
              ))}
            </div>
            <div className="p-5 space-y-4">
              {detectError && <ErrorMsg msg={detectError} />}
              {phase === 'csv' && <CsvTab onImported={props.onImported} initialFile={droppedFile ?? undefined} />}
              {phase === 'excel' && <ExcelTab onImported={props.onImported} initialFile={droppedFile ?? undefined} />}
              {phase === 'json' && <JsonTab onImported={props.onImported} initialFile={droppedFile ?? undefined} />}
              {phase === 'xml' && <XmlTab onImported={props.onImported} initialFile={droppedFile ?? undefined} />}
              {phase === 'database' && <DatabaseTab onImported={props.onImported} />}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
