import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import { config } from '../config';
import { getTemplates, generateNote } from '../services/haloApi';
import { getOrCreatePatientNotesFolder, uploadToDrive } from '../services/drive';

const router = Router();
router.use(requireAuth);

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// POST /api/halo/templates
router.post('/templates', async (req: Request, res: Response) => {
  try {
    const userId = (req.body?.user_id as string) || config.haloUserId;
    const templates = await getTemplates(userId);
    res.json(templates);
  } catch (err) {
    console.error('Halo get_templates error:', err);
    const message = err instanceof Error ? err.message : 'Failed to fetch templates.';
    res.status(err instanceof Error && message.includes('502') ? 502 : 400).json({ error: message });
  }
});

// POST /api/halo/generate-note
// Body: { user_id?, template_id, text, return_type: 'note' | 'docx', patientId?, fileName? }
// If return_type === 'docx' and patientId is set, uploads DOCX to patient's Patient Notes folder and returns { success, fileId, name }.
router.post('/generate-note', async (req: Request, res: Response) => {
  try {
    const { user_id, template_id, text, return_type, patientId, fileName } = req.body as {
      user_id?: string;
      template_id: string;
      text: string;
      return_type: 'note' | 'docx';
      patientId?: string;
      fileName?: string;
    };

    if (!template_id || typeof text !== 'string') {
      res.status(400).json({ error: 'template_id and text are required.' });
      return;
    }

    const userId = user_id || config.haloUserId;
    const result = await generateNote({ user_id: userId, template_id, text, return_type });

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

    res.json({ success: true, fileId, name: finalFileName });
  } catch (err) {
    console.error('Halo generate-note error:', err);
    const message = err instanceof Error ? err.message : 'Note generation failed.';
    const status = message.includes('502') ? 502 : message.includes('Invalid') ? 400 : 500;
    res.status(status).json({ error: message });
  }
});

export default router;
