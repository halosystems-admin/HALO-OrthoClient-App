import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { Patient, DriveFile, LabAlert, BreadcrumbItem, ChatMessage, HaloNote } from '../../../shared/types';
import { AppStatus, FOLDER_MIME_TYPE } from '../../../shared/types';

import {
  fetchFiles, fetchFilesFirstPage, fetchFilesPage, fetchFolderContents, uploadFile, updatePatient,
  updateFileMetadata, generatePatientSummary, analyzeAndRenameImage,
  extractLabAlerts, deleteFile, createFolder, askHaloStream,
  generateNotePreview, saveNoteAsDocx,
} from '../services/api';
import {
  Upload, Calendar, Clock, CheckCircle2, ChevronLeft, Loader2,
  CloudUpload, Pencil, X, Trash2, FolderOpen, MessageCircle,
  FolderPlus, ChevronRight,
} from 'lucide-react';
import { SmartSummary } from '../features/smart-summary/SmartSummary';
import { LabAlerts } from '../features/lab-alerts/LabAlerts';
import { UniversalScribe } from '../features/scribe/UniversalScribe';
import { FileViewer } from '../components/FileViewer';
import { FileBrowser } from '../components/FileBrowser';
import { NoteEditor } from '../components/NoteEditor';
import { PatientChat } from '../components/PatientChat';
import { getErrorMessage } from '../utils/formatting';

const HALO_TEMPLATE_OPTIONS = [
  { id: 'clinical_note', name: 'Clinical Note' },
  { id: 'op_report', name: 'Operation Report' },
  { id: 'jon_note', name: 'Open Note' },
];

interface Props {
  patient: Patient;
  onBack: () => void;
  onDataChange: () => void;
  onToast: (message: string, type: 'success' | 'error' | 'info') => void;
  templateId?: string;
}

