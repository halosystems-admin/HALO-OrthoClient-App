import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import { config } from '../config';
import {
  driveRequest,
  getHaloRootFolder,
  getOrCreatePatientNotesFolder,
  sanitizeString,
  isValidDate,
  isValidSex,
  parseFolderString,
  parsePatientFolder,
} from '../services/drive';
// Scheduler disabled; run-scheduler and scheduler-status kept for optional manual use
import { runSchedulerNow, getSchedulerStatus } from '../jobs/scheduler';
import type { ScribeSession } from '../../shared/types';

const router = Router();
router.use(requireAuth);

const { driveApi, uploadApi } = config;

const MAX_FILE_SIZE_MB = 25;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
const ALLOWED_UPLOAD_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
  'application/pdf',
  'text/plain', 'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
];
const DEFAULT_PAGE_SIZE = 50;

// Internal app file — never show in patient folder listing
const SESSIONS_FILE_NAME = 'halo_scribe_sessions.json';

// In-memory cache for first page of file list (per folder). Makes repeat views instant.
const FILES_CACHE_TTL_MS = 30_000; // 30 seconds
const filesListCache = new Map<string, { files: Array<{ id: string; name: string; mimeType: string; url: string; thumbnail?: string; createdTime: string }>; nextPage: string | null; cachedAt: number }>();

function invalidateFilesCacheForFolder(folderId: string): void {
  for (const key of filesListCache.keys()) {
    if (key.startsWith(`${folderId}:`)) filesListCache.delete(key);
  }
}

// --- Routes ---

