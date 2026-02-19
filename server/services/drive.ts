import mammoth from 'mammoth';
import { config } from '../config';

// Polyfill browser APIs needed by pdf-parse (set up at module load time)
// These are needed because pdf-parse's dependency pdfjs-dist uses them at module load
const g = globalThis as any;

if (typeof g.DOMMatrix === 'undefined') {
  // Minimal DOMMatrix polyfill for Node.js
  g.DOMMatrix = class DOMMatrix {
    constructor(init?: string | number[]) {
      if (init) {
        if (typeof init === 'string') {
          const values = init.match(/matrix\(([^)]+)\)/)?.[1]?.split(',').map(Number) || [];
          this.a = values[0] ?? 1;
          this.b = values[1] ?? 0;
          this.c = values[2] ?? 0;
          this.d = values[3] ?? 1;
          this.e = values[4] ?? 0;
          this.f = values[5] ?? 0;
        }
      } else {
        this.a = 1;
        this.b = 0;
        this.c = 0;
        this.d = 1;
        this.e = 0;
        this.f = 0;
      }
    }
    a = 1;
    b = 0;
    c = 0;
    d = 1;
    e = 0;
    f = 0;
  };
}
if (typeof g.ImageData === 'undefined') {
  g.ImageData = class ImageData {
    constructor(public data: Uint8ClampedArray, public width: number, public height?: number) {}
  };
}
if (typeof g.Path2D === 'undefined') {
  g.Path2D = class Path2D {};
}

const { driveApi, uploadApi } = config;

const DRIVE_REQUEST_TIMEOUT_MS = 25_000;

/** fetch with timeout to avoid hanging on slow/hung Drive API */
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = DRIVE_REQUEST_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timeoutId);
  }
}

// --- Types ---

export interface DriveResponse {
  files?: DriveFileRaw[];
  nextPageToken?: string;
  id?: string;
  name?: string;
  mimeType?: string;
  webViewLink?: string;
  appProperties?: Record<string, string>;
  createdTime?: string;
  error?: { message: string; code: number };
}

export interface DriveFileRaw {
  id: string;
  name: string;
  mimeType: string;
  webViewLink?: string;
  thumbnailLink?: string;
  appProperties?: Record<string, string>;
  createdTime?: string;
}

// --- Core Helpers ---

/**
 * Make an authenticated request to the Google Drive API.
 * Throws on non-2xx responses so callers don't silently consume errors.
 */
export async function driveRequest(token: string, path: string, options: RequestInit = {}): Promise<DriveResponse> {
  const res = await fetchWithTimeout(
    `${driveApi}${path}`,
    {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(options.headers as Record<string, string> || {}),
      },
    },
    DRIVE_REQUEST_TIMEOUT_MS
  );

  const data = (await res.json()) as DriveResponse;

  if (!res.ok) {
    const msg = data.error?.message || `Drive API error ${res.status}`;
    throw new Error(`[Drive ${res.status}] ${msg}`);
  }

  return data;
}

/**
 * Find or create the Halo_Patients root folder in Google Drive.
 */
export async function getHaloRootFolder(token: string): Promise<string> {
  const searchQuery = encodeURIComponent(
    "mimeType='application/vnd.google-apps.folder' and name='Halo_Patients' and trashed=false"
  );
  const data = await driveRequest(token, `/files?q=${searchQuery}`);

  if (data.files && data.files.length > 0) {
    return data.files[0].id;
  }

  const createRes = await fetch(`${driveApi}/files`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'Halo_Patients',
      mimeType: 'application/vnd.google-apps.folder',
    }),
  });

  if (!createRes.ok) {
    throw new Error(`[Drive ${createRes.status}] Failed to create Halo_Patients folder`);
  }

  const folder = (await createRes.json()) as { id: string };
  return folder.id;
}

/**
 * Find or create a "Patient Notes" subfolder inside a patient folder.
 */
export async function getOrCreatePatientNotesFolder(token: string, patientFolderId: string): Promise<string> {
  const searchQuery = encodeURIComponent(
    `'${patientFolderId}' in parents and name='Patient Notes' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const data = await driveRequest(token, `/files?q=${searchQuery}&fields=files(id)`);

  if (data.files && data.files.length > 0) {
    return data.files[0].id;
  }

  const createRes = await fetch(`${driveApi}/files`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'Patient Notes',
      parents: [patientFolderId],
      mimeType: 'application/vnd.google-apps.folder',
    }),
  });

  if (!createRes.ok) {
    throw new Error(`[Drive ${createRes.status}] Failed to create Patient Notes folder`);
  }

  const folder = (await createRes.json()) as { id: string };
  return folder.id;
}

/**
 * Upload a buffer to Google Drive using multipart upload.
 */
export async function uploadToDrive(
  token: string,
  fileName: string,
  mimeType: string,
  parentFolderId: string,
  buffer: Buffer,
  appProperties?: Record<string, string>
): Promise<string> {
  const metadata: Record<string, unknown> = {
    name: fileName,
    parents: [parentFolderId],
    mimeType,
  };
  if (appProperties) {
    metadata.appProperties = appProperties;
  }

  const boundary = 'halo_upload_boundary';
  const metaPart = JSON.stringify(metadata);

  const multipartBody = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metaPart}\r\n` +
      `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
    ),
    buffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const uploadRes = await fetch(`${uploadApi}/files?uploadType=multipart`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body: multipartBody,
  });

  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    throw new Error(`[Drive ${uploadRes.status}] Upload failed for "${fileName}": ${errText}`);
  }

  const data = (await uploadRes.json()) as { id: string };
  return data.id;
}

/**
 * Download a file's text content from Google Drive.
 */
export async function downloadTextFromDrive(token: string, fileId: string): Promise<string> {
  const res = await fetch(`${driveApi}/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`[Drive ${res.status}] Failed to download text for file ${fileId}`);
  }
  return res.text();
}