export const PatientWorkspace: React.FC<Props> = ({ patient, onBack, onDataChange, onToast, templateId: propTemplateId }) => {
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [summary, setSummary] = useState<string[]>([]);
  const [alerts, setAlerts] = useState<LabAlert[]>([]);
  const [notes, setNotes] = useState<HaloNote[]>([]);
  const [activeNoteIndex, setActiveNoteIndex] = useState(0);
  const [templateId, setTemplateId] = useState(propTemplateId || 'clinical_note');
  const [pendingTranscript, setPendingTranscript] = useState<string | null>(null);
  const [selectedTemplatesForGenerate, setSelectedTemplatesForGenerate] = useState<string[]>(['clinical_note']);
  const [status, setStatus] = useState<AppStatus>(AppStatus.IDLE);
  const [activeTab, setActiveTab] = useState<'overview' | 'notes' | 'chat'>('overview');
  const [savingNoteIndex, setSavingNoteIndex] = useState<number | null>(null);
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [showAiPanel, setShowAiPanel] = useState(true);

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
      setNoteContent("");
      setUploadMessage(null);
      setEditMode('write');
      setCurrentFolderId(patient.id);
      setBreadcrumbs([{ id: patient.id, name: patient.name }]);
      setUploadTargetFolderId(patient.id);
      setUploadTargetLabel(patient.name);

      try {
        // Load first page only so the file list appears quickly; fetch rest in background
        const { files: firstFiles, nextPage } = await fetchFilesFirstPage(patient.id);
        if (!isMounted) return;
        setFiles(firstFiles);
        setStatus(AppStatus.IDLE);

        if (firstFiles.length > 0) {
          generatePatientSummary(patient.name, firstFiles, patient.id).then(res => {
            if (isMounted) setSummary(res);
          }).catch(() => {});

          const labFiles = firstFiles.filter(f =>
            f.name.toLowerCase().includes('lab') ||
            f.name.toLowerCase().includes('blood') ||
            f.name.toLowerCase().includes('result')
          );
          if (labFiles.length > 0) {
            const labContext = labFiles.map(f => f.name).join(', ');
            extractLabAlerts(`Patient files indicate lab results: ${labContext}`).then(res => {
              if (isMounted) setAlerts(res);
            }).catch(() => {});
          }
        }

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
        await uploadFile(targetId, file, finalName);
        await loadFolderContents(currentFolderId);
        onToast(`File uploaded to "${uploadTargetLabel}".`, 'success');
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

  const handleNoteChange = useCallback((noteIndex: number, updates: { title?: string; content?: string }) => {
    setNotes(prev => prev.map((n, i) => i !== noteIndex ? n : {
      ...n,
      ...(updates.title !== undefined && { title: updates.title }),
      ...(updates.content !== undefined && { content: updates.content }),
      dirty: true,
    }));
  }, []);

  const handleSaveAsDocx = useCallback(async (noteIndex: number) => {
    const note = notes[noteIndex];
    if (!note?.content.trim()) return;
    setSavingNoteIndex(noteIndex);
    setStatus(AppStatus.SAVING);
    try {
      await saveNoteAsDocx({
        patientId: patient.id,
        template_id: note.template_id || templateId,
        text: note.content,
        fileName: (note.title || 'Note').replace(/[^\w\s-]/g, '').trim() || undefined,
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
  }, [notes, patient.id, templateId, currentFolderId, loadFolderContents, onDataChange, onToast]);

  const handleSaveAll = useCallback(async () => {
    setStatus(AppStatus.SAVING);
    let saved = 0;
    try {
      for (let i = 0; i < notes.length; i++) {
        const note = notes[i];
        if (!note.content.trim()) continue;
        await saveNoteAsDocx({
          patientId: patient.id,
          template_id: note.template_id || templateId,
          text: note.content,
          fileName: (note.title || `Note ${i + 1}`).replace(/[^\w\s-]/g, '').trim() || undefined,
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
  }, [notes, patient.id, templateId, currentFolderId, loadFolderContents, onDataChange, onToast]);

  const handleEmail = useCallback((_noteIndex: number) => {
    onToast('Email not implemented yet.', 'info');
  }, [onToast]);

  const handleScribeResult = useCallback((transcript: string) => {
    if (!transcript.trim()) {
      onToast('No speech detected.', 'info');
      return;
    }
    setPendingTranscript(transcript);
    setSelectedTemplatesForGenerate(['clinical_note']);
    setActiveTab('notes');
  }, [onToast]);

  const toggleTemplateForGenerate = useCallback((id: string) => {
    setSelectedTemplatesForGenerate(prev =>
      prev.includes(id) ? prev.filter(t => t !== id) : [...prev, id]
    );
  }, []);

  const selectAllTemplatesForGenerate = useCallback(() => {
    setSelectedTemplatesForGenerate(HALO_TEMPLATE_OPTIONS.map(t => t.id));
  }, []);

  const handleGenerateFromTemplates = useCallback(async () => {
    if (!pendingTranscript?.trim() || selectedTemplatesForGenerate.length === 0) {
      onToast('Select at least one template.', 'info');
      return;
    }
    setStatus(AppStatus.LOADING);
    const templateIds = selectedTemplatesForGenerate;
    const templateNames = Object.fromEntries(HALO_TEMPLATE_OPTIONS.map(t => [t.id, t.name]));
    try {
      const results = await Promise.all(
        templateIds.map(id => generateNotePreview({ template_id: id, text: pendingTranscript }))
      );
      const combined: HaloNote[] = results.map((res, i) => {
        const tid = templateIds[i];
        const name = templateNames[tid] ?? tid;
        const first = res.notes?.[0];
        const content = first?.content?.trim()
          ? first.content
          : pendingTranscript;
        return {
          noteId: first?.noteId ?? `note-${tid}-${Date.now()}`,
          title: first?.title ?? name,
          content,
          template_id: tid,
          lastSavedAt: new Date().toISOString(),
          dirty: false,
          ...(first?.fields && first.fields.length > 0 ? { fields: first.fields } : {}),
        };
      });
      setNotes(combined);
      setActiveNoteIndex(0);
      setPendingTranscript(null);
      onToast(`Generated ${combined.length} note(s). You can edit and save as DOCX.`, 'success');
    } catch (err) {
      onToast(getErrorMessage(err), 'error');
    }
    setStatus(AppStatus.IDLE);
  }, [pendingTranscript, selectedTemplatesForGenerate, onToast]);

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
              <button
                onClick={openUploadPicker}
                className="w-full md:w-auto flex justify-center items-center gap-2 bg-sky-600 hover:bg-sky-700 text-white px-5 py-2.5 rounded-lg cursor-pointer transition-all shadow-md shadow-sky-600/20 text-sm font-semibold"
              >
                <Upload className="w-4 h-4" /> Upload File
              </button>
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
      <div className="flex-1 overflow-y-auto p-4 md:p-8 bg-slate-50/50">
        <div className="max-w-6xl mx-auto">
          {/* AI Panel */}
          {hasAiContent && showAiPanel && (
            <div className="mb-6 space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-400">AI Insights</span>
                <button onClick={() => setShowAiPanel(false)} className="text-xs font-medium text-slate-400 hover:text-slate-600 flex items-center gap-1 transition-colors px-2 py-1 rounded hover:bg-slate-100">
                  <X size={12} /> Hide
                </button>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <SmartSummary summary={summary} loading={status === AppStatus.LOADING} />
                {alerts.length > 0 && <div><LabAlerts alerts={alerts} /></div>}
              </div>
            </div>
          )}

          {hasAiContent && !showAiPanel && (
            <div className="mb-4">
              <button onClick={() => setShowAiPanel(true)} className="text-xs font-medium text-sky-600 hover:text-sky-700 flex items-center gap-1.5 transition-colors px-3 py-1.5 rounded-lg bg-sky-50 hover:bg-sky-100 border border-sky-100">
                Show HALO AI Insights
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
          ) : activeTab === 'notes' ? (
            pendingTranscript ? (
              <div className="h-[600px] flex flex-col bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                <div className="p-6 border-b border-slate-200">
                  <h3 className="text-sm font-bold text-slate-800 mb-1">Choose note templates</h3>
                  <p className="text-xs text-slate-500 mb-4">Select which note types to generate from your dictation. Each will appear as a separate tab for editing.</p>
                  <div className="flex flex-wrap gap-2 mb-4">
                    {HALO_TEMPLATE_OPTIONS.map((t) => {
                      const selected = selectedTemplatesForGenerate.includes(t.id);
                      return (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => toggleTemplateForGenerate(t.id)}
                          className={`px-4 py-2.5 rounded-xl text-sm font-medium transition-all border shadow-sm whitespace-nowrap ${
                            selected
                              ? 'bg-sky-50 border-sky-300 text-sky-800 ring-2 ring-sky-200'
                              : 'bg-white border-slate-200 text-slate-700 hover:border-slate-300 hover:bg-slate-50'
                          }`}
                        >
                          {t.name}
                        </button>
                      );
                    })}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
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
                      disabled={selectedTemplatesForGenerate.length === 0 || status === AppStatus.LOADING}
                      className="px-4 py-2 rounded-xl text-sm font-bold bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50 disabled:cursor-not-allowed transition shadow-sm border border-sky-600"
                    >
                      {status === AppStatus.LOADING ? 'Generating…' : `Generate ${selectedTemplatesForGenerate.length} note(s)`}
                    </button>
                    <button
                      type="button"
                      onClick={() => setPendingTranscript(null)}
                      className="px-4 py-2 rounded-xl text-sm font-medium bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 hover:border-slate-300 transition shadow-sm"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
                <div className="flex-1 p-4 overflow-auto bg-slate-50">
                  <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Transcript preview</p>
                  <p className="text-sm text-slate-600 whitespace-pre-wrap">{pendingTranscript}</p>
                </div>
              </div>
            ) : notes.length === 0 ? (
              <div className="h-[600px] flex flex-col bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                <div className="flex-1 flex items-center justify-center text-slate-400">
                  <p className="text-sm">No notes yet. Use the Scribe to dictate, then choose templates to generate notes.</p>
                </div>
              </div>
            ) : (
              <NoteEditor
                notes={notes}
                activeIndex={activeNoteIndex}
                onActiveIndexChange={setActiveNoteIndex}
                onNoteChange={handleNoteChange}
                status={status}
                templateId={templateId}
                templateOptions={HALO_TEMPLATE_OPTIONS}
                onTemplateChange={setTemplateId}
                onSaveAsDocx={handleSaveAsDocx}
                onSaveAll={handleSaveAll}
                onEmail={handleEmail}
                savingNoteIndex={savingNoteIndex}
              />
            )
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

      <UniversalScribe onTranscriptionComplete={handleScribeResult} onError={(msg: string) => onToast(msg, 'error')} />

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
    </div>
  );
};