// GET /patients?page=<token>&pageSize=<number>
router.get('/patients', async (req: Request, res: Response) => {
  try {
    const token = req.session.accessToken!;

    const rootId = await getHaloRootFolder(token);

    const pageSize = Math.min(Number(req.query.pageSize) || DEFAULT_PAGE_SIZE, 100);
    const pageToken = typeof req.query.page === 'string' ? req.query.page : undefined;

    let url = `/files?q=${encodeURIComponent(
      `'${rootId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`
    )}&fields=files(id,name,appProperties,createdTime),nextPageToken&pageSize=${pageSize}`;

    if (pageToken) {
      url += `&pageToken=${encodeURIComponent(pageToken)}`;
    }

    const data = await driveRequest(token, url);
    const patients = (data.files || []).map(parsePatientFolder);

    // Auto-heal: update appProperties if folder name was changed in Drive
    for (const f of data.files || []) {
      if (!f.name.includes('__')) continue;
      const parsed = parseFolderString(f.name);
      if (!parsed) continue;
      const storedName = f.appProperties?.patientName;
      const storedDob = f.appProperties?.patientDob;
      const storedSex = f.appProperties?.patientSex;
      if (parsed.pName !== storedName || parsed.pDob !== storedDob || parsed.pSex !== storedSex) {
        fetch(`${driveApi}/files/${f.id}`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            appProperties: {
              patientName: parsed.pName,
              patientDob: parsed.pDob,
              patientSex: parsed.pSex,
            },
          }),
        }).catch(() => {});
      }
    }

    res.json({ patients, nextPage: data.nextPageToken || null });
  } catch (err) {
    console.error('Fetch patients error:', err);
    res.status(500).json({ error: 'Failed to fetch patients.' });
  }
});

// POST /run-scheduler — run conversion jobs immediately (no wait for 5-min interval)
router.post('/run-scheduler', async (_req: Request, res: Response) => {
  try {
    await runSchedulerNow();
    res.json({ ok: true, message: 'Scheduler ran. Due conversions have been processed.' });
  } catch (err) {
    console.error('Run scheduler error:', err);
    res.status(500).json({ error: 'Scheduler run failed.' });
  }
});

// GET /scheduler-status — check pending conversion jobs count
router.get('/scheduler-status', async (_req: Request, res: Response) => {
  try {
    const status = getSchedulerStatus();
    const pendingJobs = status.jobs.filter(j => j.status !== 'done');
    const dueJobs = pendingJobs.filter(j => {
      const elapsed = Date.now() - new Date(j.savedAt).getTime();
      if (j.status === 'pending_docx') return elapsed >= 10 * 60 * 60 * 1000;
      if (j.status === 'pending_pdf') return elapsed >= 24 * 60 * 60 * 1000;
      return false;
    });
    res.json({
      totalPending: pendingJobs.length,
      totalDue: dueJobs.length,
      jobs: pendingJobs.map(j => ({
        fileId: j.fileId,
        status: j.status,
        savedAt: j.savedAt,
      })),
    });
  } catch (err) {
    console.error('Scheduler status error:', err);
    res.status(500).json({ error: 'Failed to get scheduler status.' });
  }
});

// POST /patients
router.post('/patients', async (req: Request, res: Response) => {
  try {
    const name = sanitizeString(req.body.name);
    const dob = sanitizeString(req.body.dob);
    const sex = sanitizeString(req.body.sex);

    if (!name || name.length < 2) {
      res.status(400).json({ error: 'Patient name must be at least 2 characters.' });
      return;
    }
    if (!dob || !isValidDate(dob)) {
      res.status(400).json({ error: 'Invalid date of birth. Use YYYY-MM-DD format.' });
      return;
    }
    if (!isValidSex(sex)) {
      res.status(400).json({ error: 'Sex must be M or F.' });
      return;
    }

    const token = req.session.accessToken!;
    const rootId = await getHaloRootFolder(token);

    const createRes = await fetch(`${driveApi}/files`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `${name}__${dob}__${sex}`,
        parents: [rootId],
        mimeType: 'application/vnd.google-apps.folder',
        appProperties: {
          type: 'patient_folder',
          patientName: name,
          patientDob: dob,
          patientSex: sex,
        },
      }),
    });

    const folder = (await createRes.json()) as { id: string };
    res.json({
      id: folder.id,
      name,
      dob,
      sex,
      lastVisit: new Date().toISOString().split('T')[0],
      alerts: [],
    });
  } catch (err) {
    console.error('Create patient error:', err);
    res.status(500).json({ error: 'Failed to create patient.' });
  }
});

// PATCH /patients/:id
router.patch('/patients/:id', async (req: Request, res: Response) => {
  try {
    const token = req.session.accessToken!;
    const { id } = req.params;

    const name = req.body.name ? sanitizeString(req.body.name) : undefined;
    const dob = req.body.dob ? sanitizeString(req.body.dob) : undefined;
    const sex = req.body.sex ? sanitizeString(req.body.sex) : undefined;

    if (name !== undefined && name.length < 2) {
      res.status(400).json({ error: 'Patient name must be at least 2 characters.' });
      return;
    }
    if (dob !== undefined && !isValidDate(dob)) {
      res.status(400).json({ error: 'Invalid date of birth. Use YYYY-MM-DD format.' });
      return;
    }
    if (sex !== undefined && !isValidSex(sex)) {
      res.status(400).json({ error: 'Sex must be M or F.' });
      return;
    }

    const current = await driveRequest(token, `/files/${id}?fields=name,appProperties`);

    let currentName = current.appProperties?.patientName;
    let currentDob = current.appProperties?.patientDob;
    let currentSex = current.appProperties?.patientSex;

    const needsParsing = !currentName || currentName === 'Unknown' || currentName?.includes('_');
    if (needsParsing && current.name?.includes('__')) {
      const parsed = parseFolderString(current.name);
      if (parsed) {
        currentName = parsed.pName;
        currentDob = parsed.pDob;
        currentSex = parsed.pSex;
      }
    }

    const finalName = name || currentName || 'Unknown';
    const finalDob = dob || currentDob || 'Unknown';
    const finalSex = sex || currentSex || 'M';

    await fetch(`${driveApi}/files/${id}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `${finalName}__${finalDob}__${finalSex}`,
        appProperties: {
          patientName: finalName,
          patientDob: finalDob,
          patientSex: finalSex,
        },
      }),
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Update patient error:', err);
    res.status(500).json({ error: 'Failed to update patient.' });
  }
});

