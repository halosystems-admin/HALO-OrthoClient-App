import React, { useState, useMemo } from 'react';
import { Save, FileDown, Mail, Loader2, Eye, Pencil, ShieldAlert } from 'lucide-react';
import type { HaloNote } from '../../../shared/types';
import { AppStatus } from '../../../shared/types';

/** Parse note content into labeled fields (e.g. "Subjective:", "Plan:" blocks) for preview */
function parseNoteFields(content: string): Array<{ label: string; body: string }> {
  if (!content.trim()) return [];
  const blocks = content.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
  return blocks.map(block => {
    const firstLineEnd = block.indexOf('\n');
    const firstLine = firstLineEnd === -1 ? block : block.slice(0, firstLineEnd);
    const rest = firstLineEnd === -1 ? '' : block.slice(firstLineEnd + 1).trim();
    const looksLikeHeader = firstLine.length <= 60 && (firstLine.endsWith(':') || /^[A-Z][a-z]+(\s+[A-Za-z]+)*:?\s*$/.test(firstLine));
    if (looksLikeHeader && (rest || firstLine.endsWith(':'))) {
      const label = firstLine.endsWith(':') ? firstLine.slice(0, -1).trim() : firstLine.trim();
      return { label, body: rest || '' };
    }
    return { label: '', body: block };
  });
}

interface NoteEditorProps {
  notes: HaloNote[];
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onNoteChange: (noteIndex: number, updates: { title?: string; content?: string }) => void;
  status: AppStatus;
  templateId: string;
  templateOptions: Array<{ id: string; name: string }>;
  onTemplateChange?: (templateId: string) => void;
  onSaveAsDocx: (noteIndex: number) => void;
  onSaveAll: () => void;
  onEmail: (noteIndex: number) => void;
  savingNoteIndex: number | null;
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
}) => {
  const activeNote = notes[activeIndex];
  const busy = status === AppStatus.FILING || status === AppStatus.SAVING;
  const [viewMode, setViewMode] = useState<'edit' | 'preview'>('preview');
  // Use actual fields from generate_note when present; otherwise parse content into fields
  const fields = useMemo(() => {
    if (activeNote?.fields && activeNote.fields.length > 0) return activeNote.fields;
    return parseNoteFields(activeNote?.content ?? '');
  }, [activeNote?.content, activeNote?.fields]);

  if (notes.length === 0) {
    return (
      <div className="h-[600px] flex flex-col bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="flex-1 flex items-center justify-center text-slate-400">
          <p className="text-sm">No notes yet. Use the Scribe to dictate, then notes will appear here.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-[600px] flex flex-col bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
      <div className="bg-slate-50 px-4 py-2 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Clinical Note Editor</span>
          {templateOptions.length > 0 && onTemplateChange && (
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
          <div className="flex rounded-lg border border-slate-200 bg-white shadow-sm p-0.5">
            <button
              type="button"
              onClick={() => setViewMode('preview')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                viewMode === 'preview' ? 'bg-sky-100 text-sky-800' : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              <Eye size={14} /> Preview
            </button>
            <button
              type="button"
              onClick={() => setViewMode('edit')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                viewMode === 'edit' ? 'bg-sky-100 text-sky-800' : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              <Pencil size={14} /> Edit
            </button>
          </div>
        </div>
        {/* Mini-tabs per note */}
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
      </div>

      {/* Clinician review banner — mandatory per AI healthcare scribe best practice */}
      <div className="flex items-start gap-2.5 bg-amber-50 border-b border-amber-200 px-4 py-2.5">
        <ShieldAlert className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
        <p className="text-xs text-amber-800 leading-snug">
          <span className="font-bold">AI-Generated Draft — Clinician Review Required.</span>{' '}
          Verify all clinical details, diagnoses, and plans against the patient record before saving or acting on this note.
        </p>
      </div>

      {/* Preview: field-by-field read-only view */}
      {viewMode === 'preview' ? (
        <div className="flex-1 overflow-auto bg-slate-50/50 p-4">
          <div className="max-w-2xl mx-auto space-y-4">
            <h2 className="text-base font-semibold text-slate-800 border-b border-slate-200 pb-2">{activeNote.title || 'Untitled note'}</h2>
            {fields.length === 0 ? (
              <p className="text-sm text-slate-500 italic">No structured content to preview. Switch to Edit to add or change the note.</p>
            ) : (
              fields.map((field, idx) => (
                <div key={idx} className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                  {field.label ? (
                    <>
                      <div className="px-4 py-2 bg-slate-50 border-b border-slate-100 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                        {field.label}
                      </div>
                      <div className="px-4 py-3 text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">
                        {field.body || '—'}
                      </div>
                    </>
                  ) : (
                    <div className="px-4 py-3 text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">
                      {field.body}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      ) : (
        /* Edit: title + content */
        <div className="flex-1 flex flex-col overflow-hidden">
          <input
            type="text"
            value={activeNote.title}
            onChange={(e) => onNoteChange(activeIndex, { title: e.target.value })}
            placeholder="Note title"
            className="w-full px-4 py-2 border-b border-slate-200 text-sm font-semibold text-slate-800 bg-white focus:outline-none focus:ring-2 focus:ring-sky-100"
          />
          <textarea
            value={activeNote.content}
            onChange={(e) => onNoteChange(activeIndex, { content: e.target.value })}
            placeholder="Note content..."
            className="flex-1 w-full p-4 focus:outline-none resize-none text-sm leading-relaxed text-slate-700 border-0"
          />
        </div>
      )}

      <div className="bg-slate-50 border-t border-slate-200 p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => onSaveAsDocx(activeIndex)}
            disabled={busy || !activeNote.content.trim()}
            className="flex items-center gap-2 bg-sky-600 text-white px-4 py-2 rounded-lg hover:bg-sky-700 disabled:opacity-50 font-medium transition-all shadow-sm text-sm"
          >
            {savingNoteIndex === activeIndex ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />}
            Save as DOCX
          </button>
          <button
            type="button"
            onClick={() => onEmail(activeIndex)}
            disabled={busy || !activeNote.content.trim()}
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
