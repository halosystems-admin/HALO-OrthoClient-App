import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, Pause, Play } from 'lucide-react';
import { getTranscribeWebSocketUrl, transcribeAudio } from '../../services/api';

export interface HeaderConsultationRecorderProps {
  onLiveTranscriptUpdate: (transcript: string) => void;
  onLiveStopped: (transcript: string) => void;
  onError?: (message: string) => void;
}

type ConnectionState = 'idle' | 'connecting' | 'open' | 'closed';

export const HeaderConsultationRecorder: React.FC<HeaderConsultationRecorderProps> = ({
  onLiveTranscriptUpdate,
  onLiveStopped,
  onError,
}) => {
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const [isLive, setIsLive] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordingMimeTypeRef = useRef<string>('audio/webm');
  const transcriptRef = useRef<string>('');
  const timerRef = useRef<number | null>(null);

  const stopAudioVisualization = () => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    analyserRef.current = null;
    setAudioLevel(0);
  };

  const startAudioVisualization = (stream: MediaStream) => {
    try {
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);
      audioContextRef.current = audioContext;
      analyserRef.current = analyser;

      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      const tick = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteTimeDomainData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const v = (dataArray[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / dataArray.length);
        setAudioLevel(rms);
        rafRef.current = requestAnimationFrame(tick);
      };

      rafRef.current = requestAnimationFrame(tick);
    } catch {
      // Visualization is best-effort only
    }
  };

  const stopTimer = () => {
    if (timerRef.current != null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const startTimer = () => {
    stopTimer();
    const startedAt = performance.now() - elapsedMs;
    timerRef.current = window.setInterval(() => {
      setElapsedMs(performance.now() - startedAt);
    }, 500);
  };

  const cleanup = useCallback(() => {
    if (wsRef.current) {
      try {
        if (wsRef.current.readyState === WebSocket.OPEN) wsRef.current.send('end');
        wsRef.current.close();
      } catch {
        // ignore
      }
      wsRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    stopAudioVisualization();
    stopTimer();
    setConnectionState('idle');
    setIsPaused(false);
    setElapsedMs(0);
  }, []);

  useEffect(() => {
    return () => cleanup();
  }, [cleanup]);

  const runFallbackTranscription = useCallback(async (): Promise<string> => {
    if (!chunksRef.current.length) return '';
    try {
      const blob = new Blob(chunksRef.current, {
        type: recordingMimeTypeRef.current || 'audio/webm',
      });
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          try {
            const result = reader.result as string;
            const encoded = result.split(',')[1] || '';
            resolve(encoded);
          } catch (err) {
            reject(err);
          }
        };
        reader.onerror = () => reject(reader.error || new Error('Failed to read recording.'));
        reader.readAsDataURL(blob);
      });

      if (!base64) return '';

      const transcript = await transcribeAudio(
        base64,
        recordingMimeTypeRef.current || 'audio/webm'
      );
      return transcript?.trim() || '';
    } catch (err) {
      console.error('[HeaderConsultationRecorder] Fallback transcription failed:', err);
      onError?.(
        'Live transcription was unavailable and the backup transcription also failed. Please try again.'
      );
      return '';
    }
  }, [onError]);

  const stopLive = useCallback(async () => {
    const streamedText = transcriptRef.current.trim();
    cleanup();
    setIsLive(false);

    let finalText = streamedText;
    if (!finalText && chunksRef.current.length > 0) {
      finalText = await runFallbackTranscription();
    }

    if (finalText) {
      onLiveStopped(finalText);
    }
  }, [cleanup, onLiveStopped, runFallbackTranscription]);

  const startLive = useCallback(async () => {
    if (isLive || connectionState === 'connecting') return;
    transcriptRef.current = '';
    chunksRef.current = [];
    setElapsedMs(0);
    setConnectionState('connecting');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      startAudioVisualization(stream);

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')
          ? 'audio/ogg;codecs=opus'
          : 'audio/webm';
      recordingMimeTypeRef.current = mimeType;

      const wsUrl = getTranscribeWebSocketUrl();
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        setConnectionState('open');
        const mediaRecorder = new MediaRecorder(stream, { mimeType });
        mediaRecorderRef.current = mediaRecorder;
        mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) {
            chunksRef.current.push(e.data);
            if (ws.readyState === WebSocket.OPEN && !isPaused) {
              ws.send(e.data);
            }
          }
        };
        mediaRecorder.start(250);
        setIsLive(true);
        setIsPaused(false);
        startTimer();
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as { type: string; transcript?: string; message?: string };
          if (msg.type === 'transcript' && typeof msg.transcript === 'string' && msg.transcript.trim()) {
            const prev = transcriptRef.current;
            const sep = prev ? (prev.endsWith(' ') || msg.transcript.startsWith(' ') ? '' : ' ') : '';
            transcriptRef.current = prev + sep + msg.transcript.trim();
            onLiveTranscriptUpdate(transcriptRef.current);
          }
          if (msg.type === 'error') {
            console.error('[HeaderConsultationRecorder] WebSocket error message from server:', msg.message);
            onError?.(msg.message || 'Live transcription error');
          }
        } catch {
          // ignore non-JSON
        }
      };

      ws.onclose = () => {
        setConnectionState('closed');
        void stopLive();
      };

      ws.onerror = () => {
        onError?.('WebSocket connection failed. Check that the server is running and DEEPGRAM_API_KEY is set.');
      };
    } catch (err) {
      setConnectionState('idle');
      onError?.(
        err instanceof Error ? err.message : 'Could not access microphone. Please check your browser permissions.'
      );
    }
  }, [connectionState, isLive, onLiveTranscriptUpdate, onError, stopLive]);

  const togglePause = () => {
    if (!isLive || connectionState !== 'open') return;
    setIsPaused(prev => !prev);
  };

  useEffect(() => {
    if (!mediaRecorderRef.current || !wsRef.current) return;
    // MediaRecorder keeps recording; pause only affects whether chunks are sent to WS.
  }, [isPaused]);

  const isBusy = connectionState === 'connecting';
  const seconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const displayTime = `${minutes.toString().padStart(2, '0')}:${(seconds % 60)
    .toString()
    .padStart(2, '0')}`;

  return (
    <div className="flex items-center gap-3">
      <div className="hidden md:flex flex-col items-end mr-1">
        {isLive && (
          <span className="text-[11px] font-medium text-slate-500">
            Recording consultation · {displayTime}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        {isLive && (
          <button
            type="button"
            onClick={togglePause}
            className="hidden md:inline-flex items-center gap-1.5 px-3 py-2 rounded-full border border-red-100 bg-white text-[11px] font-medium text-slate-700 hover:bg-red-50 transition"
          >
            {isPaused ? (
              <>
                <Play className="w-3.5 h-3.5" /> Resume
              </>
            ) : (
              <>
                <Pause className="w-3.5 h-3.5" /> Pause
              </>
            )}
          </button>
        )}
        <button
          type="button"
          onClick={isLive ? () => void stopLive() : () => void startLive()}
          disabled={isBusy}
          className={`flex items-center gap-3 rounded-full px-4 py-2 text-sm font-semibold shadow-md transition-all ${
            isLive
              ? 'bg-red-600 hover:bg-red-700 text-white shadow-red-500/30'
              : 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-emerald-500/30'
          } ${isBusy ? 'opacity-70 cursor-not-allowed' : ''}`}
        >
          <div className="flex items-center justify-center w-7 h-7 rounded-full bg-white/10">
            <Mic className="w-4 h-4 text-white" />
          </div>
          <div className="flex flex-col items-start">
            <span className="text-xs uppercase tracking-wide">
              {isLive ? 'Recording' : 'Record consultation'}
            </span>
            <span className="text-[11px] font-normal opacity-80">
              {isLive ? displayTime : 'Dictate while you examine'}
            </span>
          </div>
          <div className="hidden md:flex items-end gap-[2px] h-4">
            {Array.from({ length: 8 }).map((_, i) => {
              const intensity = Math.max(0.2, Math.min(1, audioLevel * 5 + i * 0.05));
              const height = 4 + intensity * 10;
              return (
                <span
                  // eslint-disable-next-line react/no-array-index-key
                  key={i}
                  className="w-[3px] rounded-full bg-white/80"
                  style={{ height }}
                />
              );
            })}
          </div>
        </button>
      </div>
    </div>
  );
};