// DELETE /patients/:id
router.delete('/patients/:id', async (req: Request, res: Response) => {
  try {
    const token = req.session.accessToken!;
    await fetch(`${driveApi}/files/${req.params.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ trashed: true }),
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete patient error:', err);
    res.status(500).json({ error: 'Failed to delete patient.' });
  }
});

// POST /patients/:id/folder - Create a subfolder
router.post('/patients/:id/folder', async (req: Request, res: Response) => {
  try {
    const token = req.session.accessToken!;
    const name = sanitizeString(req.body.name, 255);

    if (!name || name.length < 1) {
      res.status(400).json({ error: 'Folder name is required.' });
      return;
    }

    const createRes = await fetch(`${driveApi}/files`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name,
        parents: [req.params.id],
        mimeType: 'application/vnd.google-apps.folder',
      }),
    });

    const folder = (await createRes.json()) as { id: string; name: string; mimeType: string; createdTime?: string };
    const parentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    invalidateFilesCacheForFolder(parentId);
    res.json({
      id: folder.id,
      name: folder.name,
      mimeType: folder.mimeType,
      url: '',
      createdTime: folder.createdTime?.split('T')[0] ?? new Date().toISOString().split('T')[0],
    });
  } catch (err) {
    console.error('Create folder error:', err);
    res.status(500).json({ error: 'Failed to create folder.' });
  }
});

// GET /patients/:id/files?page=<token>&pageSize=<number>
router.get('/patients/:id/files', async (req: Request, res: Response) => {
  try {
    const token = req.session.accessToken!;
    const folderId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const pageSize = Math.min(Number(req.query.pageSize) || DEFAULT_PAGE_SIZE, 100);
    const pageToken = typeof req.query.page === 'string' ? req.query.page : undefined;

    // First page only: serve from cache if fresh (avoids hitting Drive on repeat views)
    if (!pageToken) {
      const cacheKey = `${folderId}:${pageSize}`;
      const cached = filesListCache.get(cacheKey);
      if (cached && Date.now() - cached.cachedAt < FILES_CACHE_TTL_MS) {
        return res.json({ files: cached.files, nextPage: cached.nextPage });
      }
    }

    // Minimal fields for list: omit thumbnailLink to speed up Drive API response
    let url = `/files?q=${encodeURIComponent(
      `'${folderId}' in parents and trashed=false`
    )}&fields=files(id,name,mimeType,webViewLink,createdTime),nextPageToken&pageSize=${pageSize}`;

    if (pageToken) {
      url += `&pageToken=${encodeURIComponent(pageToken)}`;
    }

    const start = Date.now();
    const data = await driveRequest(token, url);
    const elapsed = Date.now() - start;
    if (elapsed > 3000) {
      console.warn(`[Drive] Slow files list: ${elapsed}ms for folder ${folderId.slice(0, 8)}…`);
    }

    const files = (data.files || [])
      .filter((f) => f.name !== SESSIONS_FILE_NAME)
      .map((f) => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      url: f.webViewLink ?? '',
      thumbnail: undefined,
      createdTime: f.createdTime?.split('T')[0] ?? '',
    }));

    // Cache first page for repeat views
    if (!pageToken) {
      const cacheKey = `${folderId}:${pageSize}`;
      filesListCache.set(cacheKey, { files, nextPage: data.nextPageToken || null, cachedAt: Date.now() });
      // Keep cache bounded (e.g. last 50 entries)
      if (filesListCache.size > 50) {
        const oldest = [...filesListCache.entries()].sort((a, b) => a[1].cachedAt - b[1].cachedAt)[0];
        if (oldest) filesListCache.delete(oldest[0]);
      }
    }

    res.json({ files, nextPage: data.nextPageToken || null });
  } catch (err) {
    console.error('Fetch files error:', err);
    res.status(500).json({ error: 'Failed to fetch files.' });
  }
});

// Timeout for warm upload — if it hangs, we fall back to direct list
const WARM_UPLOAD_TIMEOUT_MS = 12_000;

// POST /patients/:id/warm-and-list — upload tiny temp file, list folder, delete temp (makes list load reliably)
// If warm upload times out, falls back to direct list so we never hang.
router.post('/patients/:id/warm-and-list', async (req: Request, res: Response) => {
  try {
    const token = req.session.accessToken!;
    const folderId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const pageSize = Math.min(Number(req.query.pageSize) || DEFAULT_PAGE_SIZE, 100);

    const listUrl = `/files?q=${encodeURIComponent(
      `'${folderId}' in parents and trashed=false`
    )}&fields=files(id,name,mimeType,webViewLink,createdTime),nextPageToken&pageSize=${pageSize}`;

    let tempFileId: string | null = null;

    // Try warm upload first (can help with Drive API cold start)
    try {
      const warmFileName = `.halo-warm-${Date.now()}.tmp`;
      const warmContentBase64 = Buffer.from(' ', 'utf8').toString('base64');
      const boundary = 'halo_warm_boundary';
      const metadata = { name: warmFileName, parents: [folderId], mimeType: 'text/plain' };
      const multipartBody = Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: base64\r\n\r\n${warmContentBase64}\r\n` +
        `--${boundary}--`
      );

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), WARM_UPLOAD_TIMEOUT_MS);

      const uploadRes = await fetch(`${uploadApi}/files?uploadType=multipart`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body: multipartBody,
      });

      clearTimeout(timeoutId);

      if (uploadRes.ok) {
        const created = (await uploadRes.json()) as { id: string };
        tempFileId = created.id;
      }
    } catch (warmErr) {
      // Warm upload failed or timed out — fall through to direct list (driveRequest has its own timeout)
      console.warn('[warm-and-list] Warm upload skipped:', warmErr instanceof Error ? warmErr.message : warmErr);
    }

    // List files (driveRequest has 25s timeout)
    const data = await driveRequest(token, listUrl);

    // Best-effort delete of temp file if we created one
    if (tempFileId) {
      fetch(`${driveApi}/files/${tempFileId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
    }

    const rawFiles = (data.files || []).filter(
      (f) =>
        (f.name !== SESSIONS_FILE_NAME) &&
        !(f.name.startsWith('.halo-warm-') && f.name.endsWith('.tmp'))
    );
    const files = rawFiles.map((f) => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      url: f.webViewLink ?? '',
      thumbnail: undefined,
      createdTime: f.createdTime?.split('T')[0] ?? '',
    }));

    const nextPage = data.nextPageToken || null;
    const cacheKey = `${folderId}:${pageSize}`;
    filesListCache.set(cacheKey, { files, nextPage, cachedAt: Date.now() });
    if (filesListCache.size > 50) {
      const oldest = [...filesListCache.entries()].sort((a, b) => a[1].cachedAt - b[1].cachedAt)[0];
      if (oldest) filesListCache.delete(oldest[0]);
    }

    res.json({ files, nextPage });
  } catch (err) {
    console.error('[warm-and-list] error:', err);
    res.status(500).json({ error: 'Failed to load files.' });
  }
});

// POST /patients/:id/upload
router.post('/patients/:id/upload', async (req: Request, res: Response) => {
  try {
    const token = req.session.accessToken!;
    const fileName = sanitizeString(req.body.fileName, 255);
    const fileType = sanitizeString(req.body.fileType, 100);
    const fileData = req.body.fileData as string;

    if (!fileName) {
      res.status(400).json({ error: 'File name is required.' });
      return;
    }
    if (!fileType || !ALLOWED_UPLOAD_TYPES.includes(fileType)) {
      res.status(400).json({ error: `File type not allowed. Accepted: ${ALLOWED_UPLOAD_TYPES.join(', ')}` });
      return;
    }
    if (!fileData || typeof fileData !== 'string') {
      res.status(400).json({ error: 'File data is required.' });
      return;
    }

    const estimatedSize = Math.ceil(fileData.length * 3 / 4);
    if (estimatedSize > MAX_FILE_SIZE_BYTES) {
      res.status(400).json({ error: `File too large. Maximum size is ${MAX_FILE_SIZE_MB}MB.` });
      return;
    }

    const metadata = {
      name: fileName,
      parents: [req.params.id],
      mimeType: fileType,
    };

    const boundary = 'halo_upload_boundary';
    const metaPart = JSON.stringify(metadata);

    const multipartBody = Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metaPart}\r\n` +
      `--${boundary}\r\nContent-Type: ${fileType}\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
      `${fileData}\r\n` +
      `--${boundary}--`
    );

    const uploadRes = await fetch(
      `${uploadApi}/files?uploadType=multipart`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body: multipartBody,
      }
    );

    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      console.error('Drive upload failed:', uploadRes.status, errText);
      res.status(500).json({ error: 'Google Drive upload failed.' });
      return;
    }

    const data = (await uploadRes.json()) as { id: string; name: string; mimeType: string; webViewLink?: string };
    const uploadFolderId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    invalidateFilesCacheForFolder(uploadFolderId);
    res.json({
      id: data.id,
      name: data.name,
      mimeType: data.mimeType,
      url: data.webViewLink ?? '',
      createdTime: new Date().toISOString().split('T')[0],
    });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Failed to upload file.' });
  }
});

// PATCH /files/:fileId
router.patch('/files/:fileId', async (req: Request, res: Response) => {
  try {
    const token = req.session.accessToken!;
    const name = sanitizeString(req.body.name, 255);

    if (!name) {
      res.status(400).json({ error: 'File name is required.' });
      return;
    }

    await fetch(`${driveApi}/files/${req.params.fileId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name }),
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Update file error:', err);
    res.status(500).json({ error: 'Failed to update file.' });
  }
});

