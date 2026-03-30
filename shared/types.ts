// Shared types used by both client and server

export interface Patient {
  id: string;
  name: string;
  dob: string;
  sex: 'M' | 'F';
  lastVisit: string;
  alerts: string[];
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  url: string;
  thumbnail?: string;
  createdTime: string;
}

export const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

export interface BreadcrumbItem {
  id: string;
  name: string;
}

export interface LabAlert {
  parameter: string;
  value: string;
  severity: "high" | "medium" | "low";
  context: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface AssistantOrchestrationResult {
  placeholders: {
    NAME: string;
    DOB: string;
    DATE: string;
    DOCUMENT_TYPE: string;
  };
  documentBody: string;
  tasks: string[];
  warnings: string[];
}

export enum AppStatus {
  IDLE = 'idle',
  LOADING = 'loading',
  UPLOADING = 'uploading',
  ANALYZING = 'analyzing',
  SAVING = 'saving',
  FILING = 'filing'
}

export interface UserSettings {
  // Profile (mandatory)
  firstName: string;
  lastName: string;
  profession: string;
  department: string;
  // Profile (optional)
  city: string;
  postalCode: string;
  university: string;
  // Template (legacy)
  noteTemplate: 'soap' | 'custom';
  customTemplateContent: string;
  customTemplateName: string;
  // Halo template (for generate_note)
  templateId?: string;
  /** Custom image for the app home screen (when no patient selected). Data URL or URL. */
  homeScreenImageUrl?: string;
  /** Optional per-user letterhead stored in Drive (uploaded from Settings). */
  letterheadDriveFileId?: string;
  letterheadFileName?: string;
}

export interface NoteField {
  label: string;
  body: string;
}

export interface HaloNote {
  noteId: string;
  title: string;
  content: string;
  template_id: string;
  lastSavedAt?: string;
  dirty?: boolean;
  /** Structured fields from generate_note (for preview before DOCX) */
  fields?: NoteField[];
  /** Raw JSON payload returned by HALO generate_note (for debugging/display). */
  raw?: unknown;
}

export interface HaloTemplate {
  id: string;
  name?: string;
  [key: string]: unknown;
}

export interface CalendarAttachment {
  fileId: string;
  name?: string;
  url?: string;
  mimeType?: string;
}

export interface CalendarEvent {
  id: string;
  /** Underlying Google Calendar ID, if different from id */
  calendarId?: string;
  start: string;
  end: string;
  title: string;
  description?: string;
  location?: string;
  /** Matched HALO patient id, if any */
  patientId?: string;
  /** Optional display color hint for UI */
  color?: string;
  /** Attached Drive files or attachment metadata */
  attachments?: CalendarAttachment[];
  /** Additional metadata from Google extendedProperties.private */
  extendedProps?: Record<string, string>;
}

export interface ScribeSession {
  /** Unique session id (per patient). */
  id: string;
  /** Google Drive patient folder id this session belongs to. */
  patientId: string;
  /** ISO timestamp when the session was created. */
  createdAt: string;
  /** Full transcript text used to generate notes. */
  transcript: string;
  /** Optional free-text context captured alongside the transcript. */
  context?: string;
  /** Template IDs that were used to generate notes in this session. */
  templates?: string[];
  /** Human-readable note titles generated in this session (for display only). */
  noteTitles?: string[];
  /** Generated note content for this session (so we can show the actual note, not just transcript). */
  notes?: Array<{ noteId: string; title: string; content: string; template_id: string }>;
  /** Short main complaint/summary for list display (e.g. "Ankle Fracture"). */
  mainComplaint?: string;
}
