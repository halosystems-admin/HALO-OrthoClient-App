/**
 * HALO Scheduler - In-memory job queue for clinical note conversion
 *
 * Flow: .txt (saved) → .docx (after 10 hours) → .pdf (after 24 hours)
 *
 * Uses Google Drive appProperties on files to track conversion state,
 * so pending jobs can be recovered on server restart.
 *
 * Tokens: Jobs store a refreshToken and obtain a fresh accessToken
 * just before each conversion, avoiding the stale-token problem
 * (Google access tokens expire after ~1 hour, but conversions run
 * 10-24 hours after job registration).
 */

import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';
import { config } from '../config';
import { uploadToDrive, downloadTextFromDrive } from '../services/drive';

const { driveApi, uploadApi } = config;

const DOCX_DELAY_MS = 10 * 60 * 60 * 1000; // 10 hours
const PDF_DELAY_MS = 24 * 60 * 60 * 1000;   // 24 hours
const CHECK_INTERVAL_MS = 5 * 60 * 1000;     // Check every 5 minutes
const MAX_RETRIES = 5;

export interface ConversionJob {
  fileId: string;
  patientFolderId: string;
  savedAt: string;
  status: 'pending_docx' | 'pending_pdf' | 'done';
  refreshToken: string;
  docxFileId?: string;
  retryCount?: number;
}

/**
 * Obtain a fresh access token from a refresh token.
 * Throws if the refresh fails (e.g. token revoked).
 */
