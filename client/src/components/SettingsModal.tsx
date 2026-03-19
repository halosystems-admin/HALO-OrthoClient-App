import React, { useState, useEffect, useRef } from 'react';
import type { UserSettings } from '../../../shared/types';
import {
  X, Pencil, Save, User, Clock, Briefcase, MapPin, GraduationCap,
  FileText, Upload, Check, AlertCircle, Send, Plus, Image as ImageIcon, Trash2,
} from 'lucide-react';
import { requestNewTemplate } from '../services/api';

const HALO_TEMPLATE_OPTIONS = [
  { id: 'clinical_note', name: 'Clinical Note' },
  { id: 'op_report', name: 'Operation Report' },
  { id: 'jon_note', name: 'Open Note' },
];

const DEFAULT_SETTINGS: UserSettings = {
  firstName: '',
  lastName: '',
  profession: '',
  department: '',
  city: '',
  postalCode: '',
  university: '',
  noteTemplate: 'soap',
  customTemplateContent: '',
  customTemplateName: '',
  templateId: 'clinical_note',
  homeScreenImageUrl: '',
};

const HOME_SCREEN_MAX_WIDTH = 1200;
const HOME_SCREEN_JPEG_QUALITY = 0.78;

function resizeImageToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      let { width, height } = img;
      if (width > HOME_SCREEN_MAX_WIDTH) {
        height = (height * HOME_SCREEN_MAX_WIDTH) / width;
        width = HOME_SCREEN_MAX_WIDTH;
      }
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Canvas not supported'));
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      try {
        resolve(canvas.toDataURL('image/jpeg', HOME_SCREEN_JPEG_QUALITY));
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image'));
    };
    img.src = url;
  });
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  settings: UserSettings | null;
  onSave: (settings: UserSettings) => Promise<void>;
  userEmail?: string;
  loginTime: number;
  onToast?: (message: string, type: 'success' | 'error' | 'info') => void;
}

