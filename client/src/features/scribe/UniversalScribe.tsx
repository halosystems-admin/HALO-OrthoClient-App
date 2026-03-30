import React, { useState, useRef, useEffect } from 'react';
import { Mic, Square, Wand2, AlertCircle } from 'lucide-react';
import { transcribeAudio } from '../../services/api';

// Recordings shorter than this are likely too brief for useful transcription
const MIN_RECORDING_SECONDS = 5;

interface Props {
  onTranscriptionComplete: (transcript: string) => void;
  onError?: (message: string) => void;
}

export const UniversalScribe: React.FC<Props> = ({ onTranscriptionComplete, onError }) => {
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [longWait, setLongWait] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [shortRecordingWarning, setShortRecordingWarning] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordingMimeType = useRef<string>('audio/webm');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Duration timer — ticks every second while recording
  useEffect(() => {
    if (isRecording) {
      setRecordingSeconds(0);
      timerRef.current = setInterval(() => {
        setRecordingSeconds(s => s + 1);
      }, 1000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isRecording]);

  // "May take a while" hint after 10s of processing (covers Gemini fallback latency)
  useEffect(() => {
    if (!isProcessing) {
      setLongWait(false);
      return;
    }
    const id = setTimeout(() => setLongWait(true), 10_000);
    return () => clearTimeout(id);
  }, [isProcessing]);

  // Stop microphone stream if component unmounts mid-recording
  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current) {
        try {
          mediaRecorderRef.current.stream.getTracks().forEach(t => t.stop());
        } catch {
          // Stream may already be stopped
        }
      }
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const startRecording = async () => {
    setShortRecordingWarning(false);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')
          ? 'audio/ogg;codecs=opus'
          : 'audio/webm';

      recordingMimeType.current = mimeType;

      const mediaRecorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        setIsProcessing(true);
        try {
          const audioBlob = new Blob(chunksRef.current, { type: recordingMimeType.current });
          const reader = new FileReader();
          reader.readAsDataURL(audioBlob);
          reader.onloadend = async () => {
            try {
              const base64Data = (reader.result as string).split(',')[1];
              if (base64Data) {
                const transcript = await transcribeAudio(base64Data, recordingMimeType.current);
                onTranscriptionComplete(transcript);
              }
            } catch (err) {
              onError?.(`Transcription failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
            }
            setIsProcessing(false);
          };
        } catch (err) {
          onError?.(`Audio processing failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
          setIsProcessing(false);
        }
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch {
      onError?.('Could not access microphone. Please check your browser permissions.');
    }
  };

  const stopRecording = () => {
    if (!mediaRecorderRef.current || !isRecording) return;

    // Warn if recording was very short — transcription quality will be poor
    if (recordingSeconds < MIN_RECORDING_SECONDS) {
      setShortRecordingWarning(true);
      setTimeout(() => setShortRecordingWarning(false), 4000);
    }

    mediaRecorderRef.current.stop();
    mediaRecorderRef.current.stream.getTracks().forEach(t => t.stop());
    setIsRecording(false);
  };

  const formatDuration = (secs: number): string => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
  };

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-2">
      {/* Short recording warning */}
      {shortRecordingWarning && (
        <div className="bg-amber-50 border border-amber-200 shadow-lg rounded-xl px-3 py-2 flex items-center gap-2 animate-in fade-in max-w-[200px]">
          <AlertCircle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
          <span className="text-[11px] font-medium text-amber-700">Recording too short — transcription may be incomplete.</span>
        </div>
      )}

      {/* Recording indicator pill with live duration */}
      {isRecording && (
        <div className="bg-white border border-red-200 shadow-lg rounded-full px-3 py-1.5 flex items-center gap-2 animate-in fade-in">
          <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse shadow-[0_0_6px_rgba(239,68,68,0.5)]" />
          <span className="text-[11px] font-bold text-slate-600 uppercase tracking-wider">Recording</span>
          <span className="text-[11px] font-mono text-red-600 font-semibold">{formatDuration(recordingSeconds)}</span>
        </div>
      )}

      {/* Processing indicator pill */}
      {isProcessing && (
        <div className="bg-white border border-sky-200 shadow-lg rounded-full px-3 py-1.5 flex flex-col items-end gap-1">
          <div className="flex items-center gap-2">
            <Wand2 className="w-3.5 h-3.5 text-sky-500 animate-spin" />
            <span className="text-[11px] font-bold text-sky-700 uppercase tracking-wider">Scribing...</span>
          </div>
          {longWait && (
            <span className="text-[9px] text-slate-500">This may take 15–60 seconds.</span>
          )}
        </div>
      )}

      {/* FAB button */}
      <button
        onClick={isRecording ? stopRecording : startRecording}
        disabled={isProcessing}
        title={isRecording ? 'Stop recording' : isProcessing ? 'Processing...' : 'Start Scribe'}
        className={`flex items-center justify-center rounded-full shadow-lg transition-all duration-200 ${
          isRecording
            ? 'w-12 h-12 bg-red-500 hover:bg-red-600 text-white ring-4 ring-red-200 animate-pulse'
            : isProcessing
              ? 'w-12 h-12 bg-slate-200 text-slate-400 cursor-not-allowed'
              : 'w-12 h-12 bg-sky-600 hover:bg-sky-700 text-white hover:scale-110 active:scale-95 hover:shadow-xl'
        }`}
      >
        {isProcessing ? (
          <Wand2 className="w-5 h-5 animate-spin" />
        ) : isRecording ? (
          <Square className="w-4.5 h-4.5 fill-current" />
        ) : (
          <Mic className="w-5 h-5" />
        )}
      </button>
    </div>
  );
};