async function refreshAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${errBody}`);
  }

  const data = (await res.json()) as { access_token?: string; error?: string };
  if (data.error || !data.access_token) {
    throw new Error(`Token refresh error: ${data.error || 'no access_token returned'}`);
  }

  return data.access_token;
}

// In-memory job queue
const jobQueue: Map<string, ConversionJob> = new Map();

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let hasRecovered = false;

/**
 * Register a new conversion job (called when a note is saved)
 */
export function registerConversionJob(job: ConversionJob): void {
  jobQueue.set(job.fileId, job);
  console.log(`[Scheduler] Registered conversion job for file ${job.fileId} (saved at ${job.savedAt})`);
}

/**
 * Recover pending conversion jobs from Google Drive appProperties.
 * Called once on the first authenticated request after server restart.
 * Scans the user's entire Halo_Patients folder tree for .txt files
 * with conversionStatus = 'pending_docx' or 'pending_pdf'.
 *
 * Requires both a current accessToken (to query Drive) and a refreshToken
 * (to store in recovered jobs for later use during conversion).
 */
export async function recoverPendingJobs(accessToken: string, refreshToken: string): Promise<number> {
  if (hasRecovered) return 0;
  if (!refreshToken) {
    console.log('[Scheduler] No refresh token available — skipping recovery');
    return 0;
  }
  hasRecovered = true;

  console.log('[Scheduler] Scanning Google Drive for pending conversion jobs...');

  let recovered = 0;

  try {
    // Find all .txt files with a pending conversionStatus
    for (const status of ['pending_docx', 'pending_pdf'] as const) {
      const query = encodeURIComponent(
        `mimeType='text/plain' and trashed=false and appProperties has { key='conversionStatus' and value='${status}' }`
      );
      const res = await fetch(
        `${driveApi}/files?q=${query}&fields=files(id,name,appProperties)&pageSize=100`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      if (!res.ok) {
        console.error(`[Scheduler] Drive query failed (${res.status}) during recovery`);
        continue;
      }

      const data = (await res.json()) as { files?: Array<{ id: string; name: string; appProperties?: Record<string, string> }> };
      const files = data.files || [];

      for (const file of files) {
        if (jobQueue.has(file.id)) continue;

        const props = file.appProperties || {};
        const savedAt = props.savedAt;
        const patientFolderId = props.patientFolderId;

        if (!savedAt || !patientFolderId) {
          console.log(`[Scheduler] Skipping ${file.id} (${file.name}) -- missing appProperties`);
          continue;
        }

        const job: ConversionJob = {
          fileId: file.id,
          patientFolderId,
          savedAt,
          status,
          refreshToken,
          docxFileId: props.docxFileId,
          retryCount: 0,
        };

        jobQueue.set(file.id, job);
        recovered++;
        console.log(`[Scheduler] Recovered job: ${file.name} (${file.id}) — status: ${status}, saved: ${savedAt}`);
      }
    }

    if (recovered > 0) {
      console.log(`[Scheduler] Recovered ${recovered} pending job(s). Processing immediately...`);
      processJobs().catch(err => {
        console.error('[Scheduler] Error processing recovered jobs:', err);
      });
    } else {
      console.log('[Scheduler] No pending jobs found on Drive.');
    }
  } catch (err) {
    console.error('[Scheduler] Recovery scan failed:', err);
    hasRecovered = false;
  }

  return recovered;
}

/**
 * Convert plain text content to a .docx buffer
 */
async function textToDocx(textContent: string, fileName: string): Promise<Buffer> {
  const lines = textContent.split('\n');
  const children: Paragraph[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('## ')) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: trimmed.replace('## ', ''), bold: true, size: 28 })],
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 240, after: 120 },
        })
      );
    } else if (trimmed.startsWith('# ')) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: trimmed.replace('# ', ''), bold: true, size: 32 })],
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 360, after: 120 },
        })
      );
    } else if (trimmed === '') {
      children.push(new Paragraph({ children: [] }));
    } else {
      const parts = trimmed.split(/(\*\*.*?\*\*)/g);
      const runs: TextRun[] = parts.map(part => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return new TextRun({ text: part.slice(2, -2), bold: true, size: 22, font: 'Calibri' });
        }
        return new TextRun({ text: part, size: 22, font: 'Calibri' });
      });
      children.push(new Paragraph({ children: runs, spacing: { after: 80 } }));
    }
  }

  const doc = new Document({
    sections: [{
      properties: {},
      children: [
        new Paragraph({
          children: [new TextRun({ text: fileName.replace('.txt', ''), bold: true, size: 28, font: 'Calibri' })],
          heading: HeadingLevel.TITLE,
          spacing: { after: 240 },
        }),
        new Paragraph({
          children: [new TextRun({
            text: `Generated by HALO on ${new Date().toLocaleDateString()}`,
            italics: true, size: 18, font: 'Calibri', color: '888888',
          })],
          spacing: { after: 360 },
        }),
        ...children,
      ],
    }],
  });

  return Buffer.from(await Packer.toBuffer(doc));
}

/**
 * Export a Google Drive file as PDF using the Drive export API.
 */
async function convertDocxToPdf(token: string, docxFileId: string, parentFolderId: string, baseName: string): Promise<string> {
  const docxRes = await fetch(`${driveApi}/files/${docxFileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!docxRes.ok) throw new Error(`[Drive ${docxRes.status}] Failed to download DOCX ${docxFileId}`);
  const docxBuffer = Buffer.from(await docxRes.arrayBuffer());

  const importMetadata = JSON.stringify({
    name: `${baseName}_temp_import`,
    parents: [parentFolderId],
    mimeType: 'application/vnd.google-apps.document',
  });

  const boundary = `halo_import_${crypto.randomUUID()}`;
  const importBody = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${importMetadata}\r\n` +
      `--${boundary}\r\nContent-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document\r\n\r\n`
    ),
    docxBuffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const importRes = await fetch(`${uploadApi}/files?uploadType=multipart`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body: importBody,
  });

  if (!importRes.ok) throw new Error(`[Drive ${importRes.status}] Failed to import DOCX as Google Doc`);
  const importedDoc = (await importRes.json()) as { id: string };

  // Use try/finally to guarantee cleanup of the temporary Google Doc,
  // even if PDF export or upload fails
  try {
    const pdfRes = await fetch(
      `${driveApi}/files/${importedDoc.id}/export?mimeType=application/pdf`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!pdfRes.ok) throw new Error(`[Drive ${pdfRes.status}] Failed to export Google Doc as PDF`);
    const pdfBuffer = Buffer.from(await pdfRes.arrayBuffer());

    const pdfFileId = await uploadToDrive(
      token,
      `${baseName}.pdf`,
      'application/pdf',
      parentFolderId,
      pdfBuffer,
      { generatedBy: 'halo_scheduler', sourceDocxId: docxFileId }
    );

    return pdfFileId;
  } finally {
    // Always clean up the temporary imported Google Doc
    try {
      await fetch(`${driveApi}/files/${importedDoc.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (cleanupErr) {
      console.error(`[Scheduler] Failed to delete temp Google Doc ${importedDoc.id}:`, cleanupErr);
    }
  }
}

/**
 * Process all pending jobs.
 * NOTE: Note conversion (txt→docx→pdf) is disabled; notes are now generated
 * via Halo Functions API and saved as DOCX directly. This loop is a no-op.
 */
