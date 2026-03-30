/**
 * Centralized AI prompt templates for all Gemini interactions.
 */

export const MAX_CONTENT_LENGTH = 5000;
export const MAX_ASSISTANT_CONTEXT_LENGTH = 24000;

export function summaryPrompt(patientName: string, fileContext: string): string {
  return `
    Patient: ${patientName}
    Patient Records:
    ${fileContext}

    Based on ALL the patient data above (including any file contents provided), generate a concise, clinical 3-bullet point medical summary covering the most important clinical findings, diagnoses, and current status.
    If file contents are provided, use the actual clinical data — not just file names.
    Return ONLY a raw JSON array of strings.
  `;
}

export function labAlertsPrompt(content: string): string {
  const truncated = content.substring(0, MAX_CONTENT_LENGTH);
  return `Analyze this text. Identify "Abnormal" values. Return JSON array of objects with: parameter, value, severity, context. Content: ${truncated}`;
}

export function imageAnalysisPrompt(): string {
  return `Analyze this medical image. Generate a filename (snake_case) ending in .jpg. Return ONLY the filename.`;
}

export function searchPrompt(query: string, context: string): string {
  return `
    You are a medical assistant search engine. Search by patient name, date of birth, file names, AND file contents.
    Match patients whose data relates to the query conceptually (e.g. "mobility" matches patients with notes about mobility, fractures, physiotherapy, walking difficulty, etc.).
    User Query: "${query}"
    Patient Database (includes file names and content snippets):
    ${context}
    Return ONLY a raw JSON array of matching Patient IDs. If no match, return [].
  `;
}

export function chatSystemPrompt(fullContext: string, conversationHistory: string, question: string): string {
  return `You are HALO, an experienced medical assistant integrated into a patient management system. Answer questions using ONLY the patient data provided below. Be concise, clinical, and professional. If the data doesn't contain the answer, say so honestly. Never make up medical information.

Patient Data Context:
${fullContext}

${conversationHistory ? `Previous conversation:\n${conversationHistory}\n` : ''}
User question: ${question}`;
}

export function soapNotePrompt(transcript: string, customTemplate?: string): string {
  if (customTemplate) {
    return `
    You are a medical scribe. Convert this clinical dictation into a clinical note using the EXACT template/format provided below.
    Follow the template's structure, headings, and sections precisely. Use Markdown formatting (## for headings, **bold** for labels).
    Fill in each section of the template with the relevant information from the dictation. If a section has no relevant data, write "N/A" or "Not discussed".

    TEMPLATE TO FOLLOW:
    ${customTemplate}

    Dictation transcript:
    "${transcript}"
    `;
  }
  return `
    You are a medical scribe. Convert this clinical dictation into a properly formatted SOAP note using Markdown.
    
    Dictation transcript:
    "${transcript}"
    
    Format with ## headers for Subjective, Objective, Assessment, Plan.
  `;
}

export function geminiTranscriptionPrompt(customTemplate?: string): string {
  if (customTemplate) {
    return `You are a medical scribe. Transcribe this audio into a clinical note using the EXACT template/format below. Follow the template's structure, headings, and sections precisely. Use Markdown formatting (## for headings, **bold** for labels). Fill in each section with the relevant information. If a section has no data, write "N/A".

TEMPLATE TO FOLLOW:
${customTemplate}`;
  }
  return 'You are a medical scribe. Transcribe this audio into a SOAP note with ## headers for Subjective, Objective, Assessment, Plan.';
}

export function fileDescriptionPrompt(fileName: string, extractedText: string): string {
  const truncated = extractedText.substring(0, MAX_CONTENT_LENGTH);
  return `
You are HALO, a clinical assistant helping a doctor understand a newly uploaded document.

File name: ${fileName}

Extracted text (may be partial):
${truncated}

In 2–4 short bullet points, describe clearly what this file contains and why it might be clinically relevant (history, investigations, imaging, lab results, correspondence, etc.).
Avoid speculation and do not invent diagnoses that are not supported by the text.
Return ONLY a raw Markdown string (no JSON).
`;
}

export function assistantOrchestrationPrompt(params: {
  transcription: string;
  patientContext: string;
  conversationHistory?: string;
}): string {
  const context = (params.patientContext || '').slice(0, MAX_ASSISTANT_CONTEXT_LENGTH);
  const history = params.conversationHistory?.trim()
    ? `Previous assistant turns:\n${params.conversationHistory}\n\n`
    : '';

  return `
You are HALO Clinical Assistant for a doctor.
Use ONLY the provided patient context and dictation/task request.
Never invent patient facts. If uncertain or missing, write "Not provided".

${history}Doctor dictation / request:
${params.transcription}

Patient context:
${context}

Return STRICT raw JSON only (no markdown, no code fences):
{
  "placeholders": {
    "NAME": "string",
    "DOB": "string",
    "DATE": "YYYY-MM-DD",
    "DOCUMENT_TYPE": "Operative Note | Discharge Summary | Task List | Clinical Note | Other"
  },
  "documentBody": "string",
  "tasks": ["string"],
  "warnings": ["string"]
}

Rules:
- Infer requested document/task from the dictation.
- Prefer NAME and DOB from patient context, not assumptions.
- DATE should be today's date if not explicitly provided.
- "documentBody" must be suitable to paste into a Word/Google Doc template.
- Keep tone clinical, concise, and professional.
`;
}
