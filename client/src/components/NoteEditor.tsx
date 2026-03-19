import React, { useMemo } from 'react';
import { Save, FileDown, Mail, Loader2 } from 'lucide-react';
import type { HaloNote, NoteField } from '../../../shared/types';
import { AppStatus } from '../../../shared/types';

const META_KEYS = new Set(['noteId', 'id', 'title', 'name', 'template_id', 'templateId', 'lastSavedAt', 'sections', 'fields', 'notes', 'data']);

/** Humanize snake_case key to Title Case (e.g. patient_name → Patient name). */
function humanizeLabel(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/** One row for display: key (for saving), label (humanized), body (value). */
type ReadableField = { key: string; label: string; body: string };

/** Turn raw HALO response (object, array, or JSON string) into list of { key, label, body } for display. */
function rawToReadableFields(raw: unknown): ReadableField[] {
  if (raw == null) return [];
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return [];
    }
  }
  if (typeof parsed !== 'object' || parsed == null) return [];
  if (Array.isArray(parsed) && parsed.length > 0) {
    const first = parsed[0] as Record<string, unknown> | undefined;
    if (first && typeof first === 'object' && ('key' in first || 'label' in first)) {
      return (parsed as Array<Record<string, unknown>>).map((f) => {
        const key = String(f.label ?? f.name ?? f.key ?? '');
        const body = String(f.value ?? f.body ?? f.content ?? f.text ?? '').replace(/\\n/g, '\n');
        return { key, label: humanizeLabel(key), body };
      }).filter((f) => f.key.length > 0);
    }
  }
  const obj = parsed as Record<string, unknown>;
  if (Array.isArray(obj)) return [];
  // If this is the common HALO shape with a single "note" (and maybe date_today), caller will use plain-text display instead
  if (Object.keys(obj).length <= 2 && (obj.note != null || obj.content != null)) return [];
  return Object.entries(obj)
    .filter(([k]) => !META_KEYS.has(k) && !k.startsWith('_'))
    .map(([key, value]) => ({
      key,
      label: humanizeLabel(key),
      body: (value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value)).replace(/\\n/g, '\n'),
    }))
    .filter((f) => f.body !== '' || f.key !== '');
}

/** Turn structured fields into a single open-text note (decoded template output). */
function fieldsToContent(fields: NoteField[]): string {
  return fields
    .map((f) => (f.label ? `${f.label}:\n${f.body ?? ''}` : f.body))
    .filter(Boolean)
    .join('\n\n');
}

/** Remove curly braces, brackets, and quotes so they are never shown in the note. Use at display time. */
function stripBracesAndQuotesDisplay(s: string): string {
  return (s ?? '').replace(/[{}""'\[\]`]/g, '');
}

/**
 * Convert content to plain text: respect literal \n as real newlines, and if content is
 * JSON like {"note":"...","date_today":"..."}, extract the note text with no braces or quotes.
 * Uses regex when JSON.parse fails (e.g. newlines inside the string value).
 */
function contentToPlainText(content: string | undefined): string {
  let raw = (content ?? '').trim();
  if (!raw) return '';

  const stripPunctuation = (s: string) => stripBracesAndQuotesDisplay(s);

  // If content is array-wrapped JSON e.g. [{"note":"..."}], unwrap to the first object
  if (raw.startsWith('[')) {
    try {
      const arr = JSON.parse(raw) as unknown[];
      const first = arr?.[0];
      if (first != null && typeof first === 'object') raw = JSON.stringify(first);
      else if (typeof first === 'string') raw = first;
    } catch {
      // fall through and strip brackets from raw
    }
  }

  if ((raw.startsWith('{') || raw.startsWith('[')) && raw.includes('"note"')) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const note = (obj.note ?? obj.content ?? obj.text ?? obj.body) as string | undefined;
      if (typeof note === 'string') {
        const withNewlines = note.replace(/\\n/g, '\n');
        const dateToday = obj.date_today as string | undefined;
        let out = withNewlines;
        if (dateToday) out = `Date: ${dateToday}\n\n${withNewlines}`;
        return stripPunctuation(out);
      }
    } catch {
      // JSON invalid (e.g. newlines inside "note" value) — extract with regex
    }
    // Greedy capture until closing "; handles escaped \" and \\n
    const noteMatch = raw.match(/"note"\s*:\s*"((?:[^"\\]|\\.)*)"\s*(?:,\s*"date_today"\s*:\s*"([^"]*)")?\s*}/);
    if (noteMatch) {
      let note = noteMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
      if (noteMatch[2]) note = `Date: ${noteMatch[2]}\n\n${note}`;
      return stripPunctuation(note);
    }
  }

  return stripPunctuation(raw.replace(/\\n/g, '\n'));
}

