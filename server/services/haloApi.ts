/**
 * Halo Functions API client.
 * Centralizes calls to generate_note and get_templates with error handling.
 */

import { config } from '../config';

const BASE = config.haloApiBaseUrl;

const HALO_REQUEST_TIMEOUT_MS = 90_000;

async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = HALO_REQUEST_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    return res;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Halo note service took too long to respond. Please try again.');
    }
    throw err;
  }
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

const META_KEYS = new Set(['noteId', 'id', 'title', 'name', 'template_id', 'templateId', 'lastSavedAt', 'sections', 'fields', 'notes', 'data']);

/** Extract structured fields from raw generate_note response (object with named sections). */
function extractFieldsFromNoteData(data: unknown): NoteField[] | null {
  if (data == null || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;

  // Shape: { "sections": [ { "name": "X", "content": "Y" } ] }
  if (Array.isArray(obj.sections)) {
    const fields: NoteField[] = [];
    for (const s of obj.sections as Array<Record<string, unknown>>) {
      const label = (s.name ?? s.title ?? s.label) as string;
      const body = (s.content ?? s.body ?? s.value ?? s.text ?? '') as string;
      if (label && typeof label === 'string') fields.push({ label, body: String(body ?? '') });
    }
    if (fields.length > 0) return fields;
  }

  // Shape: { "fields": [ { "label": "X", "value": "Y" } ] } or { "key": "X", "value": "Y" }
  if (Array.isArray(obj.fields)) {
    const fields: NoteField[] = [];
    for (const f of obj.fields as Array<Record<string, unknown>>) {
      const label = (f.label ?? f.name ?? f.title ?? f.key) as string;
      const body = (f.value ?? f.body ?? f.content ?? f.text ?? '') as string;
      if (label && typeof label === 'string') fields.push({ label, body: String(body ?? '') });
    }
    if (fields.length > 0) return fields;
  }

  // Single object with key/value (e.g. { key: "facility", value: "..." })
  if (typeof obj.key === 'string' && obj.key.length > 0) {
    const body = String(obj.value ?? obj.body ?? obj.content ?? '');
    return [{ label: obj.key, body }];
  }

  // Shape: { "Subjective": "...", "Objective": "...", "Plan": "..." } — object with string values
  const entries = Object.entries(obj).filter(
    ([k]) => !META_KEYS.has(k) && !k.startsWith('_')
  );
  const allStrings = entries.length > 0 && entries.every(([, v]) => typeof v === 'string');
  if (allStrings && entries.length > 0) {
    return entries.map(([label, body]) => ({ label, body: (body as string) || '' }));
  }

  return null;
}

function fieldsToContent(fields: NoteField[]): string {
  return fields.map(f => (f.label ? `${f.label}:\n${f.body || ''}` : f.body)).filter(Boolean).join('\n\n');
}

/** Normalize upstream response to array of HaloNote. Handles various shapes from Halo webhook. */
function normalizeNotesResponse(data: unknown, templateId: string): HaloNote[] {
  const now = new Date().toISOString();
  const oneNote = (content: string, title = 'Note 1', fields?: NoteField[]): HaloNote => ({
    noteId: `note-0-${Date.now()}`,
    title,
    content,
    template_id: templateId,
    lastSavedAt: now,
    dirty: false,
    ...(fields && fields.length > 0 ? { fields } : {}),
  });

  if (data == null) return [];

  if (typeof data === 'string' && data.trim()) {
    return [oneNote(data.trim())];
  }

  if (Array.isArray(data)) {
    // Array of field-like objects { key, value } or { label, body } → one note with all fields
    const first = data[0];
    if (
      data.length > 0 &&
      first != null &&
      typeof first === 'object' &&
      !Array.isArray(first) &&
      ('key' in first || 'label' in first || 'name' in first)
    ) {
      const fields: NoteField[] = (data as Array<Record<string, unknown>>).map((f) => {
        const label = String(f.label ?? f.name ?? f.title ?? f.key ?? '');
        const body = String(f.value ?? f.body ?? f.content ?? f.text ?? '');
        return { label, body };
      }).filter((f) => f.label.length > 0);
      if (fields.length > 0) {
        return [oneNote(fieldsToContent(fields), 'Note 1', fields)];
      }
    }
    return data.map((item: any, i: number) => {
      const fields = extractFieldsFromNoteData(item);
      const content = typeof item.content === 'string' ? item.content : (item.text ?? item.note ?? item.body ?? '');
      const finalContent = content || (fields ? fieldsToContent(fields) : String(item));
      return {
        noteId: item.noteId ?? item.id ?? `note-${i}-${Date.now()}`,
        title: item.title ?? item.name ?? `Note ${i + 1}`,
        content: finalContent,
        template_id: item.template_id ?? item.templateId ?? templateId,
        lastSavedAt: item.lastSavedAt ?? now,
        dirty: false,
        ...(fields && fields.length > 0 ? { fields } : {}),
      };
    }).filter(n => n.content.length > 0);
  }

  const obj = data as Record<string, unknown>;
  if (typeof obj !== 'object') return [];

  if (obj.notes && Array.isArray(obj.notes)) {
    return normalizeNotesResponse(obj.notes, templateId);
  }
  if (obj.data != null) {
    const out = normalizeNotesResponse(obj.data, templateId);
    if (out.length > 0) return out;
  }
  if (obj.note != null && typeof obj.note === 'object') {
    const out = normalizeNotesResponse(obj.note, templateId);
    if (out.length > 0) return out;
  }
  if (obj.result != null && typeof obj.result === 'object') {
    const out = normalizeNotesResponse(obj.result, templateId);
    if (out.length > 0) return out;
  }

  // Try structured fields from the root object (e.g. { Subjective: "...", Objective: "..." })
  const fields = extractFieldsFromNoteData(obj);
  if (fields && fields.length > 0) {
    const content = fieldsToContent(fields);
    const title = (obj.title as string) ?? (obj.name as string) ?? 'Note 1';
    return [oneNote(content, title, fields)];
  }

  const content =
    obj.content ??
    obj.text ??
    obj.note ??
    obj.body ??
    obj.result ??
    obj.output ??
    obj.generated_note ??
    obj.note_content ??
    obj.message;
  if (typeof content === 'string' && content.trim()) {
    return [oneNote(content.trim(), (obj.title as string) ?? (obj.name as string) ?? 'Note 1')];
  }

  // Unrecognized shape: log so we can extend the normalizer for the real HALO response
  if (typeof obj === 'object' && obj !== null) {
    const keys = Object.keys(obj).filter((k) => !k.startsWith('_'));
    console.warn('[Halo] generate_note response not recognized. Top-level keys:', keys.join(', ') || '(none)');
  }
  return [];
}

/**
 * Fetch templates for a user from Halo (Firebase RTDB).
 */
export async function getTemplates(userId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/get_templates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId }),
  });

  if (!res.ok) {
    if (res.status === 400) throw new Error('Invalid request to Halo templates.');
    if (res.status === 502) throw new Error('Halo templates service unavailable. Please try again.');
    throw new Error(`Halo templates error: ${res.status}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  return data;
}

export interface GenerateNoteParams {
  user_id: string;
  template_id: string;
  text: string;
  return_type: 'note' | 'docx';
}

/**
 * Generate note (preview) or DOCX. For return_type 'note' returns normalized notes array.
 * For return_type 'docx' returns the raw buffer.
 */
export async function generateNote(params: GenerateNoteParams): Promise<HaloNote[] | Buffer> {
  const { return_type } = params;

  const res = await fetchWithTimeout(
    `${BASE}/generate_note`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: params.user_id,
        template_id: params.template_id,
        text: params.text,
        return_type,
      }),
    },
    HALO_REQUEST_TIMEOUT_MS
  );

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 400) throw new Error('Invalid request to Halo note generation.');
    if (res.status === 404) {
      try {
        const parsed = body ? JSON.parse(body) : null;
        if (parsed && typeof parsed.detail === 'string') console.error('[Halo] 404 detail:', parsed.detail);
        else if (body) console.error('[Halo] 404 body:', body.slice(0, 200));
      } catch {
        if (body) console.error('[Halo] 404 body:', body.slice(0, 200));
      }
      throw new Error(
        'Halo returned 404: template or user not found. Check that template_id and HALO_USER_ID (or user_id) exist in the Halo service. If the Halo API base URL or paths changed, update HALO_API_BASE_URL.'
      );
    }
    if (res.status === 502) throw new Error('Halo note service unavailable. Please try again.');
    throw new Error(`Halo generate_note error: ${res.status}`);
  }

  if (return_type === 'docx') {
    const buffer = Buffer.from(await res.arrayBuffer());
    return buffer;
  }

  const data = (await res.json()) as unknown;
  // Log HALO response for debugging (truncate if large)
  const logged =
    typeof data === 'string'
      ? data.slice(0, 800)
      : JSON.stringify(data).slice(0, 1200);
  console.log('[Halo] generate_note response:', logged + (JSON.stringify(data).length > 1200 ? '…' : ''));

  const notes = normalizeNotesResponse(data, params.template_id);
  const withRaw = notes.map((note) => ({ ...note, raw: data }));

  // If normalizer didn't recognize the shape, still return one note with raw so the client can display it.
  // Use empty title so the client uses the template display name (e.g. "Op Report") for the tab.
  if (withRaw.length === 0 && data != null) {
    const readable =
      typeof data === 'object' && data !== null && !Array.isArray(data)
        ? Object.entries(data as Record<string, unknown>)
            .filter(([k]) => !['noteId', 'id', 'title', 'template_id', 'sections', 'fields', 'notes', 'data'].includes(k))
            .map(([k, v]) => `${k}:\n${typeof v === 'string' ? v : JSON.stringify(v)}`)
            .join('\n\n')
        : typeof data === 'string'
          ? data
          : JSON.stringify(data, null, 2);
    return [
      {
        noteId: `note-0-${Date.now()}`,
        title: '',
        content: readable,
        template_id: params.template_id,
        lastSavedAt: new Date().toISOString(),
        dirty: false,
        raw: data,
      },
    ];
  }
  return withRaw;
}