async function processJobs(): Promise<void> {
  return; // Disabled: no longer converting .txt notes to docx/pdf
  const now = Date.now();

  for (const [fileId, job] of jobQueue.entries()) {
    const savedTime = new Date(job.savedAt).getTime();
    const elapsed = now - savedTime;

    try {
      // Refresh access token before processing — tokens expire after ~1 hour
      // but conversions run 10-24 hours after registration
      const token = await refreshAccessToken(job.refreshToken);

      if (job.status === 'pending_docx' && elapsed >= DOCX_DELAY_MS) {
        console.log(`[Scheduler] Converting ${fileId} to DOCX...`);

        const textContent = await downloadTextFromDrive(token, fileId);

        const fileInfoRes = await fetch(`${driveApi}/files/${fileId}?fields=name`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!fileInfoRes.ok) throw new Error(`Failed to fetch file info (${fileInfoRes.status})`);
        const fileInfo = (await fileInfoRes.json()) as { name: string };
        const baseName = fileInfo.name.replace('.txt', '');

        const docxBuffer = await textToDocx(textContent, fileInfo.name);

        const docxFileId = await uploadToDrive(
          token,
          `${baseName}.docx`,
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          job.patientFolderId,
          docxBuffer,
          { generatedBy: 'halo_scheduler', sourceTxtId: fileId, savedAt: job.savedAt }
        );

        job.status = 'pending_pdf';
        job.docxFileId = docxFileId;
        job.retryCount = 0;
        console.log(`[Scheduler] DOCX created: ${docxFileId} for file ${fileId}`);

        const patchRes = await fetch(`${driveApi}/files/${fileId}`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            appProperties: { conversionStatus: 'pending_pdf', docxFileId },
          }),
        });
        if (!patchRes.ok) console.warn(`[Scheduler] Failed to update appProperties for ${fileId}`);
      } else if (job.status === 'pending_pdf' && elapsed >= PDF_DELAY_MS && job.docxFileId) {
        console.log(`[Scheduler] Converting ${job.docxFileId} to PDF...`);

        const fileInfoRes = await fetch(`${driveApi}/files/${job.docxFileId}?fields=name`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!fileInfoRes.ok) throw new Error(`Failed to fetch docx file info (${fileInfoRes.status})`);
        const fileInfo = (await fileInfoRes.json()) as { name: string };
        const baseName = fileInfo.name.replace('.docx', '');

        const docxId = job.docxFileId!;
        const pdfFileId = await convertDocxToPdf(
          token,
          docxId,
          job.patientFolderId,
          baseName
        );

        job.status = 'done';
        console.log(`[Scheduler] PDF created: ${pdfFileId} for docx ${job.docxFileId}`);

        const patchRes = await fetch(`${driveApi}/files/${fileId}`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            appProperties: { conversionStatus: 'done', pdfFileId },
          }),
        });
        if (!patchRes.ok) console.warn(`[Scheduler] Failed to update appProperties for ${fileId}`);

        jobQueue.delete(fileId);
      }
    } catch (err) {
      job.retryCount = (job.retryCount || 0) + 1;
      console.error(`[Scheduler] Error processing job for file ${fileId} (attempt ${job.retryCount}/${MAX_RETRIES}):`, err);

      if ((job.retryCount ?? 0) >= MAX_RETRIES) {
        console.error(`[Scheduler] Job ${fileId} exceeded max retries — removing from queue`);
        jobQueue.delete(fileId);
      }
    }
  }
}

/**
 * Run the scheduler immediately (process all due jobs now).
 * Use this to trigger conversions without waiting for the 5-minute interval.
 */
export async function runSchedulerNow(): Promise<void> {
  await processJobs();
}

/**
 * Start the scheduler loop
 */
export function startScheduler(): void {
  if (schedulerInterval) return;

  console.log('[Scheduler] Starting conversion scheduler (checking every 5 minutes)');
  schedulerInterval = setInterval(processJobs, CHECK_INTERVAL_MS);

  processJobs().catch(err => {
    console.error('[Scheduler] Initial processing error:', err);
  });
}

/**
 * Stop the scheduler
 */
export function stopScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log('[Scheduler] Stopped');
  }
}

/**
 * Get current job queue status (safe for API responses — no tokens exposed)
 */
export function getSchedulerStatus(): { totalJobs: number; jobs: Array<Omit<ConversionJob, 'refreshToken'>> } {
  return {
    totalJobs: jobQueue.size,
    jobs: Array.from(jobQueue.values()).map(({ refreshToken: _rt, ...rest }) => rest),
  };
}