export const SettingsModal: React.FC<Props> = ({
  isOpen, onClose, settings, onSave, userEmail, loginTime, onToast,
}) => {
  const [editMode, setEditMode] = useState(false);
  const [form, setForm] = useState<UserSettings>(settings || DEFAULT_SETTINGS);
  const [saving, setSaving] = useState(false);
  const [elapsed, setElapsed] = useState('');
  const [templateTab, setTemplateTab] = useState<'soap' | 'custom'>(settings?.noteTemplate || 'soap');
  const [uploadError, setUploadError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Request new template form
  const [showRequestForm, setShowRequestForm] = useState(false);
  const [requestDescription, setRequestDescription] = useState('');
  const [requestFiles, setRequestFiles] = useState<File[]>([]);
  const [requestSending, setRequestSending] = useState(false);
  const requestFileInputRef = useRef<HTMLInputElement>(null);
  const homeScreenInputRef = useRef<HTMLInputElement>(null);
  const [homeScreenLoading, setHomeScreenLoading] = useState(false);
  const [homeScreenError, setHomeScreenError] = useState('');

  useEffect(() => {
    if (settings) {
      setForm(settings);
      setTemplateTab(settings.noteTemplate);
    }
  }, [settings]);

  // Session timer
  useEffect(() => {
    if (!isOpen) return;
    const update = () => {
      const diff = Date.now() - loginTime;
      const hrs = Math.floor(diff / 3600000);
      const mins = Math.floor((diff % 3600000) / 60000);
      const secs = Math.floor((diff % 60000) / 1000);
      setElapsed(`${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`);
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [isOpen, loginTime]);

  const requiredFieldsMissing = !form.firstName.trim() || !form.lastName.trim() || !form.profession.trim() || !form.department.trim();

  const handleSave = async () => {
    if (editMode && requiredFieldsMissing) return;
    setSaving(true);
    try {
      const updated = { ...form, noteTemplate: templateTab, templateId: form.templateId || 'clinical_note' };
      await onSave(updated);
      setForm(updated);
      setEditMode(false);
    } catch {
      // Error handled by parent
    }
    setSaving(false);
  };

  const handleTemplateUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadError('');

    // Accept .txt, .md, and .docx (read as text)
    const validTypes = ['text/plain', 'text/markdown', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    const validExts = ['.txt', '.md'];
    const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();

    if (!validTypes.includes(file.type) && !validExts.includes(ext)) {
      setUploadError('Please upload a .txt or .md file. These formats work best for AI template reading.');
      return;
    }

    if (file.size > 50000) {
      setUploadError('Template file too large. Keep it under 50KB.');
      return;
    }

    try {
      const text = await file.text();
      setForm(prev => ({
        ...prev,
        customTemplateContent: text,
        customTemplateName: file.name,
        noteTemplate: 'custom',
      }));
      setTemplateTab('custom');
    } catch {
      setUploadError('Failed to read file.');
    }
    e.target.value = '';
  };


  const handleRequestTemplateSubmit = async () => {
    const desc = requestDescription.trim();
    if (!desc) {
      onToast?.('Please describe the template you need.', 'info');
      return;
    }
    setRequestSending(true);
    try {
      const attachments: Array<{ name: string; content: string }> = [];
      for (const file of requestFiles) {
        const content = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => {
            const result = r.result as string;
            const base64 = result.includes(',') ? result.split(',')[1] : result;
            resolve(base64 || '');
          };
          r.onerror = () => reject(new Error('Failed to read file'));
          r.readAsDataURL(file);
        });
        if (content) attachments.push({ name: file.name, content });
      }
      await requestNewTemplate({ description: desc, attachments: attachments.length ? attachments : undefined });
      onToast?.('Request sent. We will get back to you.', 'success');
      setShowRequestForm(false);
      setRequestDescription('');
      setRequestFiles([]);
    } catch (err: unknown) {
      const msg = err && typeof err === 'object' && 'message' in err ? String((err as Error).message) : 'Request failed.';
      onToast?.(msg, 'error');
    } finally {
      setRequestSending(false);
    }
  };

  if (!isOpen) return null;

  const hasProfile = form.firstName || form.lastName || form.profession || form.department;
  const displayName = [form.firstName, form.lastName].filter(Boolean).join(' ') || 'Not set';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg m-4 max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="bg-gradient-to-r from-slate-800 to-slate-900 px-6 py-5 flex items-center justify-between rounded-t-2xl">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-sky-500/20 rounded-xl flex items-center justify-center">
              <User size={20} className="text-sky-400" />
            </div>
            <div>
              <h2 className="text-white font-bold text-lg">Profile & Settings</h2>
              <p className="text-slate-400 text-xs">{userEmail || 'Not signed in'}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!editMode && (
              <button
                onClick={() => setEditMode(true)}
                className="p-2 rounded-lg text-slate-400 hover:text-sky-400 hover:bg-slate-700 transition-all"
                title="Edit Profile"
              >
                <Pencil size={16} />
              </button>
            )}
            <button
              onClick={onClose}
              className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700 transition-all"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Session Info */}
          <div className="flex items-center gap-3 bg-slate-50 rounded-xl px-4 py-3 border border-slate-100">
            <Clock size={16} className="text-sky-600 shrink-0" />
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Session Duration</p>
              <p className="text-sm font-mono font-bold text-slate-700">{elapsed}</p>
            </div>
          </div>

          {/* Profile Section */}
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3 flex items-center gap-1.5">
              <User size={12} /> Practitioner Profile
            </h3>

            {editMode ? (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 mb-1">First Name <span className="text-rose-400">*</span></label>
                    <input
                      type="text"
                      value={form.firstName}
                      onChange={e => setForm(prev => ({ ...prev, firstName: e.target.value }))}
                      placeholder="e.g. Sarah"
                      className={`w-full px-3 py-2.5 rounded-lg border text-sm focus:border-sky-500 focus:ring-2 focus:ring-sky-100 outline-none transition ${!form.firstName.trim() ? 'border-rose-200 bg-rose-50/30' : 'border-slate-200'}`}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 mb-1">Last Name <span className="text-rose-400">*</span></label>
                    <input
                      type="text"
                      value={form.lastName}
                      onChange={e => setForm(prev => ({ ...prev, lastName: e.target.value }))}
                      placeholder="e.g. Connor"
                      className={`w-full px-3 py-2.5 rounded-lg border text-sm focus:border-sky-500 focus:ring-2 focus:ring-sky-100 outline-none transition ${!form.lastName.trim() ? 'border-rose-200 bg-rose-50/30' : 'border-slate-200'}`}
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-500 mb-1 flex items-center gap-1"><Briefcase size={11} /> Profession <span className="text-rose-400">*</span></label>
                  <input
                    type="text"
                    value={form.profession}
                    onChange={e => setForm(prev => ({ ...prev, profession: e.target.value }))}
                    placeholder="e.g. Physiotherapist, General Practitioner"
                    className={`w-full px-3 py-2.5 rounded-lg border text-sm focus:border-sky-500 focus:ring-2 focus:ring-sky-100 outline-none transition ${!form.profession.trim() ? 'border-rose-200 bg-rose-50/30' : 'border-slate-200'}`}
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-500 mb-1 flex items-center gap-1"><Briefcase size={11} /> Department <span className="text-rose-400">*</span></label>
                  <input
                    type="text"
                    value={form.department}
                    onChange={e => setForm(prev => ({ ...prev, department: e.target.value }))}
                    placeholder="e.g. Orthopaedics, Cardiology, General Practice"
                    className={`w-full px-3 py-2.5 rounded-lg border text-sm focus:border-sky-500 focus:ring-2 focus:ring-sky-100 outline-none transition ${!form.department.trim() ? 'border-rose-200 bg-rose-50/30' : 'border-slate-200'}`}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 mb-1 flex items-center gap-1"><MapPin size={11} /> City</label>
                    <input
                      type="text"
                      value={form.city}
                      onChange={e => setForm(prev => ({ ...prev, city: e.target.value }))}
                      placeholder="e.g. Cape Town"
                      className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm focus:border-sky-500 focus:ring-2 focus:ring-sky-100 outline-none transition"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 mb-1">Postal Code</label>
                    <input
                      type="text"
                      value={form.postalCode}
                      onChange={e => setForm(prev => ({ ...prev, postalCode: e.target.value }))}
                      placeholder="e.g. 8001"
                      className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm focus:border-sky-500 focus:ring-2 focus:ring-sky-100 outline-none transition"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-500 mb-1 flex items-center gap-1"><GraduationCap size={11} /> University</label>
                  <input
                    type="text"
                    value={form.university}
                    onChange={e => setForm(prev => ({ ...prev, university: e.target.value }))}
                    placeholder="e.g. University of Cape Town"
                    className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm focus:border-sky-500 focus:ring-2 focus:ring-sky-100 outline-none transition"
                  />
                </div>
                {requiredFieldsMissing && (
                  <p className="text-xs text-rose-400 flex items-center gap-1 pt-1"><AlertCircle size={12} /> Please fill in all required fields marked with *</p>
                )}
              </div>
            ) : (
              <div className="bg-slate-50 rounded-xl border border-slate-100 overflow-hidden">
                {hasProfile ? (
                  <div className="divide-y divide-slate-100">
                    <div className="px-4 py-3 flex items-center gap-3">
                      <div className="w-9 h-9 bg-sky-500 rounded-full flex items-center justify-center text-white font-bold text-sm">
                        {(form.firstName?.[0] || '').toUpperCase()}{(form.lastName?.[0] || '').toUpperCase()}
                      </div>
                      <div>
                        <p className="font-semibold text-slate-800 text-sm">{displayName}</p>
                        {form.profession && <p className="text-xs text-sky-600 font-medium">{form.profession}</p>}
                        {form.department && <p className="text-xs text-slate-500">{form.department}</p>}
                      </div>
                    </div>
                    {(form.city || form.postalCode) && (
                      <div className="px-4 py-2.5 flex items-center gap-2 text-xs text-slate-500">
                        <MapPin size={12} className="text-slate-400" />
                        {[form.city, form.postalCode].filter(Boolean).join(', ')}
                      </div>
                    )}
                    {form.university && (
                      <div className="px-4 py-2.5 flex items-center gap-2 text-xs text-slate-500">
                        <GraduationCap size={12} className="text-slate-400" />
                        {form.university}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="px-4 py-6 text-center">
                    <p className="text-sm text-slate-400">No profile information set</p>
                    <button
                      onClick={() => setEditMode(true)}
                      className="mt-2 text-xs font-semibold text-sky-600 hover:text-sky-700"
                    >
                      Set up your profile
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Home screen image — shown when no patient is selected */}
          <div className="border-t border-slate-100 pt-6">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3 flex items-center gap-1.5">
              <ImageIcon size={12} /> Home screen image
            </h3>
            <p className="text-xs text-slate-500 mb-3">
              Shown when you open the app with no patient selected—e.g. a favourite view (sea, holiday house) so you see something calming before you start.
            </p>
            <input
              ref={homeScreenInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setHomeScreenError('');
                setHomeScreenLoading(true);
                try {
                  const dataUrl = await resizeImageToDataUrl(file);
                  setForm((prev) => ({ ...prev, homeScreenImageUrl: dataUrl }));
                } catch (err) {
                  setHomeScreenError(err instanceof Error ? err.message : 'Failed to process image.');
                }
                setHomeScreenLoading(false);
                e.target.value = '';
              }}
            />
            {form.homeScreenImageUrl ? (
              <div className="space-y-2">
                <div className="relative rounded-xl overflow-hidden border border-slate-200 bg-slate-100 aspect-video max-h-40">
                  <img
                    src={form.homeScreenImageUrl}
                    alt="Home screen preview"
                    className="w-full h-full object-cover"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => homeScreenInputRef.current?.click()}
                    disabled={homeScreenLoading}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-600 hover:bg-slate-50 transition disabled:opacity-50"
                  >
                    {homeScreenLoading ? 'Processing…' : <><ImageIcon size={14} /> Change image</>}
                  </button>
                  <button
                    type="button"
                    onClick={() => setForm((prev) => ({ ...prev, homeScreenImageUrl: '' }))}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-600 hover:bg-rose-50 hover:text-rose-700 hover:border-rose-200 transition"
                  >
                    <Trash2 size={14} /> Remove
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => homeScreenInputRef.current?.click()}
                disabled={homeScreenLoading}
                className="flex items-center gap-2 px-4 py-3 rounded-xl border border-dashed border-slate-200 bg-slate-50/50 text-slate-600 hover:bg-slate-100 hover:border-sky-200 transition text-sm font-medium w-full"
              >
                <ImageIcon size={18} />
                {homeScreenLoading ? 'Processing…' : 'Choose a photo'}
              </button>
            )}
            {homeScreenError && (
              <p className="mt-1.5 text-xs text-rose-600">{homeScreenError}</p>
            )}
          </div>

          {/* Note templates: current templates + default + request new */}
          <div className="border-t border-slate-100 pt-6">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3 flex items-center gap-1.5">
              <FileText size={12} /> Note templates
            </h3>
            <p className="text-xs text-slate-400 mb-3">Templates used when generating notes from scribe dictation (Halo Functions API).</p>

            <p className="text-xs text-slate-600 mb-2">You have access to:</p>
            <div className="flex flex-wrap gap-2 mb-4">
              {HALO_TEMPLATE_OPTIONS.map(t => (
                <span
                  key={t.id}
                  className="px-3 py-1.5 rounded-lg bg-slate-100 text-slate-700 text-xs font-medium border border-slate-200"
                >
                  {t.name}
                </span>
              ))}
            </div>

            <label className="block text-xs font-semibold text-slate-500 mb-1.5">Default template</label>
            <select
              value={form.templateId || 'clinical_note'}
              onChange={(e) => setForm(prev => ({ ...prev, templateId: e.target.value }))}
              className="w-full px-3 py-2 rounded-lg border border-slate-200 bg-white text-sm text-slate-700 focus:border-sky-500 focus:ring-2 focus:ring-sky-100 outline-none shadow-sm"
            >
              {HALO_TEMPLATE_OPTIONS.map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>

            {!showRequestForm ? (
              <button
                type="button"
                onClick={() => setShowRequestForm(true)}
                className="mt-4 flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 hover:border-sky-200 transition shadow-sm"
              >
                <Plus size={16} /> Request new template
              </button>
            ) : (
              <div className="mt-4 p-4 rounded-xl border border-slate-200 bg-slate-50/50 space-y-3">
                <p className="text-xs font-semibold text-slate-600">Request a new template</p>
                <p className="text-xs text-slate-500">Describe the template you need and optionally attach example documents. The request will be sent to admin@halo.africa.</p>
                <textarea
                  value={requestDescription}
                  onChange={(e) => setRequestDescription(e.target.value)}
                  placeholder="Describe the template contents / structure (e.g. sections, fields)..."
                  rows={4}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 bg-white text-sm text-slate-700 placeholder-slate-400 focus:border-sky-500 focus:ring-2 focus:ring-sky-100 outline-none resize-none"
                />
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">Example documents (optional)</label>
                  <input
                    ref={requestFileInputRef}
                    type="file"
                    multiple
                    accept=".txt,.md,.doc,.docx,application/pdf"
                    onChange={(e) => setRequestFiles(Array.from(e.target.files || []))}
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={() => requestFileInputRef.current?.click()}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-600 hover:bg-slate-50 transition"
                  >
                    <Upload size={14} /> {requestFiles.length ? `${requestFiles.length} file(s) chosen` : 'Choose files'}
                  </button>
                  {requestFiles.length > 0 && (
                    <ul className="mt-1 text-xs text-slate-500 list-disc list-inside">
                      {requestFiles.map((f, i) => (
                        <li key={i}>{f.name}</li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => { setShowRequestForm(false); setRequestDescription(''); setRequestFiles([]); }}
                    disabled={requestSending}
                    className="px-3 py-2 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-100 transition"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleRequestTemplateSubmit}
                    disabled={requestSending || !requestDescription.trim()}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50 transition"
                  >
                    {requestSending ? 'Sending…' : <><Send size={14} /> Send request</>}
                  </button>
                </div>
              </div>
            )}
          </div>

        </div>

        {/* Footer with Save */}
        {editMode || templateTab !== (settings?.noteTemplate || 'soap') || form.customTemplateContent !== (settings?.customTemplateContent || '') || form.templateId !== (settings?.templateId || 'clinical_note') || form.homeScreenImageUrl !== (settings?.homeScreenImageUrl || '') ? (
          <div className="border-t border-slate-100 p-4 bg-slate-50 flex gap-3">
            <button
              onClick={() => {
                setEditMode(false);
                setForm(settings || DEFAULT_SETTINGS);
                setTemplateTab(settings?.noteTemplate || 'soap');
                setHomeScreenError('');
              }}
              className="flex-1 px-4 py-2.5 rounded-xl font-medium text-slate-600 hover:bg-slate-100 transition text-sm"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving || (editMode && requiredFieldsMissing)}
              className="flex-1 bg-sky-600 hover:bg-sky-700 text-white px-4 py-2.5 rounded-xl font-bold shadow-lg shadow-sky-600/20 transition text-sm flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <Save size={14} /> {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
};