// DELETE /files/:fileId - Trash a file
router.delete('/files/:fileId', async (req: Request, res: Response) => {
  try {
    const token = req.session.accessToken!;
    await fetch(`${driveApi}/files/${req.params.fileId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ trashed: true }),
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete file error:', err);
    res.status(500).json({ error: 'Failed to delete file.' });
  }
});

// GET /files/:fileId/download - Get download URL
router.get('/files/:fileId/download', async (req: Request, res: Response) => {
  try {
    const token = req.session.accessToken!;
    const data = await driveRequest(
      token,
      `/files/${req.params.fileId}?fields=webContentLink,webViewLink,name,mimeType`
    );

    res.json({
      downloadUrl: (data as Record<string, unknown>).webContentLink || '',
      viewUrl: (data as Record<string, unknown>).webViewLink || '',
      name: data.name ?? '',
      mimeType: data.mimeType ?? '',
    });
  } catch (err) {
    console.error('Download file error:', err);
    res.status(500).json({ error: 'Failed to get download link.' });
  }
});

// GET /files/:fileId/proxy — stream file content for in-app viewer
router.get('/files/:fileId/proxy', async (req: Request, res: Response) => {
  try {
    const token = req.session.accessToken!;
    const fileId = req.params.fileId;

    // Get file metadata first
    const meta = await driveRequest(token, `/files/${fileId}?fields=name,mimeType`);
    const mimeType = meta.mimeType ?? 'application/octet-stream';
    const name = meta.name ?? 'file';

    let contentResponse: globalThis.Response;

    // Google Workspace files need export, not direct download
    if (mimeType === 'application/vnd.google-apps.document') {
      contentResponse = await fetch(
        `${config.driveApi}/files/${fileId}/export?mimeType=application/pdf`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      res.setHeader('Content-Type', 'application/pdf');
    } else if (mimeType === 'application/vnd.google-apps.spreadsheet') {
      contentResponse = await fetch(
        `${config.driveApi}/files/${fileId}/export?mimeType=application/pdf`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      res.setHeader('Content-Type', 'application/pdf');
    } else if (mimeType === 'application/vnd.google-apps.presentation') {
      contentResponse = await fetch(
        `${config.driveApi}/files/${fileId}/export?mimeType=application/pdf`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      res.setHeader('Content-Type', 'application/pdf');
    } else {
      contentResponse = await fetch(
        `${config.driveApi}/files/${fileId}?alt=media`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      res.setHeader('Content-Type', mimeType);
    }

    if (!contentResponse.ok) {
      res.status(contentResponse.status).json({ error: 'Failed to fetch file content.' });
      return;
    }

    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(name)}"`);

    const arrayBuffer = await contentResponse.arrayBuffer();
    res.send(Buffer.from(arrayBuffer));
  } catch (err) {
    console.error('File proxy error:', err);
    res.status(500).json({ error: 'Failed to proxy file.' });
  }
});

