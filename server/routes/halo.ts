import { Router, Request, Response } from 'express';
import nodemailer from 'nodemailer';
import { Document, Packer, Paragraph } from 'docx';
import { requireAuth } from '../middleware/requireAuth';
import { config } from '../config';
import { getTemplates, generateNote } from '../services/haloApi';
import { getOrCreatePatientNotesFolder, uploadToDrive } from '../services/drive';
import { buildLetterheadBody, fetchLetterheadTemplateBuffer, mergeLetterheadDocx } from '../services/letterheadDocx';

const router = Router();
router.use(requireAuth);

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

async function textToBasicDocxBuffer(text: string): Promise<Buffer> {
  const lines = text.split(/\r?\n/);
  const doc = new Document({
    sections: [
      {
        children: lines.length
          ? lines.map((line) => new Paragraph({ text: line }))
          : [new Paragraph({ text: '' })],
      },
    ],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

function isSmtpConfigured(): boolean {
  return Boolean(config.smtpHost && config.smtpUser && config.smtpPass);
}

function isOverrideAccount(req: Request): boolean {
  const email = (req.session as { userEmail?: string }).userEmail?.trim().toLowerCase();
  return Boolean(
    config.haloOverrideEmail &&
    config.haloOverrideUserId &&
    email === config.haloOverrideEmail
  );
}

function filterTemplatesByIds(data: unknown, ids: string[]): unknown {
  if (!data || ids.length === 0) return data;
  const idSet = new Set(ids);
  if (Array.isArray(data)) {
    return data.filter((t: { id?: string; template_id?: string; templateId?: string }) =>
      idSet.has(String(t.id ?? t.template_id ?? t.templateId ?? '').toLowerCase())
    );
  }
  const obj = data as Record<string, unknown>;
  if (obj.templates && Array.isArray(obj.templates)) {
    const arr = (obj.templates as Array<{ id?: string; template_id?: string; templateId?: string }>).filter((t) =>
      idSet.has(String(t.id ?? t.template_id ?? t.templateId ?? '').toLowerCase())
    );
    return { ...obj, templates: arr };
  }
  const out: Record<string, unknown> = {};
  for (const id of ids) {
    const key = Object.keys(obj).find((k) => k.toLowerCase() === id);
    if (key && obj[key] != null) out[key] = obj[key];
  }
  return Object.keys(out).length > 0 ? out : data;
}

// POST /api/halo/templates
router.post('/templates', async (req: Request, res: Response) => {
  try {
    let userId =
      (req.body?.user_id as string) ||
      (config.haloTestUserId && !config.isProduction ? config.haloTestUserId : config.haloUserId);
    if (isOverrideAccount(req) && config.haloOverrideUserId) {
      userId = config.haloOverrideUserId;
    }
    let data: Record<string, unknown> = await getTemplates(userId);
    if (isOverrideAccount(req) && config.haloOverrideTemplateIds.length > 0) {
      data = filterTemplatesByIds(data, config.haloOverrideTemplateIds) as Record<string, unknown>;
    }
    res.json(data);
  } catch (err) {
    console.error('Halo get_templates error:', err);
    const message = err instanceof Error ? err.message : 'Failed to fetch templates.';
    res.status(err instanceof Error && message.includes('502') ? 502 : 400).json({ error: message });
  }
});

// POST /api/halo/generate-note
// Body: { user_id?, template_id?, text, return_type: 'note' | 'docx', patientId?, fileName?, useMobileConfig?, allowFallbackDocx?, useLetterhead?, letterheadPlaceholders? }
// If useLetterhead is true and return_type === 'docx', merges `text` into Drive/local letterhead template (docxtemplater) and uploads; skips Halo API.
// If useMobileConfig is true, use config.haloMobileUserId and config.haloMobileTemplateId (for mobile preview).
// If return_type === 'docx' and patientId is set, uploads DOCX to patient's Patient Notes folder and returns { success, fileId, name }.
router.post('/generate-note', async (req: Request, res: Response) => {
  try {
    const {
      user_id,
      template_id,
      text,
      return_type,
      patientId,
      fileName,
      useMobileConfig,
      allowFallbackDocx,
      useLetterhead,
      letterheadPlaceholders,
      letterheadDriveFileId,
    } = req.body as {
      user_id?: string;
      template_id?: string;
      text: string;
      return_type: 'note' | 'docx';
      patientId?: string;
      fileName?: string;
      useMobileConfig?: boolean;
      allowFallbackDocx?: boolean;
      useLetterhead?: boolean;
      letterheadPlaceholders?: { NAME?: string; DOB?: string; DATE?: string; DOCUMENT_TYPE?: string };
      letterheadDriveFileId?: string;
    };

    if (typeof text !== 'string') {
      res.status(400).json({ error: 'text is required.' });
      return;
    }

    if (return_type === 'docx' && useLetterhead === true) {
      if (!patientId || !req.session.accessToken) {
        res.status(400).json({ error: 'patientId and authentication are required for letterhead DOCX.' });
        return;
      }
      const token = req.session.accessToken;
      const patientNotesFolderId = await getOrCreatePatientNotesFolder(token, patientId);
      const baseName = fileName && fileName.trim() ? fileName.replace(/\.docx$/i, '') : `Clinical_Note_${new Date().toISOString().split('T')[0]}`;
      const finalFileName = baseName.endsWith('.docx') ? baseName : `${baseName}.docx`;
      const composed = buildLetterheadBody(text, letterheadPlaceholders);
      let buffer: Buffer;
      let letterheadWarning: string | undefined;
      try {
        const tmpl = await fetchLetterheadTemplateBuffer(token, { driveFileId: letterheadDriveFileId });
        buffer = mergeLetterheadDocx(tmpl, composed);
      } catch (letterErr) {
        console.error('[Halo] letterhead DOCX failed, using plain DOCX fallback:', letterErr);
        const msg = letterErr instanceof Error ? letterErr.message : 'Letterhead merge failed.';
        buffer = await textToBasicDocxBuffer(composed);
        letterheadWarning = `${msg} Saved without letterhead — use {{body}} in the template, share the Drive file with this account, or set HALO_LETTERHEAD_LOCAL_PATH.`;
      }
      const fileId = await uploadToDrive(token, finalFileName, DOCX_MIME, patientNotesFolderId, buffer);
      res.json({
        success: true,
        fileId,
        name: finalFileName,
        usedLetterhead: !letterheadWarning,
        usedDocxFallback: Boolean(letterheadWarning),
        letterheadWarning,
      });
      return;
    }

    let userId = useMobileConfig
      ? config.haloMobileUserId
      : (user_id || (config.haloTestUserId && !config.isProduction ? config.haloTestUserId : config.haloUserId));
    if (!useMobileConfig && isOverrideAccount(req) && config.haloOverrideUserId) {
      userId = config.haloOverrideUserId;
    }
    const defaultTemplateId =
      !useMobileConfig && isOverrideAccount(req) && config.haloOverrideTemplateIds.length > 0
        ? config.haloOverrideTemplateIds[0]
        : 'clinical_note';
    const templateId = useMobileConfig ? config.haloMobileTemplateId : (template_id || defaultTemplateId);
    console.log('[Halo] generate-note request:', { userId: userId.slice(0, 8) + '…', templateId, return_type, textLength: text.length });
    let result: Awaited<ReturnType<typeof generateNote>> | null = null;
    let usedDocxFallback = false;
    try {
      result = await generateNote({ user_id: userId, template_id: templateId, text, return_type });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const canFallback =
        return_type === 'docx' &&
        allowFallbackDocx === true &&
        (message.includes('service unavailable') || message.includes('502'));
      if (!canFallback) throw err;
      console.warn('[Halo] generate-note docx fallback activated:', message);
      result = await textToBasicDocxBuffer(text);
      usedDocxFallback = true;
    }

    if (return_type === 'note') {
      res.json({ notes: result });
      return;
    }

    // return_type === 'docx': result is Buffer
    const buffer = result as Buffer;
    if (!patientId || !req.session.accessToken) {
      res.status(400).json({ error: 'patientId is required to save DOCX to Drive.' });
      return;
    }

    const token = req.session.accessToken;
    const patientNotesFolderId = await getOrCreatePatientNotesFolder(token, patientId);
    const baseName = fileName && fileName.trim() ? fileName.replace(/\.docx$/i, '') : `Clinical_Note_${new Date().toISOString().split('T')[0]}`;
    const finalFileName = baseName.endsWith('.docx') ? baseName : `${baseName}.docx`;

    const fileId = await uploadToDrive(
      token,
      finalFileName,
      DOCX_MIME,
      patientNotesFolderId,
      buffer
    );

    res.json({ success: true, fileId, name: finalFileName, usedDocxFallback });
  } catch (err) {
    console.error('[Halo] generate-note error:', err);
    const message = err instanceof Error ? err.message : 'Note generation failed.';
    const status = message.includes('502') ? 502 : message.includes('404') ? 404 : message.includes('Invalid') ? 400 : message.includes('too long') ? 504 : 500;
    res.status(status).json({ error: message });
  }
});

// POST /api/halo/confirm-and-send (mobile)
// Body: { patientId, text, fileName?, patientName? }
// Generates DOCX with mobile Halo config, saves to patient Patient Notes folder, emails DOCX to signed-in user from admin@halo.africa.
router.post('/confirm-and-send', async (req: Request, res: Response) => {
  try {
    const { patientId, text, fileName, patientName } = req.body as {
      patientId?: string;
      text?: string;
      fileName?: string;
      patientName?: string;
    };

    if (!patientId || typeof text !== 'string') {
      res.status(400).json({ error: 'patientId and text are required.' });
      return;
    }

    if (!req.session.accessToken) {
      res.status(401).json({ error: 'Not authenticated.' });
      return;
    }

    const userId = config.haloMobileUserId;
    const templateId = config.haloMobileTemplateId;
    const result = await generateNote({
      user_id: userId,
      template_id: templateId,
      text,
      return_type: 'docx',
    });

    const buffer = result as Buffer;
    const token = req.session.accessToken;
    const patientNotesFolderId = await getOrCreatePatientNotesFolder(token, patientId);
    const baseName =
      fileName && fileName.trim()
        ? fileName.replace(/\.docx$/i, '')
        : `Report_${new Date().toISOString().split('T')[0]}`;
    const finalFileName = baseName.endsWith('.docx') ? baseName : `${baseName}.docx`;

    const fileId = await uploadToDrive(
      token,
      finalFileName,
      DOCX_MIME,
      patientNotesFolderId,
      buffer
    );

    let emailSent = false;
    const toEmail = req.session.userEmail;
    if (toEmail && isSmtpConfigured()) {
      try {
        const transporter = nodemailer.createTransport({
          host: config.smtpHost,
          port: config.smtpPort,
          secure: config.smtpSecure,
          auth: { user: config.smtpUser, pass: config.smtpPass },
        });
        const subjectPatient = (patientName && patientName.trim()) || 'Patient';
        await transporter.sendMail({
          from: config.adminEmail,
          to: toEmail,
          subject: `Your report: ${subjectPatient}`,
          text: `Please find the attached report for ${subjectPatient}.`,
          attachments: [{ filename: finalFileName, content: buffer }],
        });
        emailSent = true;
      } catch (emailErr) {
        console.error('Halo confirm-and-send email error:', emailErr);
        // Drive save already succeeded; respond with success and emailSent: false
      }
    }

    res.json({ success: true, fileId, name: finalFileName, emailSent });
  } catch (err) {
    console.error('Halo confirm-and-send error:', err);
    const message = err instanceof Error ? err.message : 'Confirm and send failed.';
    const status = message.includes('502') ? 502 : message.includes('Invalid') ? 400 : 500;
    res.status(status).json({ error: message });
  }
});

export default router;
