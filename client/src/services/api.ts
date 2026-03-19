import type {
  Patient,
  DriveFile,
  LabAlert,
  ChatMessage,
  UserSettings,
  HaloNote,
  CalendarEvent,
  ScribeSession,
} from '../../../shared/types';

const API_BASE = import.meta.env.VITE_API_URL || '';

/** WebSocket URL for live transcription (ws or wss).
 *
 * - In production: set VITE_API_URL to the backend origin (e.g. https://app.halo.africa)
 *   and we derive wss://.../ws/transcribe from that.
 * - In local dev (no VITE_API_URL): REST calls use Vite's /api proxy, but WebSocket
 *   needs to go directly to the Node server (same port as backend, e.g. 3000).
 */
export function getTranscribeWebSocketUrl(): string {
  // If an explicit API base is configured, derive WS URL from it
  if (API_BASE) {
    const base = API_BASE.replace(/\/$/, '');
    const wsProtocol = base.startsWith('https') ? 'wss:' : 'ws:';
    const host = base.replace(/^https?:\/\//, '');
    return `${wsProtocol}//${host}/ws/transcribe`;
  }

  // Dev fallback: assume backend is on port 3000 at same host
  if (typeof window !== 'undefined') {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const hostname = window.location.hostname;
    const port = 3000;
    return `${protocol}//${hostname}:${port}/ws/transcribe`;
  }

  // SSR / safety fallback
  return 'ws://localhost:3000/ws/transcribe';
}

// --- Structured Error ---
export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const url = `${API_BASE}${path}`;
  console.log(`[API] Making request to: ${url}`);
  
  let res: Response;
  try {
    res = await fetch(url, {
      ...options,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    console.error('[API] Network error:', error);
    throw new ApiError(
      `Failed to connect to server. Make sure the server is running on port 3000. ${error instanceof Error ? error.message : 'Unknown error'}`,
      0
    );
  }

  if (res.status === 401) {
    window.location.href = '/';
    throw new ApiError('Not authenticated', 401);
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    const text = await res.text().catch(() => 'Unable to read response');
    console.error('[API] Non-JSON response:', text);
    throw new ApiError(
      `Server returned a non-JSON response (${res.status}). Please try again.`,
      res.status
    );
  }

  if (!res.ok) {
    const message = (data as { error?: string }).error || `Request failed (${res.status})`;
    console.error('[API] Request failed:', message);
    throw new ApiError(message, res.status);
  }

  return data as T;
}

// --- AUTH ---
export const getLoginUrl = () => request<{ url: string }>('/api/auth/login-url');
export const checkAuth = () => request<{ signedIn: boolean; email?: string }>('/api/auth/me');
export const logout = () => request('/api/auth/logout', { method: 'POST' });

/** Run note conversion scheduler now (txt→docx after 10h, docx→pdf after 24h). Requires jobs to be due. */
export const runSchedulerNow = () =>
  request<{ ok: boolean; message: string }>('/api/drive/run-scheduler', { method: 'POST' });

/** Check scheduler for pending conversion jobs */
export const getSchedulerStatus = () =>
  request<{ totalPending: number; totalDue: number; jobs: Array<{ fileId: string; status: string; savedAt: string }> }>(
    '/api/drive/scheduler-status'
  );

/** Send a new template request to admin (description + optional file attachments as base64) */
export const requestNewTemplate = (params: {
  description: string;
  attachments?: Array<{ name: string; content: string }>;
}) =>
  request<{ ok: boolean; message: string }>('/api/request-template', {
    method: 'POST',
    body: JSON.stringify(params),
  });

// --- CALENDAR / BOOKINGS ---

export const fetchTodayEvents = () =>
  request<{ events: CalendarEvent[] }>('/api/calendar/today');

export const fetchEventsInRange = (
  startIso: string,
  endIso: string,
  timeZone?: string
) => {
  const params = new URLSearchParams({
    start: startIso,
    end: endIso,
  });
  if (timeZone) params.set('timeZone', timeZone);
  return request<{ events: CalendarEvent[] }>(
    `/api/calendar/events?${params.toString()}`
  );
};

export const fetchCalendarEvent = (id: string) =>
  request<{ event: CalendarEvent }>(`/api/calendar/events/${encodeURIComponent(id)}`);

export interface CalendarEventCreatePayload {
  title: string;
  description?: string;
  start: string;
  end: string;
  timeZone?: string;
  location?: string;
  patientId?: string;
  attachmentFileIds?: string[];
}

export type CalendarEventUpdatePayload = Partial<CalendarEventCreatePayload>;

export const createCalendarEvent = (payload: CalendarEventCreatePayload) =>
  request<{ event: CalendarEvent }>('/api/calendar/events', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

export const updateCalendarEvent = (
  id: string,
  payload: CalendarEventUpdatePayload
) =>
  request<{ event: CalendarEvent }>(`/api/calendar/events/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });

export const deleteCalendarEvent = (id: string) =>
  request<void>(`/api/calendar/events/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });

export const updateCalendarEventAttachments = (id: string, fileIds: string[]) =>
  request<{ event: CalendarEvent }>(
    `/api/calendar/events/${encodeURIComponent(id)}/attachments`,
    {
      method: 'POST',
      body: JSON.stringify({ fileIds }),
    }
  );

export const generatePrepNote = (patientId: string, patientName: string) =>
  request<{ prepNote: string }>('/api/calendar/prep-note', {
    method: 'POST',
    body: JSON.stringify({ patientId, patientName }),
  });

// --- PATIENTS (paginated) ---
interface PatientsResponse {
  patients: Patient[];
  nextPage: string | null;
}

export const fetchPatients = (page?: string): Promise<PatientsResponse> => {
  const params = new URLSearchParams();
  params.set('pageSize', '100');
  if (page) params.set('page', page);
  return request<PatientsResponse>(`/api/drive/patients?${params.toString()}`);
};

export async function fetchAllPatients(): Promise<Patient[]> {
  const all: Patient[] = [];
  let page: string | undefined;

  do {
    const data = await fetchPatients(page);
    all.push(...data.patients);
    page = data.nextPage ?? undefined;
  } while (page);

  return all;
}

export const createPatient = (name: string, dob: string, sex: 'M' | 'F') =>
  request<Patient>('/api/drive/patients', {
    method: 'POST',
    body: JSON.stringify({ name, dob, sex }),
  });

export const updatePatient = (id: string, updates: { name?: string; dob?: string; sex?: string }) =>
  request(`/api/drive/patients/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });

export const deletePatient = (id: string) =>
  request(`/api/drive/patients/${id}`, { method: 'DELETE' });

// --- SCRIBE SESSIONS (per patient) ---

export const fetchPatientSessions = (patientId: string) =>
  request<{ sessions: ScribeSession[] }>(
    `/api/drive/patients/${encodeURIComponent(patientId)}/sessions`
  );

export const savePatientSession = (
  patientId: string,
  payload: {
    sessionId?: string;
    transcript: string;
    context?: string;
    templates?: string[];
    noteTitles?: string[];
    notes?: Array<{ noteId: string; title: string; content: string; template_id: string }>;
    mainComplaint?: string;
  }
) =>
  request<{ sessions: ScribeSession[] }>(
    `/api/drive/patients/${encodeURIComponent(patientId)}/sessions`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  );

// --- FILES / FOLDER CONTENTS (paginated) ---
interface FilesResponse {
  files: DriveFile[];
  nextPage: string | null;
}

/** Fetch first page of files only (for fast initial render). Returns { files, nextPage }. */
export const fetchFilesFirstPage = async (
  patientId: string,
  pageSize = 100
): Promise<{ files: DriveFile[]; nextPage: string | null }> => {
  const data = await request<FilesResponse>(
    `/api/drive/patients/${patientId}/files?pageSize=${pageSize}`
  );
  return { files: data.files || [], nextPage: data.nextPage ?? null };
};

/** Warm-and-list: upload tiny temp file, get file list, server deletes temp. Makes list load reliably when plain list hangs. */
export const warmAndListFiles = async (
  patientId: string,
  pageSize = 24
): Promise<{ files: DriveFile[]; nextPage: string | null }> => {
  const data = await request<FilesResponse>(
    `/api/drive/patients/${patientId}/warm-and-list?pageSize=${pageSize}`,
    { method: 'POST' }
  );
  return { files: data.files || [], nextPage: data.nextPage ?? null };
};

/** Fetch a single page of files by token (for pagination). */
export const fetchFilesPage = async (
  patientId: string,
  pageToken: string
): Promise<{ files: DriveFile[]; nextPage: string | null }> => {
  const data = await request<FilesResponse>(
    `/api/drive/patients/${patientId}/files?pageSize=100&page=${encodeURIComponent(pageToken)}`
  );
  return { files: data.files || [], nextPage: data.nextPage ?? null };
};

/** Fetch all pages of files (can be slow for large folders). */
export const fetchFiles = async (patientId: string): Promise<DriveFile[]> => {
  const all: DriveFile[] = [];
  let page: string | undefined;

  do {
    const data = await request<FilesResponse>(
      `/api/drive/patients/${patientId}/files?pageSize=100${page ? `&page=${encodeURIComponent(page)}` : ''}`
    );
    all.push(...data.files);
    page = data.nextPage ?? undefined;
  } while (page);

  return all;
};

// Fetch contents of any folder by its Drive ID (used for subfolder navigation)
export const fetchFolderContents = async (folderId: string): Promise<DriveFile[]> => {
  const all: DriveFile[] = [];
  let page: string | undefined;

  do {
    const data = await request<FilesResponse>(
      `/api/drive/patients/${folderId}/files?pageSize=100${page ? `&page=${encodeURIComponent(page)}` : ''}`
    );
    all.push(...data.files);
    page = data.nextPage ?? undefined;
  } while (page);

  return all;
};

export const uploadFile = async (patientId: string, file: File, customName?: string): Promise<DriveFile> => {
  const base64 = await fileToBase64(file);
  return request<DriveFile>(`/api/drive/patients/${patientId}/upload`, {
    method: 'POST',
    body: JSON.stringify({
      fileName: customName || file.name,
      fileType: file.type,
      fileData: base64,
    }),
  });
};

export const updateFileMetadata = (_patientId: string, fileId: string, newName: string) =>
  request(`/api/drive/files/${fileId}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: newName }),
  });