// --- SCRIBE SESSIONS PER PATIENT (JSON file in patient folder) ---

// GET /patients/:id/sessions
router.get('/patients/:id/sessions', async (req: Request, res: Response) => {
  try {
    const token = req.session.accessToken!;
    const folderId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const fileId = await findSessionsFile(token, folderId);

    if (!fileId) {
      res.json({ sessions: [] });
      return;
    }

    const dlRes = await fetch(`${driveApi}/files/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!dlRes.ok) {
      console.error('Load sessions error: failed to download sessions file', dlRes.status);
      res.status(500).json({ error: 'Failed to load sessions.' });
      return;
    }

    const raw = (await dlRes.json()) as unknown;
    const sessions = parseSessionsJson(raw);
    res.json({ sessions });
  } catch (err) {
    console.error('Load sessions error:', err);
    res.status(500).json({ error: 'Failed to load sessions.' });
  }
});

// POST /patients/:id/sessions
router.post('/patients/:id/sessions', async (req: Request, res: Response) => {
  try {
    const token = req.session.accessToken!;
    const folderId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const sessionIdRaw = req.body?.sessionId;
    const transcriptRaw = req.body?.transcript;
    const contextRaw = req.body?.context;
    const templatesRaw = req.body?.templates;
    const noteTitlesRaw = req.body?.noteTitles;
    const notesRaw = req.body?.notes;
    const mainComplaintRaw = req.body?.mainComplaint;

    const transcript =
      typeof transcriptRaw === 'string' ? transcriptRaw.trim().slice(0, 20000) : '';
    if (!transcript) {
      res.status(400).json({ error: 'transcript is required.' });
      return;
    }

    const context =
      typeof contextRaw === 'string' ? contextRaw.trim().slice(0, 5000) : undefined;
    const templates = Array.isArray(templatesRaw)
      ? templatesRaw.map((t: unknown) => String(t)).slice(0, 20)
      : undefined;
    const noteTitles = Array.isArray(noteTitlesRaw)
      ? noteTitlesRaw.map((t: unknown) => String(t)).slice(0, 20)
      : undefined;
    const notes = Array.isArray(notesRaw)
      ? notesRaw.slice(0, 20).map((n: unknown) => {
          const o = n && typeof n === 'object' ? (n as Record<string, unknown>) : {};
          return {
            noteId: String(o.noteId ?? ''),
            title: String(o.title ?? ''),
            content: String(o.content ?? '').slice(0, 100000),
            template_id: String(o.template_id ?? ''),
          };
        })
      : undefined;
    const mainComplaint =
      typeof mainComplaintRaw === 'string' ? mainComplaintRaw.trim().slice(0, 200) : undefined;

    const nowIso = new Date().toISOString();
    const providedId =
      typeof sessionIdRaw === 'string' && sessionIdRaw.trim()
        ? sessionIdRaw.trim()
        : undefined;
    const sessionId =
      providedId ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    const newSession: ScribeSession = {
      id: sessionId,
      patientId: folderId,
      createdAt: nowIso,
      transcript,
      context,
      templates,
      noteTitles,
      notes,
      mainComplaint: mainComplaint || undefined,
    };

    const existingFileId = await findSessionsFile(token, folderId);
    let sessions: ScribeSession[] = [];

    if (existingFileId) {
      try {
        const dlRes = await fetch(`${driveApi}/files/${existingFileId}?alt=media`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (dlRes.ok) {
          const raw = (await dlRes.json()) as unknown;
          sessions = parseSessionsJson(raw);
        }
      } catch (err) {
        console.warn('Read existing sessions failed, starting fresh:', err);
      }
    }

    if (providedId) {
      const idx = sessions.findIndex((s) => s.id === providedId);
      if (idx >= 0) {
        sessions[idx] = newSession;
      } else {
        sessions.push(newSession);
      }
    } else {
      sessions.push(newSession);
    }
    if (sessions.length > 30) {
      sessions = sessions.slice(-30);
    }

    const content = JSON.stringify(sessions);

    if (existingFileId) {
      await fetch(`${uploadApi}/files/${existingFileId}?uploadType=media`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: content,
      });
    } else {
      const metadata = {
        name: SESSIONS_FILE_NAME,
        parents: [folderId],
        mimeType: 'application/json',
      };
      const boundary = 'halo_sessions_boundary';
      const body = Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(
          metadata
        )}\r\n` +
          `--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n` +
          `--${boundary}--`
      );
      await fetch(`${uploadApi}/files?uploadType=multipart`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body,
      });
    }

    res.json({ sessions });
  } catch (err) {
    console.error('Save sessions error:', err);
    res.status(500).json({ error: 'Failed to save session.' });
  }
});

