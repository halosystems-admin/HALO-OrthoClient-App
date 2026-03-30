import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { Patient, DriveFile, LabAlert, BreadcrumbItem, ChatMessage, HaloNote, NoteField, CalendarEvent, ScribeSession, AssistantOrchestrationResult } from '../../../shared/types';
import { AppStatus, FOLDER_MIME_TYPE } from '../../../shared/types';

import {
  fetchFiles,
  fetchFilesFirstPage,
  fetchFilesPage,
  fetchFolderContents,
  warmAndListFiles,
  uploadFile,
  updatePatient,
  updateFileMetadata,
  generatePatientSummary,
  analyzeAndRenameImage,
  extractLabAlerts,
  deleteFile,
  createFolder,
  askHaloStream,
  askHalo,
  orchestrateAssistant,
  generateNotePreview,
  saveNoteAsDocx,
  generatePrepNote,
  getHaloTemplates,
  describeFile,
  fetchPatientSessions,
  savePatientSession,
} from '../services/api';
import {
  Upload, Calendar, Clock, CheckCircle2, ChevronLeft, Loader2,
  CloudUpload, Pencil, X, Trash2, FolderOpen, MessageCircle,
  FolderPlus, ChevronRight, ExternalLink, FileText, Layers, Plus,
  History, Bot,
} from 'lucide-react';
import { SmartSummary } from '../features/smart-summary/SmartSummary';
import { LabAlerts } from '../features/lab-alerts/LabAlerts';
import { HeaderConsultationRecorder } from '../features/scribe/HeaderConsultationRecorder';
import { FileViewer } from '../components/FileViewer';
import { FileBrowser } from '../components/FileBrowser';
import { NoteEditor } from '../components/NoteEditor';
import { PatientChat } from '../components/PatientChat';
import { PatientAssistant } from '../components/PatientAssistant';
import { getErrorMessage } from '../utils/formatting';

const MAX_MAIN_COMPLAINT_LEN = 80;

/** Extract a short main complaint from note content for session list title (e.g. "Ankle Fracture"). */
function extractMainComplaint(content: string): string {
  if (!content || typeof content !== 'string') return '';
  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const complaintHeaders = /^(?:presenting complaint|chief complaint|reason for visit|main complaint|now):\s*/i;
  for (const line of lines) {
    const match = line.match(complaintHeaders);
    if (match) {
      const after = line.slice(match[0].length).trim();
      if (after) return after.slice(0, MAX_MAIN_COMPLAINT_LEN);
    }
    if (line.startsWith('-') && line.length > 1) {
      const text = line.slice(1).trim();
      if (text && text.length < 120) return text.slice(0, MAX_MAIN_COMPLAINT_LEN);
    }
  }
  const first = lines[0];
  if (first && first.length < 120) return first.slice(0, MAX_MAIN_COMPLAINT_LEN);
  return '';
}