interface NoteEditorProps {
  notes: HaloNote[];
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onNoteChange: (noteIndex: number, updates: { title?: string; content?: string; fields?: NoteField[] }) => void;
  status: AppStatus;
  templateId: string;
  templateOptions: Array<{ id: string; name: string }>;
  onTemplateChange?: (templateId: string) => void;
  onSaveAsDocx: (noteIndex: number) => void;
  onSaveAll: () => void;
  onEmail: (noteIndex: number) => void;
  savingNoteIndex: number | null;
  /** When false, hide internal note tabs (used when parent provides Transcript | Context | Note tabs) */
  showNoteTabs?: boolean;
}

export const NoteEditor: React.FC<NoteEditorProps> = ({
  notes,
  activeIndex,
  onActiveIndexChange,
  onNoteChange,
  status,
  templateId,
  templateOptions,
  onTemplateChange,
  onSaveAsDocx,
  onSaveAll,
  onEmail,
  savingNoteIndex,
  showNoteTabs = true,
}) => {
  const activeNote = notes[activeIndex];
  const busy = status === AppStatus.FILING || status === AppStatus.SAVING;
  const fields = activeNote?.fields ?? [];
  // Build readable key/value list from raw, or by parsing content when it's a JSON string (e.g. from a previous session).
  const readableFields = useMemo(() => {
    if (activeNote?.raw != null) {
      const fromRaw = rawToReadableFields(activeNote.raw);
      if (fromRaw.length > 0) return fromRaw;
    }
    if (fields.length > 0) return fields.map((f) => ({ key: f.label, label: f.label, body: f.body ?? '' }));
    const content = activeNote?.content?.trim();
    if (content && (content.startsWith('{') || content.startsWith('['))) {
      try {
        const parsed = JSON.parse(content) as unknown;
        const fromContent = rawToReadableFields(parsed);
        if (fromContent.length > 0) return fromContent;
      } catch {
        // not valid JSON, leave empty
      }
    }
    return [];
  }, [activeNote?.raw, activeNote?.content, fields]);

  const displayContent = useMemo(() => {
    let out: string;
    if (readableFields.length > 0) {
      out = fieldsToContent(readableFields.map((f) => ({ label: f.label, body: stripBracesAndQuotesDisplay(f.body) })));
    } else {
      const source =
        typeof activeNote?.raw === 'string' && activeNote.raw.trim().startsWith('{') && activeNote.raw.includes('"note"')
          ? activeNote.raw
          : activeNote?.content;
      out = contentToPlainText(source);
    }
    return stripBracesAndQuotesDisplay(out);
  }, [readableFields, activeNote?.content, activeNote?.raw]);

  const handleFieldChange = (index: number, newBody: string) => {
    const updated = readableFields.map((f, i) => (i === index ? { ...f, body: newBody } : f));
    const obj = Object.fromEntries(updated.map((f) => [f.key, f.body]));
    onNoteChange(activeIndex, { content: JSON.stringify(obj) });
  };

  if (notes.length === 0) {
    return (
      <div className="min-h-[300px] flex-1 flex flex-col bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="flex-1 flex items-center justify-center text-slate-400">
          <p className="text-sm">No notes yet. Use the Scribe to dictate, then notes will appear here.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[300px] flex-1 flex flex-col bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
      <div className="bg-slate-50 px-4 py-2 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Clinical Note Editor</span>
          {showNoteTabs && templateOptions.length > 0 && onTemplateChange && (
            <select
              value={templateId}
              onChange={(e) => onTemplateChange(e.target.value)}
              className="text-xs font-medium border border-slate-200 rounded-lg px-2 py-1 bg-white text-slate-700 shadow-sm"
            >
              {templateOptions.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          )}
        </div>
        {/* Mini-tabs per note (hidden when parent provides consult-level tabs) */}
        {showNoteTabs && (
          <div className="flex gap-1 flex-wrap">
            {notes.map((note, i) => (
              <button
                key={note.noteId}
                type="button"
                onClick={() => onActiveIndexChange(i)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  i === activeIndex ? 'bg-sky-600 text-white shadow-sm' : 'bg-slate-200 text-slate-600 hover:bg-slate-300'
                }`}
              >
                {note.title || `Note ${i + 1}`}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Single open-text view: decoded template output or readable note from HALO — fills space below */}
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        <input
          type="text"
          value={activeNote.title}
          onChange={(e) => onNoteChange(activeIndex, { title: e.target.value })}
          placeholder="Note title"
          className="flex-shrink-0 w-full px-4 py-2 border-b border-slate-200 text-sm font-semibold text-slate-800 bg-white focus:outline-none focus:ring-2 focus:ring-sky-100"
        />
        {readableFields.length > 0 ? (
          <div className="flex-1 min-h-0 overflow-auto p-4 text-sm text-slate-700 bg-slate-50/50 space-y-4">
            {readableFields.map(({ key, label, body }, index) => (
              <div key={key}>
                <strong className="text-slate-900">{label}:</strong>
                <textarea
                  value={stripBracesAndQuotesDisplay(body)}
                  onChange={(e) => handleFieldChange(index, e.target.value)}
                  className="mt-1 w-full min-h-[2.5rem] p-2 rounded border border-slate-200 bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-sky-200 focus:border-sky-400 resize-y"
                  placeholder="—"
                  rows={body.includes('\n') ? Math.min(6, body.split('\n').length + 1) : 1}
                />
              </div>
            ))}
          </div>
        ) : (
          <textarea
            value={stripBracesAndQuotesDisplay(displayContent)}
            onChange={(e) => onNoteChange(activeIndex, { content: e.target.value })}
            placeholder="Note content (decoded from your template and filled from the transcript)..."
            className="flex-1 min-h-0 w-full p-4 focus:outline-none resize-none text-sm leading-relaxed text-slate-700 border-0 bg-slate-50/50 overflow-auto"
          />
        )}
      </div>

      <div className="bg-slate-50 border-t border-slate-200 p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => onSaveAsDocx(activeIndex)}
            disabled={busy || !displayContent.trim()}
            className="flex items-center gap-2 bg-sky-600 text-white px-4 py-2 rounded-lg hover:bg-sky-700 disabled:opacity-50 font-medium transition-all shadow-sm text-sm"
          >
            {savingNoteIndex === activeIndex ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />}
            Save as DOCX
          </button>
          <button
            type="button"
            onClick={() => onEmail(activeIndex)}
            disabled={busy || !displayContent.trim()}
            className="flex items-center gap-2 bg-slate-600 text-white px-4 py-2 rounded-lg hover:bg-slate-700 disabled:opacity-50 font-medium transition-all shadow-sm text-sm"
          >
            <Mail className="w-4 h-4" /> Email
          </button>
          {notes.length > 1 && (
            <button
              type="button"
              onClick={onSaveAll}
              disabled={busy}
              className="flex items-center gap-2 bg-sky-700 text-white px-4 py-2 rounded-lg hover:bg-sky-800 disabled:opacity-50 font-medium transition-all shadow-sm text-sm"
            >
              {status === AppStatus.SAVING ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save All
            </button>
          )}
        </div>
        {activeNote.lastSavedAt && (
          <span className="text-xs text-slate-400">
            Last saved: {new Date(activeNote.lastSavedAt).toLocaleString()}
          </span>
        )}
      </div>
    </div>
  );
};