// --- USER SETTINGS & SCRIBE SESSIONS (stored as JSON files in Drive) ---

const SETTINGS_FILE_NAME = 'halo_user_settings.json';

async function findSettingsFile(token: string, rootId: string): Promise<string | null> {
  const query = encodeURIComponent(
    `'${rootId}' in parents and name='${SETTINGS_FILE_NAME}' and mimeType='application/json' and trashed=false`
  );
  const data = await driveRequest(token, `/files?q=${query}&fields=files(id)`);
  return data.files && data.files.length > 0 ? data.files[0].id : null;
}

async function findSessionsFile(token: string, patientFolderId: string): Promise<string | null> {
  const query = encodeURIComponent(
    `'${patientFolderId}' in parents and name='${SESSIONS_FILE_NAME}' and mimeType='application/json' and trashed=false`
  );
  const data = await driveRequest(token, `/files?q=${query}&fields=files(id)`);
  return data.files && data.files.length > 0 ? data.files[0].id : null;
}

function parseSessionsJson(raw: unknown): ScribeSession[] {
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[])
    .map((item): ScribeSession | null => {
      const obj = item as Partial<ScribeSession> & { notes?: unknown[] };
      if (!obj || typeof obj !== 'object') return null;
      if (
        typeof obj.id !== 'string' ||
        typeof obj.patientId !== 'string' ||
        typeof obj.createdAt !== 'string' ||
        typeof obj.transcript !== 'string'
      ) {
        return null;
      }
      const notes = Array.isArray(obj.notes)
        ? obj.notes
          .slice(0, 20)
          .map((n: unknown) => {
            const o = n && typeof n === 'object' ? (n as Record<string, unknown>) : {};
            return {
              noteId: String(o.noteId ?? ''),
              title: String(o.title ?? ''),
              content: String(o.content ?? ''),
              template_id: String(o.template_id ?? ''),
            };
          })
        : undefined;
      return {
        id: obj.id,
        patientId: obj.patientId,
        createdAt: obj.createdAt,
        transcript: obj.transcript,
        context: typeof obj.context === 'string' ? obj.context : undefined,
        templates: Array.isArray(obj.templates) ? obj.templates.map(String) : undefined,
        noteTitles: Array.isArray(obj.noteTitles) ? obj.noteTitles.map(String) : undefined,
        notes,
        mainComplaint: typeof obj.mainComplaint === 'string' ? obj.mainComplaint.trim().slice(0, 200) : undefined,
      } as ScribeSession;
    })
    .filter((s): s is ScribeSession => s !== null);
}