/** Effective note text for save/email: content or decoded from fields. */
function getNoteText(note: HaloNote): string {
  if (note.content?.trim()) return note.content;
  if (note.fields?.length) {
    return (note.fields as NoteField[])
      .map((f) => (f.label ? `${f.label}:\n${f.body ?? ''}` : f.body))
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

/** Fallback when Halo get_templates fails or returns empty; use real IDs from Halo when possible to avoid 404. */
const DEFAULT_TEMPLATE_OPTIONS: Array<{ id: string; name: string }> = [
  { id: 'clinical_note', name: 'Clinical Note' },
  { id: 'op_report', name: 'Operation Report' },
  { id: 'jon_note', name: 'Open Note' },
];

/** Orthopaedic surgery Halo user/template mapping (for op_report). */
const ORTHO_TEMPLATE_ID = 'op_report';
const ORTHO_USER_ID = '224e8ca0-b8ef-4c6e-8707-e9e0a7774ec5';

function getHaloUserForTemplate(templateId: string | undefined): string | undefined {
  if (!templateId) return undefined;
  if (templateId === ORTHO_TEMPLATE_ID) return ORTHO_USER_ID;
  return undefined;
}

function normalizeHaloTemplates(raw: Record<string, unknown>): Array<{ id: string; name: string }> {
  if (!raw || typeof raw !== 'object') return [];
  const arr = Array.isArray(raw)
    ? raw
    : raw.templates && Array.isArray(raw.templates)
      ? raw.templates
      : raw;
  // Array: [ { id, name } or { template_id, name } ]
  if (Array.isArray(arr)) {
    return (arr as Array<Record<string, unknown>>)
      .map((t) => {
        const id = (t.id ?? t.template_id ?? t.templateId) as string;
        const name = (t.name ?? t.title ?? id ?? '') as string;
        return id && name ? { id: String(id), name: String(name) } : null;
      })
      .filter((t): t is { id: string; name: string } => t != null);
  }
  // Object: { "templateId": { name: "..." } } (e.g. Firebase users/{id}/templates)
  return Object.entries(arr as Record<string, unknown>).map(([id, val]) => {
    const o = val && typeof val === 'object' ? (val as Record<string, unknown>) : {};
    const name = (o.name ?? o.title ?? id) as string;
    return { id, name: String(name || id) };
  });
}

interface Props {
  patient: Patient;
  onBack: () => void;
  onDataChange: () => void;
  onToast: (message: string, type: 'success' | 'error' | 'info') => void;
  templateId?: string;
  calendarPrepEvent?: CalendarEvent | null;
  /** Optional per-user letterhead stored in Drive (uploaded from Settings). */
  letterheadDriveFileId?: string;
}

export const PatientWorkspace: React.FC<Props> = ({ patient, onBack, onDataChange, onToast, templateId: propTemplateId, calendarPrepEvent, letterheadDriveFileId }) => {
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [summary, setSummary] = useState<string[]>([]);
  const [alerts, setAlerts] = useState<LabAlert[]>([]);
  const [notes, setNotes] = useState<HaloNote[]>([]);
  const [activeNoteIndex, setActiveNoteIndex] = useState(0);
  const [templateId, setTemplateId] = useState(propTemplateId || 'clinical_note');
  const [pendingTranscript, setPendingTranscript] = useState<string | null>(null);
  /** Full transcript for the current session (all completed segments). */
  const [lastTranscript, setLastTranscript] = useState<string>('');
  /** Live transcript for the current in-progress recording segment (not yet merged into lastTranscript). */
  const [liveTranscriptSegment, setLiveTranscriptSegment] = useState<string>('');
  const [isLiveStreaming, setIsLiveStreaming] = useState(false);
  const [showAddNoteModal, setShowAddNoteModal] = useState(false);
  const [consultSubTab, setConsultSubTab] = useState<'transcript' | 'context' | number>('transcript');
  const [templateOptions, setTemplateOptions] = useState<Array<{ id: string; name: string }>>(DEFAULT_TEMPLATE_OPTIONS);
  const [selectedTemplatesForGenerate, setSelectedTemplatesForGenerate] = useState<string[]>(['clinical_note']);
  const [templateSearch, setTemplateSearch] = useState('');
  const [status, setStatus] = useState<AppStatus>(AppStatus.IDLE);
  const [activeTab, setActiveTab] = useState<'overview' | 'notes' | 'chat' | 'assistant' | 'sessions'>('overview');
  const [savingNoteIndex, setSavingNoteIndex] = useState<number | null>(null);
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [showAiPanel, setShowAiPanel] = useState(true);
  const [aiLoading, setAiLoading] = useState(false);
  const [isGeneratingNotes, setIsGeneratingNotes] = useState(false);
  const [showCustomAiNoteModal, setShowCustomAiNoteModal] = useState(false);
  const [customAiPrompt, setCustomAiPrompt] = useState('');
  const [customAiLoading, setCustomAiLoading] = useState(false);
  const [consultContext, setConsultContext] = useState('');
  const [didCopyTranscript, setDidCopyTranscript] = useState(false);
  const [noteGenerationStep, setNoteGenerationStep] = useState(0);
  const [sessions, setSessions] = useState<ScribeSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  // Derived "current" transcript that the UI shows and copies:
  // any completed segments (lastTranscript) plus the current live segment (if recording).
  const currentTranscript = liveTranscriptSegment
    ? (lastTranscript ? `${lastTranscript}\n\n${liveTranscriptSegment}` : liveTranscriptSegment)
    : lastTranscript;

  // Folder navigation state
  const [currentFolderId, setCurrentFolderId] = useState<string>(patient.id);
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbItem[]>([
    { id: patient.id, name: patient.name },
  ]);

  const [editingPatient, setEditingPatient] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDob, setEditDob] = useState("");
  const [editSex, setEditSex] = useState<'M' | 'F'>('M');

  const [editingFile, setEditingFile] = useState<DriveFile | null>(null);
  const [editFileName, setEditFileName] = useState("");

  const [fileToDelete, setFileToDelete] = useState<DriveFile | null>(null);

  // File viewer state
  const [viewingFile, setViewingFile] = useState<DriveFile | null>(null);

  // Chat state — use a ref to always have the latest messages for API calls
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [chatLongWait, setChatLongWait] = useState(false);
  const chatMessagesRef = useRef<ChatMessage[]>([]);
  const chatLongWaitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  chatMessagesRef.current = chatMessages;
  const [assistantMessages, setAssistantMessages] = useState<ChatMessage[]>([]);
  const [assistantInput, setAssistantInput] = useState('');
  const [assistantLoading, setAssistantLoading] = useState(false);
  const [assistantLongWait, setAssistantLongWait] = useState(false);
  const [assistantLatestResult, setAssistantLatestResult] = useState<AssistantOrchestrationResult | null>(null);
  const [assistantDocSaving, setAssistantDocSaving] = useState(false);
  const assistantMessagesRef = useRef<ChatMessage[]>([]);
  const assistantLongWaitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  assistantMessagesRef.current = assistantMessages;

  // Create folder state
  const [showCreateFolderModal, setShowCreateFolderModal] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");

  // Upload destination picker state
  const [showUploadPicker, setShowUploadPicker] = useState(false);
  const [uploadTargetFolderId, setUploadTargetFolderId] = useState<string>(patient.id);
  const [uploadTargetLabel, setUploadTargetLabel] = useState<string>(patient.name);
  const [uploadPickerFolders, setUploadPickerFolders] = useState<DriveFile[]>([]);
  const [uploadPickerLoading, setUploadPickerLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [showContextDrivePicker, setShowContextDrivePicker] = useState(false);
  const [contextDriveFiles, setContextDriveFiles] = useState<DriveFile[]>([]);
  const [contextDriveLoading, setContextDriveLoading] = useState(false);
  const [contextDriveSelectedIds, setContextDriveSelectedIds] = useState<string[]>([]);

  const isFolder = (file: DriveFile): boolean => file.mimeType === FOLDER_MIME_TYPE;

  // Load folder contents (with loading indicator)
  const loadFolderContents = useCallback(async (folderId: string) => {
    setStatus(AppStatus.LOADING);
    try {
      const contents = folderId === patient.id
        ? await fetchFiles(patient.id)
        : await fetchFolderContents(folderId);
      setFiles(contents);
    } catch (err) {
      onToast(getErrorMessage(err), 'error');
    }
    setStatus(AppStatus.IDLE);
  }, [patient.id, onToast]);

  // Silent refresh (no loading indicator — used for periodic polling)
  const silentRefresh = useCallback(async () => {
    try {
      const contents = currentFolderId === patient.id
        ? await fetchFiles(patient.id)
        : await fetchFolderContents(currentFolderId);
      setFiles(contents);
    } catch {
      // Silent — don't show errors for background refreshes
    }
  }, [currentFolderId, patient.id]);

  // Poll for external changes every 30 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      silentRefresh();
      onDataChange();
    }, 30_000);
    return () => clearInterval(interval);
  }, [silentRefresh, onDataChange]);

  // Clean up upload progress interval on unmount
  useEffect(() => {
    return () => {
      if (uploadIntervalRef.current) clearInterval(uploadIntervalRef.current);
    };
  }, []);

  // Initial load + AI summary (only at root patient folder)
  useEffect(() => {
    let isMounted = true;

    const loadData = async () => {
      setStatus(AppStatus.LOADING);
      setFiles([]);
      setSummary([]);
      setAlerts([]);
      setChatMessages([]);
      setChatInput("");
      setUploadMessage(null);
      setCurrentFolderId(patient.id);
      setBreadcrumbs([{ id: patient.id, name: patient.name }]);
      setUploadTargetFolderId(patient.id);
      setUploadTargetLabel(patient.name);

      try {
        // Try direct list first (fast when Drive responds). Fall back to warm-and-list if it fails
        // (warm upload can help with Drive API cold start; server has timeouts so we never hang)
        let firstFiles: DriveFile[];
        let nextPage: string | null;
        try {
          const direct = await fetchFilesFirstPage(patient.id, 100);
          firstFiles = direct.files;
          nextPage = direct.nextPage;
        } catch {
          const warm = await warmAndListFiles(patient.id, 100);
          firstFiles = warm.files;
          nextPage = warm.nextPage;
        }
        if (!isMounted) return;
        setFiles(firstFiles);
        setStatus(AppStatus.IDLE);

        // Fetch remaining pages in background and append (so full list appears without blocking UI)
        if (nextPage) {
          (async () => {
            const all = [...firstFiles];
            let page: string | null = nextPage;
            while (page && isMounted) {
              try {
                const data = await fetchFilesPage(patient.id, page);
                all.push(...data.files);
                if (isMounted) setFiles([...all]);
                page = data.nextPage;
              } catch {
                break;
              }
            }
          })();
        }
      } catch (err) {
        if (isMounted) {
          onToast(getErrorMessage(err), 'error');
        }
        if (isMounted) setStatus(AppStatus.IDLE);
      }
    };

    loadData();
    return () => { isMounted = false; };
  }, [patient.id, patient.name, onToast]);

  // Load template list from Halo when user opens Editor & Scribe (use real template IDs to avoid 404)
  // Also load sessions when opening Editor & Scribe or Previous Sessions tab
  useEffect(() => {
    if (activeTab !== 'notes' && activeTab !== 'sessions') return;

    if (activeTab === 'notes') {
      getHaloTemplates()
        .then((raw) => {
          const list = normalizeHaloTemplates(raw as Record<string, unknown>);
          if (list.length > 0) {
            setTemplateOptions(list);
            setSelectedTemplatesForGenerate((prev) => {
              const valid = prev.filter((id) => list.some((t) => t.id === id));
              return valid.length > 0 ? valid : [list[0].id];
            });
          }
        })
        .catch(() => {
          // Keep DEFAULT_TEMPLATE_OPTIONS on failure
        });
    }

    setSessionsLoading(true);
    fetchPatientSessions(patient.id)
      .then((res) => {
        const items = Array.isArray(res.sessions) ? res.sessions : [];
        const sorted = [...items].sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1));
        setSessions(sorted);
      })
      .catch(() => {
        setSessions([]);
        setActiveSessionId(null);
      })
      .finally(() => {
        setSessionsLoading(false);
      });
  }, [activeTab, patient.id]);

  // Navigate into a subfolder
  const navigateToFolder = async (folder: DriveFile) => {
    setBreadcrumbs(prev => [...prev, { id: folder.id, name: folder.name }]);
    setCurrentFolderId(folder.id);
    await loadFolderContents(folder.id);
  };

  const navigateBack = async () => {
    if (breadcrumbs.length <= 1) return;
    const newBreadcrumbs = breadcrumbs.slice(0, -1);
    const parentId = newBreadcrumbs[newBreadcrumbs.length - 1].id;
    setBreadcrumbs(newBreadcrumbs);
    setCurrentFolderId(parentId);
    await loadFolderContents(parentId);
  };

  const navigateToBreadcrumb = async (index: number) => {
    if (index === breadcrumbs.length - 1) return;
    const newBreadcrumbs = breadcrumbs.slice(0, index + 1);
    const targetId = newBreadcrumbs[newBreadcrumbs.length - 1].id;
    setBreadcrumbs(newBreadcrumbs);
    setCurrentFolderId(targetId);
    await loadFolderContents(targetId);
  };

  const handleContextUploadClick = () => {
    setUploadTargetFolderId(patient.id);
    setUploadTargetLabel(patient.name);
    fileInputRef.current?.click();
  };

  // Upload destination picker — always default to current patient so switching profiles doesn't show previous patient
  const openUploadPicker = async () => {
    setUploadTargetFolderId(patient.id);
    setUploadTargetLabel(patient.name);
    setShowUploadPicker(true);
    setUploadPickerLoading(true);
    try {
      const contents = await fetchFiles(patient.id);
      setUploadPickerFolders(contents.filter(f => f.mimeType === FOLDER_MIME_TYPE));
    } catch {
      setUploadPickerFolders([]);
    }
    setUploadPickerLoading(false);
  };

  const selectUploadFolder = async (folder: DriveFile) => {
    setUploadTargetFolderId(folder.id);
    setUploadTargetLabel(folder.name);
    setUploadPickerLoading(true);
    try {
      const contents = await fetchFolderContents(folder.id);
      setUploadPickerFolders(contents.filter(f => f.mimeType === FOLDER_MIME_TYPE));
    } catch {
      setUploadPickerFolders([]);
    }
    setUploadPickerLoading(false);
  };

  const confirmUploadDestination = () => {
    setShowUploadPicker(false);
    fileInputRef.current?.click();
  };

  const openContextDrivePicker = async () => {
    setShowContextDrivePicker(true);
    setContextDriveLoading(true);
    setContextDriveSelectedIds([]);
    try {
      const rootFiles = await fetchFiles(patient.id);
      setContextDriveFiles(rootFiles);
    } catch (err) {
      onToast(getErrorMessage(err), 'error');
      setContextDriveFiles([]);
    }
    setContextDriveLoading(false);
  };

  const toggleContextDriveSelection = (fileId: string) => {
    setContextDriveSelectedIds(prev =>
      prev.includes(fileId) ? prev.filter(id => id !== fileId) : [...prev, fileId]
    );
  };

  const applyContextDriveSelection = () => {
    const selectedFiles = contextDriveFiles.filter(
      (file) => contextDriveSelectedIds.includes(file.id) && !isFolder(file)
    );
    if (selectedFiles.length === 0) {
      setShowContextDrivePicker(false);
      return;
    }
    const fileList = selectedFiles.map((f) => `- ${f.name}`).join('\n');
    const prefix = 'Files to review:\n';
    setConsultContext((prev) =>
      prev ? `${prev}\n\n${prefix}${fileList}` : `${prefix}${fileList}`
    );
    setShowContextDrivePicker(false);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    const file = e.target.files[0];
    const targetId = uploadTargetFolderId;

    setStatus(AppStatus.UPLOADING);
    setUploadProgress(10);
    setUploadMessage(`Uploading ${file.name}...`);

    // Track interval in a ref so it's cleaned up on unmount
    if (uploadIntervalRef.current) clearInterval(uploadIntervalRef.current);
    uploadIntervalRef.current = setInterval(() => {
      setUploadProgress(prev => (prev >= 90 ? 90 : prev + 10));
    }, 200);

    await new Promise(r => setTimeout(r, 2000));
    if (uploadIntervalRef.current) {
      clearInterval(uploadIntervalRef.current);
      uploadIntervalRef.current = null;
    }
    setUploadProgress(100);

    setStatus(AppStatus.ANALYZING);
    setUploadMessage(null);

    const performUpload = async (base64?: string) => {
      let finalName = file.name;
      try {
        if (base64 && file.type.startsWith('image/')) {
          setUploadMessage("HALO is analyzing visual features...");
          finalName = await analyzeAndRenameImage(base64);
          setUploadMessage(`AI Renamed: ${finalName}`);
        }
      } catch {
        // AI rename not available
      }

      try {
        const uploaded = await uploadFile(targetId, file, finalName);
        await loadFolderContents(currentFolderId);
        onToast(`File uploaded to "${uploadTargetLabel}".`, 'success');

        // Best-effort: ask Gemini to describe the uploaded file for future context
        try {
          const description = await describeFile(patient.id, uploaded);
          if (description && description.trim()) {
            setConsultContext(prev =>
              prev
                ? `${prev}\n\n${uploaded.name} — AI description:\n${description}`
                : `${uploaded.name} — AI description:\n${description}`
            );
          }
        } catch {
          // Description is optional; ignore failures
        }
      } catch (err) {
        onToast(getErrorMessage(err), 'error');
      }
      setStatus(AppStatus.IDLE);
    };

    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = (reader.result as string).split(',')[1];
        performUpload(base64);
      };
      reader.readAsDataURL(file);
    } else {
      performUpload();
    }

    e.target.value = '';
  };

  useEffect(() => {
    if (propTemplateId) setTemplateId(propTemplateId);
  }, [propTemplateId]);

  const handleNoteChange = useCallback((noteIndex: number, updates: { title?: string; content?: string; fields?: NoteField[] }) => {
    setNotes(prev => prev.map((n, i) => i !== noteIndex ? n : {
      ...n,
      ...(updates.title !== undefined && { title: updates.title }),
      ...(updates.content !== undefined && { content: updates.content }),
      ...(updates.fields !== undefined && { fields: updates.fields }),
      dirty: true,
    }));
  }, []);

  const buildNoteFileName = useCallback(
    (tplId: string | undefined, fallbackTitle: string) => {
      const today = new Date();
      const dateStr = today.toISOString().slice(0, 10);
      const templateName =
        templateOptions.find(t => t.id === tplId)?.name ||
        tplId ||
        fallbackTitle ||
        'Note';
      const raw = `${patient.name} - ${dateStr} - ${templateName}`;
      return raw.replace(/[^\w\s-]/g, '').trim() || undefined;
    },
    [patient.name, templateOptions]
  );

  const handleSaveAsDocx = useCallback(async (noteIndex: number) => {
    const note = notes[noteIndex];
    const text = note ? getNoteText(note) : '';
    if (!text.trim()) return;
    setSavingNoteIndex(noteIndex);
    setStatus(AppStatus.SAVING);
    try {
      const tplId = note.template_id || templateId;
      const fileName = buildNoteFileName(tplId, note.title || 'Note');
      await saveNoteAsDocx({
        patientId: patient.id,
        template_id: tplId,
        text,
        fileName,
        user_id: getHaloUserForTemplate(tplId),
      });
      setNotes(prev => prev.map((n, i) => i !== noteIndex ? n : { ...n, lastSavedAt: new Date().toISOString(), dirty: false }));
      await loadFolderContents(currentFolderId);
      onDataChange();
      onToast('Note saved as DOCX to Patient Notes folder.', 'success');
    } catch (err) {
      onToast(getErrorMessage(err), 'error');
    }
    setSavingNoteIndex(null);
    setStatus(AppStatus.IDLE);
  }, [notes, patient.id, templateId, currentFolderId, loadFolderContents, onDataChange, onToast, buildNoteFileName]);

  const handleSaveAll = useCallback(async () => {
    setStatus(AppStatus.SAVING);
    let saved = 0;
    try {
      for (let i = 0; i < notes.length; i++) {
        const note = notes[i];
        const text = getNoteText(note);
        if (!text.trim()) continue;
        const tplId = note.template_id || templateId;
        const fileName = buildNoteFileName(tplId, note.title || `Note ${i + 1}`);
        await saveNoteAsDocx({
          patientId: patient.id,
          template_id: tplId,
          text,
          fileName,
          user_id: getHaloUserForTemplate(tplId),
        });
        setNotes(prev => prev.map((n, j) => j !== i ? n : { ...n, lastSavedAt: new Date().toISOString(), dirty: false }));
        saved++;
      }
      if (saved > 0) {
        await loadFolderContents(currentFolderId);
        onDataChange();
        onToast(`Saved ${saved} note(s) as DOCX.`, 'success');
      }
    } catch (err) {
      onToast(getErrorMessage(err), 'error');
    }
    setStatus(AppStatus.IDLE);
  }, [notes, patient.id, templateId, currentFolderId, loadFolderContents, onDataChange, onToast, buildNoteFileName]);

  const handleEmail = useCallback((_noteIndex: number) => {
    onToast('Email not implemented yet.', 'info');
  }, [onToast]);

  const GENERATE_TIMEOUT_MS = 95_000;

  const generateNotesFromTranscript = useCallback(
    async (transcriptToUse: string, isAddNote: boolean) => {
      const trimmedTranscript = transcriptToUse.trim();
      if (selectedTemplatesForGenerate.length === 0) {
        onToast('Select at least one template.', 'info');
        return;
      }
      if (!trimmedTranscript) {
        onToast('No transcript to generate from. Use the Scribe to dictate first.', 'info');
        return;
      }
      setPendingTranscript(null);
      setShowAddNoteModal(false);
      setIsGeneratingNotes(true);
      setNoteGenerationStep(0);
      const templateIds = selectedTemplatesForGenerate;
      const templateNames = Object.fromEntries(templateOptions.map(t => [t.id, t.name]));
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Note generation is taking too long. Please try again.')), GENERATE_TIMEOUT_MS)
      );
      try {
        const results = await Promise.race([
          Promise.all(
            templateIds.map(id =>
              generateNotePreview({
                template_id: id,
                text: trimmedTranscript,
                user_id: getHaloUserForTemplate(id),
              })
            )
          ),
          timeoutPromise,
        ]);
        const combined: HaloNote[] = results.map((res, i) => {
          const tid = templateIds[i];
          const name = templateNames[tid] ?? tid;
          const first = res.notes?.[0];
          const fromFields =
            first?.fields && first.fields.length > 0
              ? first.fields
                  .map((f) => (f.label ? `${f.label}:\n${f.body ?? ''}` : f.body))
                  .filter(Boolean)
                  .join('\n\n')
              : '';
          const content =
            first?.content?.trim() ||
            fromFields ||
            (first?.raw ? JSON.stringify(first.raw, null, 2) : '');
          return {
            noteId: first?.noteId ?? `note-${tid}-${Date.now()}`,
            title: (first?.title && String(first.title).trim()) ? String(first.title) : name,
            content,
            template_id: tid,
            lastSavedAt: new Date().toISOString(),
            dirty: false,
            ...(first?.fields && first.fields.length > 0 ? { fields: first.fields } : {}),
            ...(first?.raw ? { raw: first.raw } : {}),
          };
        });
        if (isAddNote) {
          setNotes(prev => [...prev, ...combined]);
          setActiveNoteIndex(notes.length);
          setConsultSubTab(notes.length);
        } else {
          setLastTranscript(trimmedTranscript);
          setNotes(combined);
          setActiveNoteIndex(0);
          setConsultSubTab(0);
        }

        // Persist this consultation as a scribe session for this patient (including generated note content)
        try {
          const firstNoteContent = combined[0]?.content ?? '';
          const mainComplaint = extractMainComplaint(firstNoteContent);
          const payload = {
            sessionId: activeSessionId || undefined,
            transcript: trimmedTranscript,
            context: consultContext || undefined,
            templates: templateIds,
            noteTitles: combined.map((n) => n.title).filter(Boolean),
            notes: combined.map((n) => ({
              noteId: n.noteId,
              title: n.title,
              content: n.content,
              template_id: n.template_id,
            })),
            ...(mainComplaint ? { mainComplaint } : {}),
          };
          const res = await savePatientSession(patient.id, payload);
          const items = Array.isArray(res.sessions) ? res.sessions : [];
          const sorted = [...items].sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1));
          setSessions(sorted);
          setActiveSessionId(sorted[0]?.id ?? null);
        } catch {
          // Session history is best-effort; ignore failures
        }

        onToast(`Generated ${combined.length} note(s). You can edit and save as DOCX.`, 'success');
      } catch (err) {
        onToast(getErrorMessage(err), 'error');
      }
      setIsGeneratingNotes(false);
      setNoteGenerationStep(0);
    },
    [
      GENERATE_TIMEOUT_MS,
      activeSessionId,
      consultContext,
      onToast,
      patient.id,
      selectedTemplatesForGenerate,
      templateOptions,
    ]
  );

  const handleScribeResult = useCallback(
    (transcript: string) => {
      const clean = transcript.trim();
      if (!clean) {
        onToast('No speech detected.', 'info');
        return;
      }
      const base = lastTranscript.trim();
      const combined = base ? `${base}\n\n${clean}` : clean;
      setLastTranscript(combined);
      setLiveTranscriptSegment('');
      setPendingTranscript(combined);
      setSelectedTemplatesForGenerate(['clinical_note']);
      setActiveTab('notes');
    },
    [lastTranscript, onToast]
  );

  const handleLiveTranscriptUpdate = useCallback((segment: string) => {
    // While recording, keep the live segment separate so we can append it
    // to any existing transcript once the doctor stops the recording.
    setIsLiveStreaming(true);
    setLiveTranscriptSegment(segment);
  }, []);

  const handleLiveStopped = useCallback(
    (transcript: string) => {
      setIsLiveStreaming(false);
      setLiveTranscriptSegment('');

      const clean = transcript.trim();
      if (!clean) {
        return;
      }

      const base = lastTranscript.trim();
      const isResume = notes.length > 0 || !!activeSessionId;

      let combined: string;
      if (isResume && base) {
        const timestamp = new Date().toLocaleString();
        const header = `\n\n[Consultation resumed ${timestamp}]\n\n`;
        combined = `${base}${header}${clean}`;
      } else if (base) {
        combined = `${base}\n\n${clean}`;
      } else {
        combined = clean;
      }

      setLastTranscript(combined);

      if (isResume) {
        setPendingTranscript(null);
        setActiveTab('notes');
        void generateNotesFromTranscript(combined, false);
      } else {
        setPendingTranscript(combined);
        setSelectedTemplatesForGenerate(['clinical_note']);
        setActiveTab('notes');
      }
    },
    [activeSessionId, generateNotesFromTranscript, lastTranscript, notes.length]
  );

  const toggleTemplateForGenerate = useCallback((id: string) => {
    setSelectedTemplatesForGenerate(prev =>
      prev.includes(id) ? prev.filter(t => t !== id) : [...prev, id]
    );
  }, []);

  const selectAllTemplatesForGenerate = useCallback(() => {
    setSelectedTemplatesForGenerate(templateOptions.map(t => t.id));
  }, [templateOptions]);
  const NOTE_GENERATION_STEPS = [
    'Looking at context',
    'Decoding transcript',
    'Analyzing transcript',
    'Perfecting your style',
    'Making your notes',
  ] as const;

  const handleGenerateFromTemplates = useCallback(async () => {
    const sourceTranscript = (pendingTranscript ?? lastTranscript) || '';
    const isAddNote = showAddNoteModal;
    await generateNotesFromTranscript(sourceTranscript, isAddNote);
  }, [generateNotesFromTranscript, lastTranscript, pendingTranscript, showAddNoteModal]);

  // Autosave: every 30s mark dirty notes as saved (client-side only; no DOCX generation)
  useEffect(() => {
    if (notes.length === 0) return;
    const interval = setInterval(() => {
      setNotes(prev => {
        const hasDirty = prev.some(n => n.dirty);
        if (!hasDirty) return prev;
        return prev.map(note => note.dirty ? { ...note, lastSavedAt: new Date().toISOString(), dirty: false } : note);
      });
    }, 30_000);
    return () => clearInterval(interval);
  }, [notes.length]);

  // Chat handler — uses streaming for progressive response display
  const handleSendChat = async () => {
    const question = chatInput.trim();
    if (!question || chatLoading) return;

    const userMessage: ChatMessage = { role: 'user', content: question, timestamp: Date.now() };
    setChatMessages(prev => [...prev, userMessage]);
    setChatInput("");
    setChatLoading(true);
    setChatLongWait(false);

    if (chatLongWaitTimerRef.current) clearTimeout(chatLongWaitTimerRef.current);
    chatLongWaitTimerRef.current = setTimeout(() => setChatLongWait(true), 8000);

    const assistantPlaceholder: ChatMessage = { role: 'assistant', content: '', timestamp: Date.now() };
    setChatMessages(prev => [...prev, assistantPlaceholder]);

    try {
      await askHaloStream(
        patient.id,
        question,
        chatMessagesRef.current,
        (chunk) => {
          setChatMessages(prev => {
            const last = prev[prev.length - 1];
            if (last?.role === 'assistant') {
              return [...prev.slice(0, -1), { ...last, content: last.content + chunk }];
            }
            return prev;
          });
        }
      );
    } catch (err) {
      setChatMessages(prev => {
        const last = prev[prev.length - 1];
        if (last?.role === 'assistant' && last.content === '') {
          return [...prev.slice(0, -1), {
            ...last,
            content: 'Sorry, I encountered an error. Please try again.',
          }];
        }
        return prev;
      });
      onToast(getErrorMessage(err), 'error');
    } finally {
      setChatLoading(false);
      setChatLongWait(false);
      if (chatLongWaitTimerRef.current) {
        clearTimeout(chatLongWaitTimerRef.current);
        chatLongWaitTimerRef.current = null;
      }
    }
  };

  const handleUseLatestTranscriptForAssistant = () => {
    if (!currentTranscript.trim()) {
      onToast('No transcript available yet. Record or upload first.', 'info');
      return;
    }
    setAssistantInput(currentTranscript);
    setActiveTab('assistant');
  };

  const handleSendAssistant = async () => {
    const requestText = assistantInput.trim();
    if (!requestText || assistantLoading) return;

    const userMessage: ChatMessage = { role: 'user', content: requestText, timestamp: Date.now() };
    setAssistantMessages(prev => [...prev, userMessage]);
    setAssistantInput('');
    setAssistantLoading(true);
    setAssistantLongWait(false);

    if (assistantLongWaitTimerRef.current) clearTimeout(assistantLongWaitTimerRef.current);
    assistantLongWaitTimerRef.current = setTimeout(() => setAssistantLongWait(true), 8000);

    try {
      const result = await orchestrateAssistant(
        patient.id,
        requestText,
        assistantMessagesRef.current,
        consultContext?.trim() || undefined
      );
      setAssistantLatestResult(result);
      const assistantText =
        `Drafted ${result.placeholders.DOCUMENT_TYPE} for ${result.placeholders.NAME} (${result.placeholders.DOB}).\n\n` +
        `${result.documentBody}\n\n` +
        (result.tasks.length ? `Tasks:\n- ${result.tasks.join('\n- ')}` : 'No explicit follow-up tasks.');
      setAssistantMessages(prev => [...prev, { role: 'assistant', content: assistantText, timestamp: Date.now() }]);
      if (result.warnings.length > 0) {
        onToast(`Assistant warnings: ${result.warnings[0]}`, 'info');
      }
    } catch (err) {
      onToast(getErrorMessage(err), 'error');
      setAssistantMessages(prev => [...prev, {
        role: 'assistant',
        content: 'Assistant failed to process the request. Please try again with clearer dictation.',
        timestamp: Date.now(),
      }]);
    } finally {
      setAssistantLoading(false);
      setAssistantLongWait(false);
      if (assistantLongWaitTimerRef.current) {
        clearTimeout(assistantLongWaitTimerRef.current);
        assistantLongWaitTimerRef.current = null;
      }
    }
  };

  const handleGenerateAssistantDocx = async () => {
    if (!assistantLatestResult?.documentBody?.trim()) {
      onToast('No assistant document body available yet.', 'info');
      return;
    }
    setAssistantDocSaving(true);
    try {
      const rawDocType = (assistantLatestResult.placeholders.DOCUMENT_TYPE || 'Clinical Note').replace(/[^\w\s-]/g, '').trim();
      const docType = rawDocType && rawDocType.toLowerCase() !== 'other' ? rawDocType : 'Clinical Note';
      const name = (assistantLatestResult.placeholders.NAME || patient.name).replace(/[^\w\s-]/g, '').trim();
      const date = (assistantLatestResult.placeholders.DATE || new Date().toISOString().slice(0, 10)).replace(/[^\d-]/g, '');
      const fileName = `${docType || 'Clinical Note'} - ${name || patient.name} - ${date || new Date().toISOString().slice(0, 10)}.docx`;

      const docxRes = await saveNoteAsDocx({
        patientId: patient.id,
        template_id: templateId || 'clinical_note',
        text: assistantLatestResult.documentBody,
        fileName,
        useLetterhead: true,
        letterheadPlaceholders: assistantLatestResult.placeholders,
        letterheadDriveFileId,
      });
      await loadFolderContents(currentFolderId);
      onDataChange();
      if (docxRes.letterheadWarning) {
        onToast(docxRes.letterheadWarning, 'info');
      } else {
        onToast('Assistant DOCX generated and saved to this patient folder.', 'success');
      }
    } catch (err) {
      onToast(getErrorMessage(err), 'error');
    } finally {
      setAssistantDocSaving(false);
    }
  };

  // If opened from a calendar booking, generate a light prep note and start in the editor
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!calendarPrepEvent || calendarPrepEvent.patientId !== patient.id) return;
      if (notes.length > 0) return; // don’t overwrite existing work

      setActiveTab('notes');
      setStatus(AppStatus.LOADING);
      try {
        const { prepNote } = await generatePrepNote(patient.id, patient.name);
        if (cancelled) return;
        const title = calendarPrepEvent.title || `Prep for ${patient.name}`;
        const newNote: HaloNote = {
          noteId: `prep-${Date.now()}`,
          title,
          content: prepNote,
          template_id: templateId,
          lastSavedAt: new Date().toISOString(),
          dirty: true,
        };
        setNotes([newNote]);
        setActiveNoteIndex(0);
        setUploadMessage(null);
      } catch (err) {
        if (!cancelled) onToast(getErrorMessage(err), 'error');
      }
      if (!cancelled) setStatus(AppStatus.IDLE);
    };
    run();
    return () => { cancelled = true; };
  }, [calendarPrepEvent?.id, calendarPrepEvent?.patientId, calendarPrepEvent?.title, patient.id, patient.name, templateId, notes.length, onToast]);

  // Create folder handler
  const handleCreateFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    try {
      await createFolder(currentFolderId, name);
      setShowCreateFolderModal(false);
      setNewFolderName("");
      await loadFolderContents(currentFolderId);
      onToast(`Folder "${name}" created.`, 'success');
    } catch (err) {
      onToast(getErrorMessage(err), 'error');
    }
  };

  const startEditPatient = () => {
    setEditName(patient.name);
    setEditDob(patient.dob);
    setEditSex(patient.sex || 'M');
    setEditingPatient(true);
  };

  const savePatientEdit = async () => {
    if (!editName.trim() || !editDob) return;
    try {
      await updatePatient(patient.id, { name: editName, dob: editDob, sex: editSex });
      setEditingPatient(false);
      onDataChange();
      onToast('Patient details updated.', 'success');
    } catch (err) {
      onToast(getErrorMessage(err), 'error');
    }
  };

  const startEditFile = (file: DriveFile) => {
    setEditingFile(file);
    setEditFileName(file.name);
  };

  const saveFileEdit = async () => {
    if (!editingFile || !editFileName.trim()) return;
    try {
      await updateFileMetadata(patient.id, editingFile.id, editFileName);

      const crumbIndex = breadcrumbs.findIndex(b => b.id === editingFile.id);
      if (crumbIndex >= 0) {
        setBreadcrumbs(prev => prev.map((b, i) => i === crumbIndex ? { ...b, name: editFileName } : b));
      }

      setEditingFile(null);
      await loadFolderContents(currentFolderId);
      onDataChange();
      onToast('Item renamed.', 'success');
    } catch (err) {
      onToast(getErrorMessage(err), 'error');
    }
  };

  const confirmDeleteFile = async () => {
    if (!fileToDelete) return;
    try {
      await deleteFile(fileToDelete.id);
      setFileToDelete(null);
      await loadFolderContents(currentFolderId);
      onToast('File moved to trash.', 'success');
    } catch (err) {
      onToast(getErrorMessage(err), 'error');
    }
  };

  const hasAiContent = alerts.length > 0 || summary.length > 0;

  const handleGenerateAiInsights = useCallback(async () => {
    if (aiLoading) return;
    if (!files.length) {
      onToast('No patient files available to analyze yet.', 'info');
      return;
    }
    setAiLoading(true);
    try {
      const currentFiles = [...files];
      const summaryResult = await generatePatientSummary(patient.name, currentFiles, patient.id);
      setSummary(summaryResult);

      const labFiles = currentFiles.filter(f =>
        f.name.toLowerCase().includes('lab') ||
        f.name.toLowerCase().includes('blood') ||
        f.name.toLowerCase().includes('result')
      );
      if (labFiles.length > 0) {
        const labContext = labFiles.map(f => f.name).join(', ');
        const alertsResult = await extractLabAlerts(`Patient files indicate lab results: ${labContext}`);
        setAlerts(alertsResult);
      } else {
        setAlerts([]);
      }
      setShowAiPanel(true);
    } catch (err) {
      onToast(getErrorMessage(err), 'error');
    }
    setAiLoading(false);
  }, [aiLoading, files, patient.name, patient.id, onToast]);

  const handleCopyTranscript = useCallback(() => {
    const text = currentTranscript.trim();
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(text)
        .then(() => {
          setDidCopyTranscript(true);
          setTimeout(() => setDidCopyTranscript(false), 1500);
        })
        .catch(() => {
          onToast('Unable to copy transcript to clipboard.', 'error');
        });
    } else {
      onToast('Copy is not supported in this browser.', 'error');
    }
  }, [currentTranscript, onToast]);

  const handleLoadSession = useCallback(
    (session: ScribeSession | null) => {
      // When selecting "Start new session" or clearing, reset to a blank editor state.
      if (!session) {
        setActiveSessionId(null);
        setLastTranscript('');
        setLiveTranscriptSegment('');
        setPendingTranscript(null);
        setShowAddNoteModal(false);
        setConsultContext('');
        setNotes([]);
        setConsultSubTab('transcript');
        setActiveTab('notes');
        return;
      }

      // Load the exact data that was stored for this session (no automatic regeneration).
      setActiveSessionId(session.id);
      const tx = session.transcript || '';
      setLastTranscript(tx);
      setLiveTranscriptSegment('');
      setPendingTranscript(null);
      setShowAddNoteModal(false);
      setConsultContext(session.context || '');

      if (Array.isArray(session.templates) && session.templates.length > 0) {
        setSelectedTemplatesForGenerate(session.templates);
      } else {
        setSelectedTemplatesForGenerate(['clinical_note']);
      }

      if (session.notes && session.notes.length > 0) {
        const restoredNotes: HaloNote[] = session.notes.map((n) => ({
          noteId: n.noteId,
          title: n.title,
          content: n.content,
          template_id: n.template_id,
          lastSavedAt: new Date().toISOString(),
          dirty: false,
        }));
        setNotes(restoredNotes);
        setActiveNoteIndex(0);
        setConsultSubTab(0);
      } else {
        setNotes([]);
        setConsultSubTab('transcript');
      }

      setActiveTab('notes');
    },
    []
  );

  useEffect(() => {
    if (!isGeneratingNotes) {
      setNoteGenerationStep(0);
      return;
    }
    setNoteGenerationStep(0);
    const lastIndex = NOTE_GENERATION_STEPS.length - 1;
    const stepMs = 2800;
    const id = setInterval(() => {
      setNoteGenerationStep(prev => {
        if (prev >= lastIndex) return prev;
        return prev + 1;
      });
    }, stepMs);
    return () => clearInterval(id);
  }, [isGeneratingNotes]);

  return (
    <div className="flex flex-col h-full bg-white relative w-full">
      {/* Header */}
      <div className="border-b border-slate-200 px-4 md:px-8 py-4 flex flex-col md:flex-row md:justify-between md:items-start bg-white shadow-sm z-10 gap-4">
        <div className="flex items-start gap-3">
          <button onClick={onBack} className="md:hidden mt-1 p-2 -ml-2 text-slate-500 hover:text-sky-600 rounded-full">
            <ChevronLeft className="w-6 h-6" />
          </button>
          <div className="group relative">
            <div className="flex items-center gap-2">
              <h1 className="text-2xl md:text-3xl font-bold text-slate-800 tracking-tight leading-tight">{patient.name}</h1>
              <button onClick={startEditPatient} className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 text-slate-400 hover:text-sky-600 hover:bg-slate-100 rounded-full">
                <Pencil size={16} />
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-slate-500 mt-2 font-medium">
              <span className="flex items-center gap-1.5 bg-slate-100 px-2 py-1 rounded text-slate-600 whitespace-nowrap"><Calendar className="w-3.5 h-3.5" /> {patient.dob}</span>
              <span className="flex items-center gap-1.5 bg-slate-100 px-2 py-1 rounded text-slate-600 whitespace-nowrap">Sex: {patient.sex || 'Unknown'}</span>
              <span className="flex items-center gap-1.5 bg-slate-100 px-2 py-1 rounded text-slate-600 whitespace-nowrap"><Clock className="w-3.5 h-3.5" /> Last: {patient.lastVisit}</span>
              <a
                href={`https://drive.google.com/drive/folders/${patient.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 bg-slate-100 px-2 py-1 rounded text-slate-600 whitespace-nowrap hover:bg-sky-100 hover:text-sky-700 transition-colors"
                title="Open patient folder in Google Drive"
              >
                <FolderOpen className="w-3.5 h-3.5" /> Open in Drive <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          </div>
        </div>

        <div className="flex flex-col items-center md:items-end gap-2 w-full md:w-auto">
          {status === AppStatus.UPLOADING ? (
            <div className="w-48">
              <div className="flex justify-between text-xs font-semibold text-sky-700 mb-1">
                <span>Uploading...</span><span>{uploadProgress}%</span>
              </div>
              <div className="w-full bg-slate-100 rounded-full h-2.5 overflow-hidden">
                <div className="bg-sky-500 h-2.5 rounded-full transition-all duration-300" style={{ width: `${uploadProgress}%` }}></div>
              </div>
            </div>
          ) : (
            <>
              <div className="flex flex-col md:flex-row items-stretch md:items-center gap-2">
                <HeaderConsultationRecorder
                  onLiveTranscriptUpdate={handleLiveTranscriptUpdate}
                  onLiveStopped={handleLiveStopped}
                  onError={(msg: string) => onToast(msg, 'error')}
                />
                <button
                  onClick={openUploadPicker}
                  className="w-full md:w-auto flex justify-center items-center gap-2 bg-sky-600 hover:bg-sky-700 text-white px-5 py-2.5 rounded-lg cursor-pointer transition-all shadow-md shadow-sky-600/20 text-sm font-semibold"
                >
                  <Upload className="w-4 h-4" /> Upload File
                </button>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                onChange={handleFileUpload}
                accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.txt"
              />
            </>
          )}
          {uploadMessage && status !== AppStatus.UPLOADING && (
            <div className="w-full md:w-auto flex items-center gap-2 text-xs font-semibold text-sky-700 bg-sky-50 border border-sky-200 px-3 py-1.5 rounded-md">
              <CheckCircle2 className="w-3.5 h-3.5" /> {uploadMessage}
            </div>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 md:p-8 bg-slate-50/50 flex flex-col min-h-0">
        <div className="w-full max-w-[1600px] mx-auto flex-1 flex flex-col min-h-0">
          {/* AI Panel */}
          {hasAiContent && showAiPanel && (
            <div className="mb-6 space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-400">AI Insights</span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleGenerateAiInsights}
                    disabled={aiLoading}
                    className="text-xs font-medium text-sky-600 hover:text-sky-700 flex items-center gap-1 transition-colors px-2 py-1 rounded hover:bg-sky-50 disabled:opacity-50"
                  >
                    {aiLoading ? 'Updating…' : 'Refresh'}
                  </button>
                  <button
                    onClick={() => setShowAiPanel(false)}
                    className="text-xs font-medium text-slate-400 hover:text-slate-600 flex items-center gap-1 transition-colors px-2 py-1 rounded hover:bg-slate-100"
                  >
                    <X size={12} /> Hide
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <SmartSummary summary={summary} loading={aiLoading} />
                {alerts.length > 0 && (
                  <div>
                    <LabAlerts alerts={alerts} />
                  </div>
                )}
              </div>
            </div>
          )}

          {/* CTA to generate insights (only when not yet generated) */}
          {!hasAiContent && (
            <div className="mb-4">
              <button
                onClick={handleGenerateAiInsights}
                disabled={aiLoading || status === AppStatus.LOADING}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-sky-50 hover:bg-sky-100 border border-sky-100 text-xs font-semibold text-sky-700 transition disabled:opacity-50"
              >
                {aiLoading ? 'Generating HALO AI insights…' : 'Generate HALO AI insights for this patient'}
              </button>
            </div>
          )}

          {/* Tabs */}
          <div className="flex gap-6 md:gap-8 border-b border-slate-200 mb-6 overflow-x-auto">
            <button onClick={() => setActiveTab('overview')} className={`pb-3 text-sm font-bold border-b-2 transition-colors uppercase tracking-wide whitespace-nowrap ${activeTab === 'overview' ? 'border-sky-600 text-sky-800' : 'border-transparent text-slate-400 hover:text-slate-600'}`}>Active Workspace</button>
            <button onClick={() => setActiveTab('notes')} className={`pb-3 text-sm font-bold border-b-2 transition-colors uppercase tracking-wide whitespace-nowrap ${activeTab === 'notes' ? 'border-sky-600 text-sky-800' : 'border-transparent text-slate-400 hover:text-slate-600'}`}>Editor &amp; Scribe</button>
            <button onClick={() => setActiveTab('chat')} className={`pb-3 text-sm font-bold border-b-2 transition-colors uppercase tracking-wide whitespace-nowrap flex items-center gap-1.5 ${activeTab === 'chat' ? 'border-sky-600 text-sky-800' : 'border-transparent text-slate-400 hover:text-slate-600'}`}>
              <MessageCircle size={14} /> Ask HALO
            </button>
            <button onClick={() => setActiveTab('assistant')} className={`pb-3 text-sm font-bold border-b-2 transition-colors uppercase tracking-wide whitespace-nowrap flex items-center gap-1.5 ${activeTab === 'assistant' ? 'border-sky-600 text-sky-800' : 'border-transparent text-slate-400 hover:text-slate-600'}`}>
              <Bot size={14} /> Assistant
            </button>
            <button onClick={() => setActiveTab('sessions')} className={`pb-3 text-sm font-bold border-b-2 transition-colors uppercase tracking-wide whitespace-nowrap flex items-center gap-1.5 ${activeTab === 'sessions' ? 'border-sky-600 text-sky-800' : 'border-transparent text-slate-400 hover:text-slate-600'}`}>
              <History size={14} /> Previous Sessions
            </button>
          </div>

          {activeTab === 'overview' ? (
            <FileBrowser
              files={files}
              status={status}
              breadcrumbs={breadcrumbs}
              onNavigateToFolder={navigateToFolder}
              onNavigateBack={navigateBack}
              onNavigateToBreadcrumb={navigateToBreadcrumb}
              onStartEditFile={startEditFile}
              onDeleteFile={setFileToDelete}
              onViewFile={setViewingFile}
              onCreateFolder={() => setShowCreateFolderModal(true)}
            />
          ) : activeTab === 'sessions' ? (
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-200 bg-slate-50/80">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  Previous Sessions
                </span>
                <p className="text-xs text-slate-500 mt-1">
                  Click a session to open it in the Editor &amp; Scribe workspace and view or edit the generated notes.
                </p>
              </div>
              <div className="p-4">
                {sessionsLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="w-8 h-8 text-sky-500 animate-spin" />
                  </div>
                ) : sessions.length === 0 ? (
                  <p className="text-sm text-slate-500 py-8 text-center">
                    No previous sessions yet for this patient. Record a consultation and generate notes from the Editor &amp; Scribe tab.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {sessions.map((session) => {
                      const createdDate = session.createdAt ? new Date(session.createdAt) : null;
                      const formattedDate = createdDate
                        ? createdDate.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })
                        : 'Unknown date';
                      const mainComplaint =
                        session.mainComplaint?.trim() ||
                        (session.notes && session.notes.length > 0
                          ? extractMainComplaint(session.notes[0].content)
                          : '');
                      const listTitle = mainComplaint
                        ? `${formattedDate}, ${mainComplaint}`
                        : formattedDate;
                      const hasNotes = session.notes && session.notes.length > 0;
                      const labelTime = createdDate
                        ? createdDate.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
                        : '';
                      return (
                        <li key={session.id}>
                          <button
                            type="button"
                            onClick={() => handleLoadSession(session)}
                            className="w-full flex items-center justify-between gap-4 px-4 py-3 rounded-xl border border-slate-200 bg-white text-left hover:bg-sky-50 hover:border-sky-200 transition-colors group"
                          >
                            <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                              <span className="font-medium text-slate-800 truncate">{listTitle}</span>
                              <span className="text-xs text-slate-500">
                                {labelTime ? `${labelTime}` : ''}
                                {hasNotes ? ` • ${session.notes!.length} note(s)` : ' • transcript only'}
                              </span>
                            </div>
                            <ChevronRight className="w-5 h-5 text-slate-400 group-hover:text-sky-600 shrink-0" />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          ) : activeTab === 'notes' ? (
            <>
            <div className="flex flex-col flex-1 min-h-[480px]">
              <div className="mb-3 flex-shrink-0 flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => handleLoadSession(null)}
                  className="text-xs font-medium text-sky-600 hover:text-sky-700 flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-sky-200 bg-sky-50/80 hover:bg-sky-50 transition"
                >
                  <Plus className="w-3.5 h-3.5" /> Start new session
                </button>
                <span className="text-[11px] text-slate-400">
                  {activeSessionId ? 'Viewing a previous session' : 'Current session'}
                </span>
              </div>

              {/* Current session: transcript when modal is open, or main content when not — fills remaining space */}
              <div className="flex-1 min-h-0 flex flex-col bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden relative">
                {pendingTranscript ? (
                  /* Transcript visible in background while template modal is open */
                  <div className="flex-1 flex flex-col p-4 overflow-auto bg-slate-50">
                    <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Transcript preview</p>
                    <p className="text-sm text-slate-600 whitespace-pre-wrap">{pendingTranscript}</p>
                  </div>
                ) : notes.length === 0 ? (
                  <div className="flex-1 flex items-center justify-center text-slate-400">
                    <p className="text-sm">
                      {isGeneratingNotes
                        ? 'HALO is generating your notes. You can switch to the Transcript tab to review while you wait.'
                        : 'No notes yet. Use the Scribe to dictate, then choose templates to generate notes.'}
                    </p>
                  </div>
                ) : (
                  <>
                    {/* Consult tab bar: Context | Transcript | note tabs | + */}
                    <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-slate-200 bg-slate-50/80">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mr-1">
                        Consultation
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setConsultSubTab('context');
                        }}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all border ${
                          consultSubTab === 'context'
                            ? 'bg-slate-900 text-slate-50 border-slate-900 shadow-sm'
                            : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-100 hover:border-slate-300'
                        }`}
                      >
                        <Layers className="w-3.5 h-3.5" /> Context
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setConsultSubTab('transcript');
                        }}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all border ${
                          consultSubTab === 'transcript'
                            ? 'bg-slate-900 text-slate-50 border-slate-900 shadow-sm'
                            : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-100 hover:border-slate-300'
                        }`}
                      >
                        <FileText className="w-3.5 h-3.5" /> Transcript
                      </button>
                      <div className="w-px h-6 bg-slate-200 mx-1" />
                      {notes.map((note, i) => (
                        <button
                          key={note.noteId}
                          type="button"
                          onClick={() => {
                            setConsultSubTab(i);
                            setActiveNoteIndex(i);
                          }}
                          className={`flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-medium transition-all border ${
                            consultSubTab === i
                              ? 'bg-sky-50 border-sky-300 text-sky-800 shadow-sm'
                              : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-100 hover:border-slate-300'
                          }`}
                        >
                          <FileText className="w-3.5 h-3.5" /> {note.title || `Note ${i + 1}`}
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() => {
                          setShowAddNoteModal(true);
                          setSelectedTemplatesForGenerate(['clinical_note']);
                        }}
                        className="flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-medium bg-white border border-slate-200 text-slate-600 hover:bg-slate-100 hover:border-sky-300 hover:text-sky-700 transition-all"
                        title="Add note or draft new letter"
                      >
                        <Plus className="w-4 h-4" />
                      </button>
                    </div>
                    {/* Tab content */}
                    {consultSubTab === 'transcript' ? (
                      <div className="flex-1 overflow-auto bg-slate-50/60 p-4">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex flex-col">
                            <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
                              Transcript
                            </p>
                            {isLiveStreaming && (
                              <p className="text-[11px] text-emerald-600 font-medium mt-0.5">
                                Live transcription in progress…
                              </p>
                            )}
                          </div>
                          <button
                            type="button"
                            onClick={handleCopyTranscript}
                            disabled={!currentTranscript.trim()}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-slate-200 bg-white text-[11px] font-medium text-slate-600 hover:bg-slate-100 hover:border-slate-300 disabled:opacity-40 disabled:cursor-not-allowed transition"
                          >
                            {didCopyTranscript ? 'Copied' : 'Copy'}
                          </button>
                        </div>
                        <div className="h-full min-h-[260px] rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 whitespace-pre-wrap overflow-y-auto">
                          {currentTranscript || 'No transcript yet. Start a live consultation to see text appear here.'}
                        </div>
                      </div>
                    ) : consultSubTab === 'context' ? (
                      <div className="flex-1 overflow-auto bg-slate-50/60 p-4">
                        <div className="flex flex-col gap-2 mb-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex flex-col">
                              <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
                                Context
                              </p>
                              <p className="text-[11px] text-slate-500">
                                Add any additional context about the patient or paste key details here. This panel mirrors the
                                free-form context area from your favourite scribe.
                              </p>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <button
                                type="button"
                                onClick={handleContextUploadClick}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-slate-200 bg-white text-[11px] font-medium text-slate-600 hover:bg-slate-100 hover:border-slate-300 transition"
                              >
                                <CloudUpload className="w-3.5 h-3.5" /> Upload from computer
                              </button>
                              <button
                                type="button"
                                onClick={openContextDrivePicker}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-slate-200 bg-white text-[11px] font-medium text-slate-600 hover:bg-slate-100 hover:border-slate-300 transition"
                              >
                                <FolderOpen className="w-3.5 h-3.5" /> Add from Drive
                              </button>
                            </div>
                          </div>
                        </div>
                        <textarea
                          value={consultContext}
                          onChange={e => setConsultContext(e.target.value)}
                          rows={8}
                          placeholder="e.g. Presenting complaint, key differentials you’re considering, or anything you’d like HALO to keep in mind."
                          className="w-full h-full min-h-[260px] resize-none rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 placeholder-slate-400 focus:border-sky-500 focus:ring-2 focus:ring-sky-100 outline-none"
                        />
                      </div>
                    ) : typeof consultSubTab === 'number' ? (
                      <NoteEditor
                        notes={notes}
                        activeIndex={consultSubTab}
                        onActiveIndexChange={(i) => { setConsultSubTab(i); setActiveNoteIndex(i); }}
                        onNoteChange={handleNoteChange}
                        status={status}
                        templateId={templateId}
                        templateOptions={templateOptions}
                        onTemplateChange={setTemplateId}
                        onSaveAsDocx={handleSaveAsDocx}
                        onSaveAll={handleSaveAll}
                        onEmail={handleEmail}
                        savingNoteIndex={savingNoteIndex}
                        showNoteTabs={false}
                      />
                    ) : null}
                  </>
                )}
              </div>
            </div>

              {/* Template choice modal — when new transcript or "+" add note; hide while generating */}
              {(pendingTranscript != null || showAddNoteModal) && !isGeneratingNotes && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4">
                  <div
                    className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-xl overflow-hidden"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="template-modal-title"
                  >
                    <div className="px-6 pt-5 pb-3 border-b border-slate-100">
                      <h3 id="template-modal-title" className="text-base font-bold text-slate-900 mb-1">
                        {showAddNoteModal ? 'Add note templates' : 'Choose note templates'}
                      </h3>
                      <p className="text-xs text-slate-500">
                        Select which note types to generate from your dictation. Each will appear as a separate tab for editing.
                      </p>
                    </div>
                    <div className="px-6 pb-6 pt-4 space-y-4">
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={templateSearch}
                          onChange={e => setTemplateSearch(e.target.value)}
                          placeholder="Search or filter templates..."
                          className="flex-1 px-3 py-2 rounded-xl border border-slate-200 bg-slate-50 text-sm text-slate-800 placeholder-slate-400 focus:bg-white focus:border-sky-500 focus:ring-2 focus:ring-sky-100 outline-none"
                        />
                      </div>
                      <div className="max-h-72 overflow-y-auto rounded-xl border border-slate-100 bg-slate-50/60 divide-y divide-slate-100">
                        {templateOptions
                          .filter(t => {
                            if (!templateSearch.trim()) return true;
                            const q = templateSearch.toLowerCase();
                            return t.name.toLowerCase().includes(q) || t.id.toLowerCase().includes(q);
                          })
                          .map(t => {
                            const selected = selectedTemplatesForGenerate.includes(t.id);
                            return (
                              <button
                                key={t.id}
                                type="button"
                                onClick={() => toggleTemplateForGenerate(t.id)}
                                className={`w-full px-4 py-3 flex items-center justify-between text-sm font-medium transition-all ${
                                  selected
                                    ? 'bg-white text-sky-800'
                                    : 'bg-transparent text-slate-700 hover:bg-white'
                                }`}
                              >
                                <span className="flex items-center gap-2">
                                  <span
                                    className={`w-2 h-2 rounded-full ${
                                      selected ? 'bg-sky-500' : 'bg-slate-300'
                                    }`}
                                  />
                                  <span>{t.name}</span>
                                </span>
                                {selected && (
                                  <span className="text-[11px] font-semibold text-sky-600 uppercase tracking-wide">
                                    Selected
                                  </span>
                                )}
                              </button>
                            );
                          })}
                        {templateOptions.length === 0 && (
                          <div className="px-4 py-6 text-xs text-slate-500 text-center">
                            No templates available. HALO will fall back to the default clinical note.
                          </div>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-2 pt-2">
                        <button
                          type="button"
                          onClick={selectAllTemplatesForGenerate}
                          className="px-4 py-2 rounded-xl text-sm font-medium bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 hover:border-slate-300 transition shadow-sm"
                        >
                          Select all
                        </button>
                        <button
                          type="button"
                          onClick={handleGenerateFromTemplates}
                          disabled={selectedTemplatesForGenerate.length === 0 || isGeneratingNotes}
                          className="px-4 py-2 rounded-xl text-sm font-bold bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50 disabled:cursor-not-allowed transition shadow-sm border border-sky-600"
                        >
                          {isGeneratingNotes
                            ? 'Generating…'
                            : showAddNoteModal
                              ? `Add ${selectedTemplatesForGenerate.length} note(s)`
                              : `Generate ${selectedTemplatesForGenerate.length} note(s)`}
                        </button>
                        <button
                          type="button"
                          onClick={() => { setPendingTranscript(null); setShowAddNoteModal(false); }}
                          className="px-4 py-2 rounded-xl text-sm font-medium bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 hover:border-slate-300 transition shadow-sm"
                        >
                          Cancel
                        </button>
                      </div>
                      <div className="mt-4 pt-4 border-t border-slate-100 space-y-3">
                        <p className="text-xs font-semibold text-slate-500">
                          Need a different kind of letter or motivation?
                        </p>
                        <p className="text-xs text-slate-500 mb-1">
                          Ask HALO to draft a new note (e.g. a motivation letter) based on this patient&rsquo;s documentation and transcript.
                        </p>
                        <button
                          type="button"
                          onClick={() => {
                            setShowAddNoteModal(false);
                            setShowCustomAiNoteModal(true);
                            setCustomAiPrompt('');
                          }}
                          className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium bg-white border border-sky-200 text-sky-700 hover:bg-sky-50 hover:border-sky-300 transition shadow-sm"
                        >
                          <MessageCircle className="w-4 h-4" /> Ask HALO to draft a custom note
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </>
          ) : activeTab === 'assistant' ? (
            <PatientAssistant
              patientName={patient.name}
              transcriptHint={currentTranscript}
              messages={assistantMessages}
              input={assistantInput}
              loading={assistantLoading}
              longWait={assistantLongWait}
              latestResult={assistantLatestResult}
              onInputChange={setAssistantInput}
              onSend={handleSendAssistant}
              onUseTranscript={handleUseLatestTranscriptForAssistant}
              onGenerateDoc={handleGenerateAssistantDocx}
              generatingDoc={assistantDocSaving}
              onError={(message) => onToast(message, 'error')}
            />
          ) : (
            <PatientChat
              patientName={patient.name}
              chatMessages={chatMessages}
              chatInput={chatInput}
              onChatInputChange={setChatInput}
              chatLoading={chatLoading}
              chatLongWait={chatLongWait}
              onSendChat={handleSendChat}
            />
          )}
        </div>
      </div>

      {/* EDIT PATIENT MODAL */}
      {editingPatient && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-sm m-4">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-bold text-slate-800">Edit Patient Details</h3>
              <button onClick={() => setEditingPatient(false)} className="text-slate-400 hover:text-slate-600 p-1 rounded-full hover:bg-slate-100 transition"><X size={20} /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-semibold text-slate-600 mb-1.5">Full Name</label>
                <input type="text" value={editName} onChange={e => setEditName(e.target.value)} className="w-full px-4 py-3 rounded-xl border border-slate-200 bg-white text-slate-800 focus:border-sky-500 focus:ring-2 focus:ring-sky-100 outline-none transition" />
              </div>
              <div>
                <label className="block text-sm font-semibold text-slate-600 mb-1.5">Date of Birth</label>
                <input type="date" value={editDob} onChange={e => setEditDob(e.target.value)} className="w-full px-4 py-3 rounded-xl border border-slate-200 bg-white text-slate-800 focus:border-sky-500 focus:ring-2 focus:ring-sky-100 outline-none transition" />
              </div>
              <div>
                <label className="block text-sm font-semibold text-slate-600 mb-1.5">Sex</label>
                <div className="flex bg-slate-100 p-1 rounded-xl">
                  <button onClick={() => setEditSex('M')} className={`flex-1 py-2 rounded-lg text-sm font-bold transition-all ${editSex === 'M' ? 'bg-white text-sky-700 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}>M</button>
                  <button onClick={() => setEditSex('F')} className={`flex-1 py-2 rounded-lg text-sm font-bold transition-all ${editSex === 'F' ? 'bg-white text-sky-700 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}>F</button>
                </div>
              </div>
              <div className="flex gap-3 pt-2">
                <button onClick={() => setEditingPatient(false)} className="flex-1 px-4 py-3 rounded-xl font-medium text-slate-600 hover:bg-slate-100 transition">Cancel</button>
                <button onClick={savePatientEdit} className="flex-1 bg-sky-600 hover:bg-sky-700 text-white px-4 py-3 rounded-xl font-bold shadow-lg shadow-sky-600/20 transition">Save Changes</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* RENAME MODAL */}
      {editingFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-sm m-4">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-bold text-slate-800">
                Rename {isFolder(editingFile) ? 'Folder' : 'File'}
              </h3>
              <button onClick={() => setEditingFile(null)} className="text-slate-400 hover:text-slate-600 p-1 rounded-full hover:bg-slate-100 transition"><X size={20} /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-semibold text-slate-600 mb-1.5">Name</label>
                <input type="text" value={editFileName} onChange={e => setEditFileName(e.target.value)} className="w-full px-4 py-3 rounded-xl border border-slate-200 bg-white text-slate-800 focus:border-sky-500 focus:ring-2 focus:ring-sky-100 outline-none transition" />
              </div>
              <div className="flex gap-3 pt-2">
                <button onClick={() => setEditingFile(null)} className="flex-1 px-4 py-3 rounded-xl font-medium text-slate-600 hover:bg-slate-100 transition">Cancel</button>
                <button onClick={saveFileEdit} className="flex-1 bg-sky-600 hover:bg-sky-700 text-white px-4 py-3 rounded-xl font-bold shadow-lg shadow-sky-600/20 transition">Save Changes</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* DELETE FILE CONFIRMATION MODAL */}
      {fileToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 m-4 border-2 border-rose-100">
            <div className="flex flex-col items-center text-center mb-6">
              <div className="w-14 h-14 bg-rose-50 rounded-full flex items-center justify-center mb-3 text-rose-500">
                <Trash2 size={28} />
              </div>
              <h3 className="text-lg font-bold text-slate-800">Delete File?</h3>
              <p className="text-slate-500 mt-2 text-sm px-4">
                Move <span className="font-bold text-slate-700">{fileToDelete.name}</span> to trash?
              </p>
            </div>
            <div className="flex gap-3">
              <button onClick={() => setFileToDelete(null)} className="flex-1 px-4 py-3 rounded-xl font-medium text-slate-600 hover:bg-slate-100 transition">Cancel</button>
              <button onClick={confirmDeleteFile} className="flex-1 bg-rose-500 hover:bg-rose-600 text-white px-4 py-3 rounded-xl font-bold shadow-lg shadow-rose-500/20 transition">Delete</button>
            </div>
          </div>
        </div>
      )}

      {status === AppStatus.ANALYZING && (
        <div className="fixed inset-0 bg-white/90 backdrop-blur-sm z-50 flex flex-col items-center justify-center">
          <div className="relative">
            <div className="w-16 h-16 border-4 border-slate-200 rounded-full"></div>
            <div className="absolute top-0 left-0 w-16 h-16 border-4 border-sky-500 rounded-full border-t-transparent animate-spin"></div>
          </div>
          <p className="text-sky-900 font-bold text-lg mt-6">HALO is analyzing...</p>
          <p className="text-slate-500 text-sm mt-1">Extracting clinical concepts &amp; tagging files</p>
        </div>
      )}

      {status === AppStatus.SAVING && (
        <div className="fixed inset-0 bg-white/90 backdrop-blur-sm z-50 flex flex-col items-center justify-center">
          <div className="relative">
            <div className="w-16 h-16 border-4 border-slate-200 rounded-full"></div>
            <div className="absolute top-0 left-0 w-16 h-16 border-4 border-sky-500 rounded-full border-t-transparent animate-spin"></div>
          </div>
          <p className="text-sky-900 font-bold text-lg mt-6">Saving note as DOCX...</p>
          <p className="text-slate-500 text-sm mt-1">Uploading to Patient Notes folder</p>
        </div>
      )}

      {/* NOTE GENERATION OVERLAY */}
      {isGeneratingNotes && (
        <div className="fixed inset-0 bg-slate-900/35 backdrop-blur-[1px] z-40 flex items-center justify-center pointer-events-none">
          <div className="bg-white/95 border border-slate-200 rounded-2xl shadow-xl px-6 py-5 flex flex-col items-center gap-3 max-w-sm text-center pointer-events-auto">
            <div className="relative mb-1">
              <div className="w-10 h-10 rounded-full border-2 border-slate-200" />
              <div className="absolute inset-0 rounded-full border-2 border-sky-500 border-t-transparent animate-spin" />
            </div>
            <p className="text-sm font-semibold text-slate-800">HALO is preparing your notes…</p>
            <div className="mt-1 w-full max-w-xs space-y-2">
              {NOTE_GENERATION_STEPS.map((label, index) => {
                const active = index === noteGenerationStep;
                return (
                  <div
                    // eslint-disable-next-line react/no-array-index-key
                    key={index}
                    className="flex items-center gap-2 text-left"
                  >
                    <div
                      className={`w-2 h-2 rounded-full ${
                        active ? 'bg-sky-500 animate-pulse' : 'bg-slate-200'
                      }`}
                    />
                    <span
                      className={`text-xs ${
                        active ? 'font-semibold text-slate-900' : 'text-slate-400'
                      }`}
                    >
                      {label}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="text-[11px] text-slate-500 mt-1">
              This usually takes a few seconds. You can continue reviewing the transcript while HALO prepares your notes.
            </p>
          </div>
        </div>
      )}

      {/* UPLOAD DESTINATION PICKER MODAL */}
      {showUploadPicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-sm m-4">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-bold text-slate-800">Upload Destination</h3>
              <button onClick={() => setShowUploadPicker(false)} className="text-slate-400 hover:text-slate-600 p-1 rounded-full hover:bg-slate-100 transition"><X size={20} /></button>
            </div>
            <div className="mb-3">
              <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Uploading to:</label>
              <div className="flex items-center gap-2 bg-sky-50 border border-sky-100 px-3 py-2 rounded-lg">
                <FolderOpen size={16} className="text-sky-600 shrink-0" />
                <span className="text-sm font-semibold text-sky-700 truncate">{uploadTargetLabel}</span>
              </div>
            </div>
            <div className="mb-4">
              {uploadPickerLoading ? (
                <div className="flex items-center justify-center py-6">
                  <Loader2 size={20} className="text-sky-500 animate-spin" />
                </div>
              ) : uploadPickerFolders.length > 0 ? (
                <div className="max-h-48 overflow-y-auto space-y-1.5 border border-slate-100 rounded-lg p-2">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 px-1 mb-1">Or choose a subfolder:</p>
                  {uploadPickerFolders.map(folder => (
                    <button
                      key={folder.id}
                      onClick={() => selectUploadFolder(folder)}
                      className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left text-sm font-medium text-slate-700 hover:bg-sky-50 hover:text-sky-700 transition-colors"
                    >
                      <FolderOpen size={15} className="text-sky-500 shrink-0" />
                      <span className="truncate">{folder.name}</span>
                      <ChevronRight size={14} className="text-slate-300 ml-auto shrink-0" />
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-slate-400 text-center py-3">No subfolders available</p>
              )}
            </div>
            <div className="flex gap-3">
              <button onClick={() => setShowUploadPicker(false)} className="flex-1 px-4 py-3 rounded-xl font-medium text-slate-600 hover:bg-slate-100 transition">Cancel</button>
              <button onClick={confirmUploadDestination} className="flex-1 bg-sky-600 hover:bg-sky-700 text-white px-4 py-3 rounded-xl font-bold shadow-lg shadow-sky-600/20 transition flex items-center justify-center gap-2">
                <Upload size={16} /> Choose File
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CONTEXT DRIVE PICKER MODAL */}
      {showContextDrivePicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-lg overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <div className="flex flex-col">
                <span className="text-sm font-semibold text-slate-800">Add files from Drive</span>
                <span className="text-xs text-slate-500">
                  Choose files from this patient&apos;s Google Drive folder to reference in your context.
                </span>
              </div>
              <button
                onClick={() => {
                  setShowContextDrivePicker(false);
                  setContextDriveSelectedIds([]);
                }}
                className="p-1.5 rounded-full text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 space-y-3">
              {contextDriveLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 text-sky-500 animate-spin" />
                </div>
              ) : contextDriveFiles.filter((f) => !isFolder(f)).length === 0 ? (
                <p className="text-sm text-slate-500 text-center py-6">
                  No files found in this patient&apos;s Drive folder yet.
                </p>
              ) : (
                <div className="max-h-72 overflow-y-auto rounded-xl border border-slate-100 bg-slate-50/60 divide-y divide-slate-100">
                  {contextDriveFiles
                    .filter((f) => !isFolder(f))
                    .map((file) => {
                      const checked = contextDriveSelectedIds.includes(file.id);
                      return (
                        <label
                          key={file.id}
                          className="flex items-center gap-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-white cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleContextDriveSelection(file.id)}
                            className="rounded border-slate-300 text-sky-600 focus:ring-sky-500"
                          />
                          <span className="truncate">{file.name}</span>
                        </label>
                      );
                    })}
                </div>
              )}
            </div>
            <div className="px-5 py-4 border-t border-slate-100 flex gap-3 justify-end bg-slate-50/80">
              <button
                type="button"
                onClick={() => {
                  setShowContextDrivePicker(false);
                  setContextDriveSelectedIds([]);
                }}
                className="px-4 py-2 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-100 transition"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={contextDriveSelectedIds.length === 0}
                onClick={applyContextDriveSelection}
                className="px-4 py-2 rounded-xl text-sm font-semibold bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
              >
                Add to context
              </button>
            </div>
          </div>
        </div>
      )}

      {/* FILE VIEWER MODAL */}
      {viewingFile && (
        <FileViewer
          fileId={viewingFile.id}
          fileName={viewingFile.name}
          mimeType={viewingFile.mimeType}
          fileUrl={viewingFile.url}
          onClose={() => setViewingFile(null)}
        />
      )}

      {/* CREATE FOLDER MODAL */}
      {showCreateFolderModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-sm m-4">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-bold text-slate-800">New Folder</h3>
              <button onClick={() => { setShowCreateFolderModal(false); setNewFolderName(""); }} className="text-slate-400 hover:text-slate-600 p-1 rounded-full hover:bg-slate-100 transition"><X size={20} /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Creating folder in:</label>
                <p className="text-sm font-semibold text-sky-700 bg-sky-50 px-3 py-2 rounded-lg border border-sky-100">
                  {breadcrumbs.map(b => b.name).join(' / ')}
                </p>
              </div>
              <div>
                <label className="block text-sm font-semibold text-slate-600 mb-1.5">Folder Name</label>
                <input
                  type="text"
                  value={newFolderName}
                  onChange={e => setNewFolderName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleCreateFolder(); }}
                  placeholder="e.g. Lab Results, Imaging..."
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 bg-white text-slate-800 focus:border-sky-500 focus:ring-2 focus:ring-sky-100 outline-none transition"
                  autoFocus
                />
              </div>
              <div className="flex gap-3 pt-2">
                <button onClick={() => { setShowCreateFolderModal(false); setNewFolderName(""); }} className="flex-1 px-4 py-3 rounded-xl font-medium text-slate-600 hover:bg-slate-100 transition">Cancel</button>
                <button onClick={handleCreateFolder} disabled={!newFolderName.trim()} className="flex-1 bg-sky-600 hover:bg-sky-700 text-white px-4 py-3 rounded-xl font-bold shadow-lg shadow-sky-600/20 transition disabled:opacity-50 flex items-center justify-center gap-2">
                  <FolderPlus size={16} /> Create
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* CUSTOM AI NOTE MODAL */}
      {showCustomAiNoteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-lg overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <div className="flex flex-col">
                <span className="text-sm font-semibold text-slate-800">Ask HALO to draft a custom note</span>
                <span className="text-xs text-slate-500">
                  Describe what you need (e.g. &ldquo;Motivation for MRI&rdquo;, &ldquo;Sick note&rdquo;). HALO will draft it using this patient&rsquo;s documentation and transcript.
                </span>
              </div>
              <button
                onClick={() => {
                  setShowCustomAiNoteModal(false);
                  setCustomAiPrompt('');
                }}
                className="p-1.5 rounded-full text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <textarea
                value={customAiPrompt}
                onChange={(e) => setCustomAiPrompt(e.target.value)}
                rows={4}
                placeholder="e.g. Draft a medical motivation letter explaining why this patient requires a CT scan based on their current findings and history."
                className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 placeholder-slate-400 focus:bg-white focus:border-sky-500 focus:ring-2 focus:ring-sky-100 outline-none resize-none"
              />
              <p className="text-[11px] text-slate-500">
                HALO will use the same context as the <span className="font-semibold">Ask HALO</span> chat, plus your latest transcript, to generate the note.
              </p>
            </div>
            <div className="px-5 py-4 border-t border-slate-100 flex gap-3 justify-end bg-slate-50/80">
              <button
                type="button"
                onClick={() => {
                  setShowCustomAiNoteModal(false);
                  setCustomAiPrompt('');
                }}
                className="px-4 py-2 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-100 transition"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!customAiPrompt.trim() || customAiLoading}
                onClick={async () => {
                  const prompt = customAiPrompt.trim();
                  if (!prompt) return;
                  setCustomAiLoading(true);
                  try {
                    const historyForContext = chatMessagesRef.current || [];
                    const response = await askHalo(patient.id, prompt, historyForContext);
                    const content = response.reply?.trim();
                    if (!content) {
                      onToast('HALO did not return any text for this request. Please try again.', 'error');
                    } else {
                      const title = prompt.length > 60 ? `${prompt.slice(0, 57)}…` : prompt;
                      const newNote: HaloNote = {
                        noteId: `custom-${Date.now()}`,
                        title: title || 'Custom note',
                        content,
                        template_id: 'jon_note',
                        lastSavedAt: new Date().toISOString(),
                        dirty: true,
                      };
                      setNotes((prev) => [...prev, newNote]);
                      const newIndex = notes.length;
                      setActiveNoteIndex(newIndex);
                      setConsultSubTab(newIndex);
                      setShowCustomAiNoteModal(false);
                      setCustomAiPrompt('');
                      onToast('Custom note drafted. You can edit and save it as DOCX.', 'success');
                    }
                  } catch (err) {
                    onToast(getErrorMessage(err), 'error');
                  }
                  setCustomAiLoading(false);
                }}
                className="px-4 py-2 rounded-xl text-sm font-semibold bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm flex items-center gap-2"
              >
                {customAiLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" /> Drafting…
                  </>
                ) : (
                  <>
                    <MessageCircle className="w-4 h-4" /> Draft note
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
