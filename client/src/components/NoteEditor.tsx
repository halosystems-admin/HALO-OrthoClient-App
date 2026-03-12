import React, { useMemo } from 'react';
import { Save, FileDown, Mail, Loader2 } from 'lucide-react';
import type { HaloNote, NoteField } from '../../../shared/types';
import { AppStatus } from '../../../shared/types';

/** Turn structured fields into a single open-text note (decoded template output). */
function fieldsToContent(fields: NoteField[]): string {
  return fields
    .map((f) => (f.label ? `${f.label}:\n${f.body ?? ''}` : f.body))
    .filter(Boolean)
    .join('\n\n');
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
  const displayContent = useMemo(() => {
    if (activeNote?.content?.trim()) return activeNote.content;
    if (fields.length > 0) return fieldsToContent(fields);
    return '';
  }, [activeNote?.content, fields]);

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

      {/* Single open-text view: decoded template output (editable) */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <input
          type="text"
          value={activeNote.title}
          onChange={(e) => onNoteChange(activeIndex, { title: e.target.value })}
          placeholder="Note title"
          className="w-full px-4 py-2 border-b border-slate-200 text-sm font-semibold text-slate-800 bg-white focus:outline-none focus:ring-2 focus:ring-sky-100"
        />
        <textarea
          value={displayContent}
          onChange={(e) => onNoteChange(activeIndex, { content: e.target.value })}
          placeholder="Note content (decoded from your template and filled from the transcript)..."
          className="flex-1 w-full p-4 focus:outline-none resize-none text-sm leading-relaxed text-slate-700 border-0 bg-slate-50/50"
        />
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
