import React, { useEffect, useRef, useState } from 'react';
import type { AssistantOrchestrationResult, ChatMessage } from '../../../shared/types';
import { Bot, Send, ClipboardList, FileText, Mic, Square, Wand2, FileDown } from 'lucide-react';
import { transcribeAudio } from '../services/api';

interface Props {
  patientName: string;
  transcriptHint?: string;
  messages: ChatMessage[];
  input: string;
  loading: boolean;
  longWait?: boolean;
  latestResult: AssistantOrchestrationResult | null;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onUseTranscript: () => void;
  onGenerateDoc: () => void;
  generatingDoc?: boolean;
  onError?: (message: string) => void;
}

export const PatientAssistant: React.FC<Props> = ({
  patientName,
  transcriptHint,
  messages,
  input,
  loading,
  longWait,
  latestResult,
  onInputChange,
  onSend,
  onUseTranscript,
  onGenerateDoc,
  generatingDoc,
  onError,
}) => {
  const endRef = useRef<HTMLDivElement>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordingMimeTypeRef = useRef<string>('audio/webm');

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading, latestResult]);

  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current) {
        try {
          mediaRecorderRef.current.stream.getTracks().forEach((t) => t.stop());
        } catch {
          // ignore
        }
      }
    };
  }, []);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')
          ? 'audio/ogg;codecs=opus'
          : 'audio/webm';
      recordingMimeTypeRef.current = mimeType;
      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        setIsTranscribing(true);
        try {
          const audioBlob = new Blob(chunksRef.current, { type: recordingMimeTypeRef.current });
          const base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
              try {
                const out = String(reader.result || '');
                resolve(out.split(',')[1] || '');
              } catch (err) {
                reject(err);
              }
            };
            reader.onerror = () => reject(reader.error || new Error('Failed to read recording.'));
            reader.readAsDataURL(audioBlob);
          });
          const transcript = await transcribeAudio(base64, recordingMimeTypeRef.current);
          const t = (transcript || '').trim();
          if (t) onInputChange(t);
        } catch (err) {
          onError?.(`Assistant dictation failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
        } finally {
          setIsTranscribing(false);
        }
      };
      recorder.start();
      setIsRecording(true);
    } catch {
      onError?.('Could not access microphone. Please check browser permissions.');
    }
  };

  const stopRecording = () => {
    if (!mediaRecorderRef.current || !isRecording) return;
    mediaRecorderRef.current.stop();
    mediaRecorderRef.current.stream.getTracks().forEach((t) => t.stop());
    setIsRecording(false);
  };

  return (
    <div className="flex flex-col h-[calc(100vh-260px)] min-h-[520px] bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-200 bg-gradient-to-r from-sky-50 to-white flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Bot size={16} className="text-sky-600" />
          <span className="text-sm font-bold text-sky-800 uppercase tracking-wider">Patient Assistant</span>
          <span className="text-xs text-slate-500">Context-aware drafting + tasking for {patientName}</span>
        </div>
        <button
          type="button"
          onClick={onUseTranscript}
          className="text-xs px-3 py-1.5 rounded-full border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
          disabled={loading || !transcriptHint?.trim()}
        >
          Use latest transcript
        </button>
      </div>

      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2">
        <div className="border-r border-slate-200 flex flex-col min-h-0">
          <div className="px-4 py-2 border-b border-slate-100 text-xs font-semibold uppercase tracking-wider text-slate-500">
            Assistant conversation
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.length === 0 && (
              <div className="text-sm text-slate-500">
                Try: "Please write the operative notes for patient John Doe. Left THR. Spinal anesthesia. No complications."
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[88%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap ${
                  m.role === 'user'
                    ? 'bg-sky-600 text-white'
                    : 'bg-slate-100 border border-slate-200 text-slate-700'
                }`}>
                  {m.content}
                </div>
              </div>
            ))}
            {loading && (
              <div className="text-xs text-slate-400 italic">
                Assistant is working with full folder context... {longWait ? 'Complex request, please wait.' : ''}
              </div>
            )}
            <div ref={endRef} />
          </div>
          <div className="border-t border-slate-200 p-3 bg-slate-50">
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(e) => onInputChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) onSend();
                }}
                placeholder="Dictate or type a task for this patient assistant..."
                className="flex-1 min-h-[90px] max-h-48 resize-y px-3 py-2 rounded-lg border border-slate-200 bg-white text-sm text-slate-800 focus:border-sky-500 focus:ring-2 focus:ring-sky-100 outline-none"
                disabled={loading}
              />
              <button
                type="button"
                onClick={isRecording ? stopRecording : startRecording}
                disabled={loading || isTranscribing}
                className={`h-10 px-3 rounded-lg inline-flex items-center gap-2 border ${
                  isRecording
                    ? 'bg-red-600 text-white border-red-600 hover:bg-red-700'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                } disabled:opacity-40`}
                title={isRecording ? 'Stop dictation' : isTranscribing ? 'Transcribing...' : 'Start dictation'}
              >
                {isTranscribing ? <Wand2 size={16} className="animate-spin" /> : isRecording ? <Square size={16} /> : <Mic size={16} />}
              </button>
              <button
                type="button"
                onClick={onSend}
                disabled={loading || !input.trim()}
                className="h-10 px-3 rounded-lg bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-40 inline-flex items-center gap-2"
              >
                <Send size={16} /> Run
              </button>
            </div>
            <p className="mt-1 text-[11px] text-slate-400">
              Tip: Press Ctrl+Enter to run. Record dictation, press stop, then review transcript.
            </p>
          </div>
        </div>

        <div className="flex flex-col min-h-0">
          <div className="px-4 py-2 border-b border-slate-100 text-xs font-semibold uppercase tracking-wider text-slate-500">
            Structured output for template
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {!latestResult ? (
              <p className="text-sm text-slate-500">
                Assistant output will appear here as placeholders + draft body + tasks.
              </p>
            ) : (
              <>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Placeholders</p>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div><strong>Name:</strong> {latestResult.placeholders.NAME}</div>
                    <div><strong>DOB:</strong> {latestResult.placeholders.DOB}</div>
                    <div><strong>Date:</strong> {latestResult.placeholders.DATE}</div>
                    <div><strong>Type:</strong> {latestResult.placeholders.DOCUMENT_TYPE}</div>
                  </div>
                </div>

                <div className="rounded-lg border border-slate-200 p-3">
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2 flex items-center gap-1">
                    <FileText size={14} /> Document body
                  </p>
                  <pre className="text-sm text-slate-700 whitespace-pre-wrap font-sans">{latestResult.documentBody}</pre>
                  <div className="mt-3">
                    <button
                      type="button"
                      onClick={onGenerateDoc}
                      disabled={!latestResult.documentBody.trim() || !!generatingDoc}
                      className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm disabled:opacity-40"
                    >
                      {generatingDoc ? <Wand2 size={14} className="animate-spin" /> : <FileDown size={14} />}
                      Generate DOCX
                    </button>
                  </div>
                </div>

                <div className="rounded-lg border border-slate-200 p-3">
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2 flex items-center gap-1">
                    <ClipboardList size={14} /> Tasks
                  </p>
                  {latestResult.tasks.length === 0 ? (
                    <p className="text-sm text-slate-500">No explicit tasks returned.</p>
                  ) : (
                    <ul className="list-disc pl-5 text-sm text-slate-700 space-y-1">
                      {latestResult.tasks.map((t, i) => <li key={`${t}-${i}`}>{t}</li>)}
                    </ul>
                  )}
                </div>

                {latestResult.warnings.length > 0 && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                    <p className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-1">Warnings</p>
                    <ul className="list-disc pl-5 text-sm text-amber-800 space-y-1">
                      {latestResult.warnings.map((w, i) => <li key={`${w}-${i}`}>{w}</li>)}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

