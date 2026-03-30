import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import * as path from 'path';
import PizZip from 'pizzip';
import { config } from '../config';
import { downloadDriveFileAsDocxTemplateBuffer } from './drive';

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildWordParagraphXml(line: string): string {
  // Minimal paragraph/run/text that Word understands.
  const safe = escapeXml(line);
  return `<w:p><w:r><w:t xml:space="preserve">${safe}</w:t></w:r></w:p>`;
}

function injectBodyIntoDocumentXml(documentXml: string, bodyText: string): string {
  const lines = bodyText.split(/\r?\n/);
  const paragraphs = lines.map(buildWordParagraphXml).join('');

  // Replace any existing {{body}} tag if present (even if the braces are split in runs, we can't reliably match it).
  // Instead, append the content near the end of the document body (before sectPr if present).
  const bodyOpen = documentXml.indexOf('<w:body');
  if (bodyOpen === -1) return documentXml;

  const sectPrIdx = documentXml.lastIndexOf('<w:sectPr');
  if (sectPrIdx !== -1) {
    return documentXml.slice(0, sectPrIdx) + paragraphs + documentXml.slice(sectPrIdx);
  }
  const bodyClose = documentXml.lastIndexOf('</w:body>');
  if (bodyClose !== -1) {
    return documentXml.slice(0, bodyClose) + paragraphs + documentXml.slice(bodyClose);
  }
  return documentXml + paragraphs;
}

export type LetterheadPlaceholders = {
  NAME?: string;
  DOB?: string;
  DATE?: string;
  DOCUMENT_TYPE?: string;
};

/**
 * One field for the whole letter: optional title/patient/date lines, then clinical text.
 * Put a single `{{body}}` placeholder in the Word template (body + line breaks supported).
 */
export function buildLetterheadBody(documentText: string, placeholders?: LetterheadPlaceholders): string {
  const ph = placeholders;
  if (!ph) return documentText;

  const rawType = ph.DOCUMENT_TYPE?.trim();
  const type = rawType && rawType.toLowerCase() !== 'other' ? rawType : undefined;
  const name = ph.NAME?.trim();
  const rawDob = ph.DOB?.trim();
  const dob =
    rawDob && rawDob.toLowerCase() !== 'not provided' && rawDob.toLowerCase() !== 'unknown'
      ? rawDob
      : undefined;
  const date = ph.DATE?.trim();

  const hasMeta = Boolean(type || name || dob || date);
  if (!hasMeta) return documentText;

  const lines: string[] = [];
  if (type) lines.push(type);
  const patientLine = [name, dob ? `DOB: ${dob}` : ''].filter(Boolean).join(' — ');
  if (patientLine) lines.push(patientLine);
  if (date) lines.push(`Date: ${date}`);
  lines.push('');
  lines.push(documentText);
  return lines.join('\n');
}

/** If local path is a directory, pick a single .dotx / .docx (prefers common letterhead names). */
export function resolveLetterheadLocalTemplateFile(localPath: string): string | null {
  if (!localPath || !existsSync(localPath)) return null;
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(localPath);
  } catch {
    return null;
  }
  if (st.isFile()) return localPath;
  if (!st.isDirectory()) return null;

  const names = readdirSync(localPath);
  const low = (n: string) => n.toLowerCase();
  const ranked = [
    'letter head.dotx',
    'letterhead.dotx',
    'letter head.docx',
    'letterhead.docx',
  ];
  for (const want of ranked) {
    const hit = names.find((n) => low(n) === want);
    if (hit) return path.join(localPath, hit);
  }
  const dotx = names.filter((n) => low(n).endsWith('.dotx')).sort();
  if (dotx.length >= 1) return path.join(localPath, dotx[0]);
  const docx = names.filter((n) => low(n).endsWith('.docx')).sort();
  if (docx.length >= 1) return path.join(localPath, docx[0]);
  return null;
}

/**
 * Load OOXML template (.dotx / .docx) from Drive (preferred) or HALO_LETTERHEAD_LOCAL_PATH.
 * Template needs one placeholder: {{body}}.
 */
export async function fetchLetterheadTemplateBuffer(
  accessToken: string,
  opts?: { driveFileId?: string; localPathOverride?: string }
): Promise<Buffer> {
  const id = (opts?.driveFileId ?? config.haloLetterheadDriveFileId)?.trim();
  if (id) {
    try {
      return await downloadDriveFileAsDocxTemplateBuffer(accessToken, id);
    } catch (e) {
      console.warn('[letterhead] Drive template download failed, trying local path if set:', e);
    }
  }
  const localRaw = (opts?.localPathOverride ?? config.haloLetterheadLocalPath).trim();
  const localFile = localRaw ? resolveLetterheadLocalTemplateFile(localRaw) : null;
  if (localFile) {
    console.log('[letterhead] using local template:', localFile);
    return readFileSync(localFile);
  }
  throw new Error(
    id
      ? 'Could not load letterhead: Drive download failed and HALO_LETTERHEAD_LOCAL_PATH is missing, invalid, or has no .docx/.dotx.'
      : 'Letterhead not configured: set HALO_LETTERHEAD_DRIVE_FILE_ID (or leave default) or HALO_LETTERHEAD_LOCAL_PATH (file or folder with one Word template).'
  );
}

export function mergeLetterheadDocx(templateBuffer: Buffer, body: string): Buffer {
  const zip = new PizZip(templateBuffer);

  // Robust path: directly inject paragraphs into word/document.xml (no placeholder parsing).
  // This avoids docxtemplater "Multi error" issues caused by how Word/Google Docs splits braces in XML.
  const docFile = zip.file('word/document.xml');
  if (!docFile) {
    throw new Error('Letterhead template is missing word/document.xml (invalid .docx).');
  }
  const originalXml = docFile.asText();
  const updatedXml = injectBodyIntoDocumentXml(originalXml, body ?? '');
  zip.file('word/document.xml', updatedXml);

  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer;
}
