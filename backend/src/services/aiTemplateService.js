import { config } from '../config/env.js';
import { logger } from '../config/logger.js';
import { SECTION_LABELS } from './noteDocumentService.js';

/**
 * AI-assisted CUSTOM-TEMPLATE drafting. A provider describes the note they want; OpenAI returns a
 * structured, provider-focused SNF template (headings + optional guidance + optional checkboxes). The
 * result is a DRAFT only — it is validated server-side and handed to the builder for the provider to
 * review, edit, and save through the normal (owner-scoped, validated) create path. Nothing is auto-saved.
 *
 * Anti-hallucination design: the model is constrained to STRICT JSON, grounded in the system's real
 * clinical-heading vocabulary, told never to invent patient data / codes / facts, kept at low
 * temperature, and every field is re-validated here. If the key is absent or the API/JSON is bad, we
 * raise a clear error — there is NO mock or fabricated fallback output.
 */

// Grounding list kept TIGHT to the SNF Part B headings actually relevant to these visits — this both
// focuses the model and keeps the prompt token cost low (no pain / TCM / procedure / behavioral labels).
const SNF_PARTB_KEYS = ['chiefComplaint', 'codeStatus', 'hpi', 'interval', 'hospitalCourse', 'allergies',
  'medications', 'medChanges', 'pmh', 'psh', 'socialHistory', 'familyHistory', 'ros', 'vitals', 'exam',
  'functionalStatus', 'results', 'carePlanReview', 'assessment', 'plan', 'mdm', 'orders', 'disposition',
  'prescriptionOrders', 'labOrders', 'imagingOrders', 'followUp', 'participants', 'goals', 'decisionsMade',
  'symptomAssessment', 'careCoordination', 'telehealthEligibility', 'consent', 'changeDescription',
  'prevention', 'dischargeDiagnoses', 'dischargeMeds', 'pendingFollowUp', 'homeServices',
  'dischargeInstructions', 'timeSpent', 'attestation', 'wound', 'treatment'];
const CANONICAL_LABELS = [...new Set(SNF_PARTB_KEYS.map((k) => SECTION_LABELS[k]).filter(Boolean))];
// Reverse map (label → canonical key) so an AI heading that matches a known label stays wired to the
// system's coding/document labels. Free headings pass through as plain labels (slugged on save).
const LABEL_TO_KEY = (() => {
  const m = new Map();
  for (const [k, label] of Object.entries(SECTION_LABELS)) { const lk = String(label).trim().toLowerCase(); if (!m.has(lk)) m.set(lk, k); }
  return m;
})();

const SYSTEM_PROMPT = `You design NOTE TEMPLATES for a Skilled Nursing Facility (SNF) EHR. These are Medicare PART B physician/NPP evaluation-and-management (E/M) visit notes (POS 31/32) — NOT Part A / SNF-PPS / PDPM / MDS documentation. Do not add MDS items, PDPM/RUG scoring, or Part A content.

Turn the provider's request into a clean, provider-focused, CMS-compliant SNF Part B NOTE TEMPLATE — an ordered list of section HEADINGS, each optionally with one line of guidance and a short list of checkbox options.

Return ONLY a JSON object of this exact shape (no markdown, no commentary):
{"name": string, "sections": [{"label": string, "prompt": string (optional), "checks": string[] (optional)}]}

Rules:
- Keep it SIMPLE and provider-friendly: 5 to 14 headings, most important first.
- Prefer these canonical headings when they fit (use the exact wording): ${CANONICAL_LABELS.join('; ')}.
- Add "checks" (3-10 DISCRETE, comma-free options) only where a checklist genuinely helps (e.g. Code Status, Allergies, Review of Systems, Physical Examination, Disposition, Medications, Function & Cognition). Otherwise omit "checks".
- "prompt" is one short line of guidance; omit it when the heading is self-explanatory.
- ALWAYS make the LAST section "Attestation & Signature" (Part B E/M attestation; level by MDM or total time).
- Do NOT invent patient data, names, ICD/CPT codes, drug names, dosages, regulations, or clinical facts. Produce STRUCTURE only. No prose outside the JSON.
- If the request is unclear, produce a sensible general SNF Part B visit template for the note type implied.`;