// GET /settings
router.get('/settings', async (req: Request, res: Response) => {
  try {
    const token = req.session.accessToken!;
    const rootId = await getHaloRootFolder(token);
    const fileId = await findSettingsFile(token, rootId);

    if (!fileId) {
      res.json({ settings: null });
      return;
    }

    const dlRes = await fetch(`${driveApi}/files/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const settings = await dlRes.json();
    res.json({ settings });
  } catch (err) {
    console.error('Load settings error:', err);
    res.status(500).json({ error: 'Failed to load settings.' });
  }
});

// PUT /settings
router.put('/settings', async (req: Request, res: Response) => {
  try {
    const token = req.session.accessToken!;
    const settings = req.body;

    if (!settings || typeof settings !== 'object') {
      res.status(400).json({ error: 'Settings object is required.' });
      return;
    }

    const rootId = await getHaloRootFolder(token);
    const existingFileId = await findSettingsFile(token, rootId);
    const content = JSON.stringify(settings);

    if (existingFileId) {
      // Update existing file
      await fetch(`${uploadApi}/files/${existingFileId}?uploadType=media`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: content,
      });
    } else {
      // Create new file
      const metadata = {
        name: SETTINGS_FILE_NAME,
        parents: [rootId],
        mimeType: 'application/json',
      };
      const boundary = 'halo_settings_boundary';
      const body = Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n` +
        `--${boundary}--`
      );
      await fetch(`${uploadApi}/files?uploadType=multipart`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body,
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Save settings error:', err);
    res.status(500).json({ error: 'Failed to save settings.' });
  }
});

export default router;