/**
 * Download a file as a binary buffer from Google Drive.
 */
export async function downloadFileBuffer(token: string, fileId: string): Promise<Buffer> {
  const res = await fetch(`${driveApi}/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`[Drive ${res.status}] Failed to download file ${fileId}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Extract readable text from a Drive file based on its MIME type.
 * Supports: text/plain, Google Docs, PDF, DOCX, and Word.
 */
export async function extractTextFromFile(
  token: string,
  file: { id: string; name: string; mimeType: string },
  maxChars = 2000
): Promise<string> {
  try {
    if (file.mimeType === 'application/vnd.google-apps.document') {
      const exportRes = await fetch(
        `${driveApi}/files/${file.id}/export?mimeType=text/plain`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!exportRes.ok) {
        throw new Error(`[Drive ${exportRes.status}] Failed to export Google Doc ${file.id}`);
      }
      return (await exportRes.text()).substring(0, maxChars);
    }

    if (file.mimeType === 'text/plain' || file.name.endsWith('.txt')) {
      const text = await downloadTextFromDrive(token, file.id);
      return text.substring(0, maxChars);
    }

    if (file.mimeType === 'application/pdf' || file.name.endsWith('.pdf')) {
      const buffer = await downloadFileBuffer(token, file.id);
      // Dynamic import - polyfills are already set up at module load time
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: new Uint8Array(buffer) });
      const result = await parser.getText();
      await parser.destroy();
      return (result.text || '').substring(0, maxChars);
    }

    if (
      file.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      file.mimeType === 'application/msword' ||
      file.name.endsWith('.docx') ||
      file.name.endsWith('.doc')
    ) {
      const buffer = await downloadFileBuffer(token, file.id);
      const result = await mammoth.extractRawText({ buffer });
      return (result.value || '').substring(0, maxChars);
    }

    return '';
  } catch (err) {
    console.error(`[extractTextFromFile] Failed for ${file.name}:`, err);
    return '';
  }
}

/**
 * Recursively fetch all files in a Drive folder.
 */
export async function fetchAllFilesInFolder(
  token: string,
  folderId: string
): Promise<Array<{ id: string; name: string; mimeType: string }>> {
  const allFiles: Array<{ id: string; name: string; mimeType: string }> = [];
  const searchQuery = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const filesRes = await fetch(
    `${driveApi}/files?q=${searchQuery}&fields=files(id,name,mimeType)&pageSize=100`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!filesRes.ok) {
    throw new Error(`[Drive ${filesRes.status}] Failed to list files in folder ${folderId}`);
  }

  const data = (await filesRes.json()) as { files?: Array<{ id: string; name: string; mimeType: string }> };
  const files = data.files || [];

  for (const file of files) {
    allFiles.push(file);
    if (file.mimeType === 'application/vnd.google-apps.folder') {
      const subFiles = await fetchAllFilesInFolder(token, file.id);
      allFiles.push(...subFiles);
    }
  }
  return allFiles;
}

// --- Validation Helpers ---

export function sanitizeString(value: unknown, maxLength = 200): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/[<>]/g, '').slice(0, maxLength);
}

export function isValidDate(dateStr: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr) && !isNaN(Date.parse(dateStr));
}

export function isValidSex(sex: string): sex is 'M' | 'F' {
  return sex === 'M' || sex === 'F';
}

// --- Patient Folder Parsing ---

export function parseFolderString(folderName: string): { pName: string; pDob: string; pSex: string } | null {
  if (!folderName.includes('__')) return null;
  const parts = folderName.split('__');
  if (parts.length < 3) return null;

  let pName = parts[0];
  let pDob = parts[1];
  const pSex = parts[2];

  if (parts[0].includes('_')) {
    const nameParts = parts[0].split('_');
    if (nameParts.length > 1) {
      pName = `${nameParts[1]} ${nameParts[0]}`;
    } else {
      pName = parts[0].replace('_', ' ');
    }
    if (parts[1].includes('-')) {
      const d = parts[1].split('-');
      if (d[0].length === 2 && d[2]?.length === 4) {
        pDob = `${d[2]}-${d[1]}-${d[0]}`;
      }
    }
  }

  return { pName, pDob, pSex };
}

export function parsePatientFolder(f: DriveFileRaw) {
  let pName = f.appProperties?.patientName;
  let pDob = f.appProperties?.patientDob;
  let pSex = f.appProperties?.patientSex;

  if (f.name.includes('__')) {
    const parsed = parseFolderString(f.name);
    if (parsed) {
      const folderNameChanged = pName && pName !== 'Unknown' && parsed.pName !== pName;
      if (!pName || pName === 'Unknown' || pName.includes('_') || folderNameChanged) {
        pName = parsed.pName;
        pDob = parsed.pDob;
        pSex = parsed.pSex;
      }
    }
  } else {
    if (!pName || pName === 'Unknown') {
      pName = f.name;
    }
  }

  return {
    id: f.id,
    name: pName || f.name,
    dob: pDob || 'Unknown',
    sex: pSex || 'M',
    lastVisit: f.appProperties?.lastNoteDate || f.createdTime?.split('T')[0] || '',
    alerts: [] as string[],
  };
}