/** Call OpenAI once and return the parsed assistant JSON string. Never mock — throws on any failure. */
async function callOpenAI(userPrompt) {
  const { apiKey, model, baseUrl, timeoutMs } = config.openai;
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 1100, // enough for ~14 sections + checkboxes; caps cost per call
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Build a SNF note template for: ${userPrompt}` },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    logger.warn({ status: res.status, body: body.slice(0, 300) }, 'OpenAI template generation failed');
    const err = new Error(res.status === 401 ? 'OpenAI rejected the API key. Check OPENAI_API_KEY in the server .env.'
      : res.status === 429 ? 'OpenAI is rate-limited or over quota right now — please try again shortly.'
        : `OpenAI request failed (HTTP ${res.status}).`);
    err.status = 502; err.code = 'AI_UPSTREAM';
    throw err;
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) { const e = new Error('OpenAI returned an empty response.'); e.status = 502; e.code = 'AI_EMPTY'; throw e; }
  const u = data?.usage || {};
  return { content, usage: { prompt: Number(u.prompt_tokens) || 0, completion: Number(u.completion_tokens) || 0, total: Number(u.total_tokens) || 0 }, model };
}

/** Validate + normalize the model's JSON into a builder-ready draft. Rejects anything malformed. */
function normalizeDraft(jsonText, fallbackName) {
  let parsed;
  try { parsed = JSON.parse(jsonText); } catch { const e = new Error('The AI response was not valid JSON.'); e.status = 502; e.code = 'AI_BADJSON'; throw e; }
  const rawSecs = Array.isArray(parsed?.sections) ? parsed.sections : [];
  const seen = new Set();
  const sections = [];
  for (const s of rawSecs) {
    const label = String(s?.label || '').trim().slice(0, 80);
    if (!label) continue;
    const lk = label.toLowerCase();
    if (seen.has(lk)) continue;
    seen.add(lk);
    const key = LABEL_TO_KEY.get(lk) || undefined; // wire to a canonical key when the label matches
    const checksArr = Array.isArray(s?.checks)
      ? [...new Set(s.checks.map((c) => String(c || '').replace(/,/g, ' ').trim()).filter(Boolean))].slice(0, 12)
      : [];
    sections.push({
      ...(key ? { key } : {}),
      label,
      ...(s?.prompt && typeof s.prompt === 'string' ? { prompt: s.prompt.trim().slice(0, 400) } : {}),
      ...(checksArr.length ? { checks: checksArr } : {}),
    });
    if (sections.length >= 40) break;
  }
  if (!sections.length) { const e = new Error('The AI did not return any usable headings — try rephrasing your request.'); e.status = 422; e.code = 'AI_NO_SECTIONS'; throw e; }
  const name = String(parsed?.name || fallbackName || 'AI Template').trim().slice(0, 120) || 'AI Template';
  return { name, sections };
}

/**
 * Generate a custom-template DRAFT from a natural-language description.
 * @returns {Promise<{name:string, sections:Array}>}
 */
export async function generateTemplateDraft(promptText) {
  if (!config.openai.enabled) {
    const e = new Error('AI template generation is not configured. Add OPENAI_API_KEY to the server .env to enable it.');
    e.status = 503; e.code = 'AI_DISABLED';
    throw e;
  }
  const clean = String(promptText || '').trim().slice(0, 1000);
  if (clean.length < 3) { const e = new Error('Describe the template you want (a sentence or two).'); e.status = 400; e.code = 'AI_PROMPT_SHORT'; throw e; }
  const { content, usage, model } = await callOpenAI(clean);
  const draft = normalizeDraft(content, clean.slice(0, 60));
  return { ...draft, usage, model }; // usage/model surfaced so the caller can log real token spend
}

export function aiEnabled() { return !!config.openai.enabled; }