export const deleteFile = (fileId: string) =>
  request(`/api/drive/files/${fileId}`, { method: 'DELETE' });

export const getFileDownloadUrl = (fileId: string) =>
  request<{ downloadUrl: string; viewUrl: string; name: string; mimeType: string }>(
    `/api/drive/files/${fileId}/download`
  );

export const createFolder = (parentId: string, name: string) =>
  request<DriveFile>(`/api/drive/patients/${parentId}/folder`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });

// --- AI ---
export const generatePatientSummary = async (patientName: string, files: DriveFile[], patientId?: string): Promise<string[]> => {
  return request<string[]>('/api/ai/summary', {
    method: 'POST',
    body: JSON.stringify({ patientName, patientId, files }),
  });
};

export const extractLabAlerts = async (content: string): Promise<LabAlert[]> => {
  return request<LabAlert[]>('/api/ai/lab-alerts', {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
};

export const analyzeAndRenameImage = async (base64Image: string): Promise<string> => {
  const data = await request<{ filename: string }>('/api/ai/analyze-image', {
    method: 'POST',
    body: JSON.stringify({ base64Image }),
  });
  return data.filename;
};

/** Transcribe audio to text only (no SOAP/note generation). Use Halo generate_note for notes. */
export const transcribeAudio = async (audioBase64: string, mimeType: string): Promise<string> => {
  const data = await request<{ transcript: string }>('/api/ai/transcribe', {
    method: 'POST',
    body: JSON.stringify({ audioBase64, mimeType }),
  });
  return data.transcript ?? '';
};

/** Ask Gemini to describe a single uploaded file for clinical context. */
export const describeFile = async (patientId: string, file: DriveFile): Promise<string> => {
  const data = await request<{ description: string }>('/api/ai/describe-file', {
    method: 'POST',
    body: JSON.stringify({
      patientId,
      fileId: file.id,
      name: file.name,
      mimeType: file.mimeType,
    }),
  });
  return data.description ?? '';
};

// --- Halo API (note generation + templates) ---
export const getHaloTemplates = (userId?: string) =>
  request<Record<string, unknown>>('/api/halo/templates', {
    method: 'POST',
    body: JSON.stringify(userId ? { user_id: userId } : {}),
  });

/** Generate note preview (return_type=note). Returns normalized notes array. */
export const generateNotePreview = (params: { template_id: string; text: string; user_id?: string }) =>
  request<{ notes: HaloNote[] }>('/api/halo/generate-note', {
    method: 'POST',
    body: JSON.stringify({ ...params, return_type: 'note' }),
  });

/** Generate DOCX and save to patient folder on Drive. Returns { success, fileId, name }. */
export const saveNoteAsDocx = (params: {
  patientId: string;
  template_id: string;
  text: string;
  fileName?: string;
  user_id?: string;
}) =>
  request<{ success: boolean; fileId: string; name: string }>('/api/halo/generate-note', {
    method: 'POST',
    body: JSON.stringify({
      template_id: params.template_id,
      text: params.text,
      return_type: 'docx',
      patientId: params.patientId,
      fileName: params.fileName,
      user_id: params.user_id,
    }),
  });

export const searchPatientsByConcept = async (
  query: string,
  patients: Patient[],
  files: Record<string, DriveFile[]>
): Promise<string[]> => {
  return request<string[]>('/api/ai/search', {
    method: 'POST',
    body: JSON.stringify({ query, patients, files }),
  });
};

export const askHalo = async (
  patientId: string,
  question: string,
  history: ChatMessage[]
): Promise<{ reply: string }> => {
  return request<{ reply: string }>('/api/ai/chat', {
    method: 'POST',
    body: JSON.stringify({ patientId, question, history }),
  });
};

/**
 * Stream HALO chat response via SSE. Calls onChunk for each text chunk,
 * onComplete when done. Uses 90s timeout for slow Gemini responses.
 */
export const askHaloStream = async (
  patientId: string,
  question: string,
  history: ChatMessage[],
  onChunk: (text: string) => void
): Promise<void> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 90_000);

  try {
    const res = await fetch(`${API_BASE}/api/ai/chat-stream`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patientId, question, history }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (res.status === 401) {
      window.location.href = '/';
      throw new ApiError('Not authenticated', 401);
    }

    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(err.error || `Request failed (${res.status})`, res.status);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new ApiError('No response body', 500);

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') return;
          try {
            const parsed = JSON.parse(data) as string;
            if (typeof parsed === 'string') onChunk(parsed);
          } catch {
            // Ignore parse errors for malformed chunks
          }
        }
      }
    }
  } finally {
    clearTimeout(timeoutId);
  }
};

// --- SETTINGS ---
export const loadSettings = () =>
  request<{ settings: UserSettings | null }>('/api/drive/settings');

export const saveSettings = (settings: UserSettings) =>
  request<{ success: boolean }>('/api/drive/settings', {
    method: 'PUT',
    body: JSON.stringify(settings),
  });

// --- UTILS ---
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
