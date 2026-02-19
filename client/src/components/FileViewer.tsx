import React, { useState, useEffect, useRef } from 'react';
import { X, ExternalLink, Loader2, FileText, AlertCircle } from 'lucide-react';

interface FileViewerProps {
  fileId: string;
  fileName: string;
  mimeType: string;
  fileUrl: string;
  onClose: () => void;
}

const API_BASE = import.meta.env.VITE_API_URL || '';

/**
 * Determine if a file type can be previewed in-app.
 * Returns the type of viewer to use.
 */
function getViewerType(mimeType: string, fileName: string): 'pdf' | 'image' | 'text' | 'google-embed' | 'unsupported' {
  // Images
  if (mimeType.startsWith('image/')) return 'image';

  // PDFs
  if (mimeType === 'application/pdf' || fileName.endsWith('.pdf')) return 'pdf';

  // Text-based files
  if (
    mimeType === 'text/plain' ||
    mimeType === 'text/csv' ||
    mimeType === 'text/html' ||
    mimeType === 'application/json' ||
    fileName.endsWith('.txt') ||
    fileName.endsWith('.csv') ||
    fileName.endsWith('.json')
  ) return 'text';

  // Google Workspace files (Docs, Sheets, Slides) — export as PDF for viewer
  if (
    mimeType === 'application/vnd.google-apps.document' ||
    mimeType === 'application/vnd.google-apps.spreadsheet' ||
    mimeType === 'application/vnd.google-apps.presentation'
  ) return 'pdf';

  return 'unsupported';
}

export const FileViewer: React.FC<FileViewerProps> = ({ fileId, fileName, mimeType, fileUrl, onClose }) => {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const blobUrlRef = useRef<string | null>(null);

  const viewerType = getViewerType(mimeType, fileName);

  useEffect(() => {
    if (viewerType === 'unsupported') {
      setLoading(false);
      return;
    }

    // Revoke any previous blob URL before loading a new file
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }

    let cancelled = false;

    const loadFile = async () => {
      setLoading(true);
      setError(null);
      setBlobUrl(null);
      setTextContent(null);

      try {
        const proxyUrl = `${API_BASE}/api/drive/files/${fileId}/proxy`;
        const res = await fetch(proxyUrl, { credentials: 'include' });

        if (cancelled) return;

        if (!res.ok) {
          throw new Error(`Failed to load file (${res.status})`);
        }

        if (viewerType === 'text') {
          const text = await res.text();
          if (!cancelled) setTextContent(text);
        } else {
          const blob = await res.blob();
          if (!cancelled) {
            const url = URL.createObjectURL(blob);
            blobUrlRef.current = url;
            setBlobUrl(url);
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load file');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    loadFile();

    return () => {
      cancelled = true;
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [fileId, viewerType]);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const renderContent = () => {
    if (loading) {
      return (
        <div className="flex flex-col items-center justify-center h-full gap-4">
          <Loader2 className="w-10 h-10 text-sky-500 animate-spin" />
          <p className="text-slate-500 text-sm font-medium">Loading preview...</p>
        </div>
      );
    }

    if (error) {
      return (
        <div className="flex flex-col items-center justify-center h-full gap-4">
          <AlertCircle className="w-12 h-12 text-rose-400" />
          <p className="text-slate-600 font-medium">{error}</p>
          <a
            href={fileUrl}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-sky-600 hover:text-sky-700 underline"
          >
            Open in Google Drive instead
          </a>
        </div>
      );
    }

    if (viewerType === 'unsupported') {
      return (
        <div className="flex flex-col items-center justify-center h-full gap-4">
          <FileText className="w-12 h-12 text-slate-300" />
          <p className="text-slate-600 font-medium">Preview not available for this file type</p>
          <p className="text-slate-400 text-sm">({mimeType})</p>
          <a
            href={fileUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-2 px-4 py-2 bg-sky-600 text-white rounded-lg hover:bg-sky-700 transition flex items-center gap-2 text-sm font-semibold"
          >
            <ExternalLink size={16} /> Open in New Tab
          </a>
        </div>
      );
    }

    if (viewerType === 'image' && blobUrl) {
      return (
        <div className="flex items-center justify-center h-full p-4 overflow-auto">
          <img src={blobUrl} alt={fileName} className="max-w-full max-h-full object-contain rounded-lg shadow-sm" />
        </div>
      );
    }

    if (viewerType === 'pdf' && blobUrl) {
      return (
        <iframe
          src={blobUrl}
          title={fileName}
          className="w-full h-full rounded-b-xl border-0"
        />
      );
    }

    if (viewerType === 'text' && textContent !== null) {
      return (
        <div className="h-full overflow-auto p-6">
          <pre className="whitespace-pre-wrap font-mono text-sm text-slate-700 leading-relaxed">
            {textContent}
          </pre>
        </div>
      );
    }

    return null;
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-[95vw] h-[90vh] max-w-6xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 bg-slate-50 rounded-t-2xl shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <FileText size={18} className="text-sky-600 shrink-0" />
            <h3 className="font-semibold text-slate-800 truncate">{fileName}</h3>
            <span className="text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full shrink-0">
              {mimeType.split('/').pop()?.toUpperCase() || 'FILE'}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <a
              href={fileUrl}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-slate-600 hover:text-sky-700 hover:bg-sky-50 rounded-lg transition"
              title="Open in new tab"
            >
              <ExternalLink size={15} /> New Tab
            </a>
            <button
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition"
              title="Close"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0 bg-slate-50">
          {renderContent()}
        </div>
      </div>
    </div>
  );
};
