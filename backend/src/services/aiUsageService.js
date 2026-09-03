import { v4 as uuidv4 } from 'uuid';
import { execute } from '../db/pool.js';
import { decrypt } from '../utils/crypto.js';

/**
 * AI usage log — every AI (custom-template) request is recorded in real time for Super-Admin oversight:
 * who called, model, real OpenAI token usage, status/error, latency, and a short (non-PHI) prompt preview.
 * The prompt preview is a provider-typed template DESCRIPTION (e.g. "weekly wound rounds"), never patient
 * data. Logging is best-effort: a logging failure must never break the provider's request.
 */
export async function logAiUsage({ userId, action = 'template.generate', model = null, status, errorCode = null,
  usage = {}, sections = null, latencyMs = null, promptPreview = '' } = {}) {
  try {
    await execute(
      `INSERT INTO ai_usage_logs (uuid, user_id, action, model, status, error_code, prompt_tokens,
         completion_tokens, total_tokens, sections, latency_ms, prompt_preview)
       VALUES (:uuid, :uid, :action, :model, :status, :err, :pt, :ct, :tt, :sec, :lat, :prev)`,
      {
        uuid: uuidv4(), uid: userId || null, action, model: model || null, status,
        err: errorCode || null,
        pt: Number(usage.prompt) || 0, ct: Number(usage.completion) || 0, tt: Number(usage.total) || 0,
        sec: sections == null ? null : Number(sections), lat: latencyMs == null ? null : Number(latencyMs),
        prev: String(promptPreview || '').slice(0, 200) || null,
      },
    );
  } catch { /* logging is best-effort — never break the request */ }
}

const decName = (buf) => { try { return buf ? decrypt(buf) : null; } catch { return null; } };

/** Paginated AI usage logs (newest first) for the Super-Admin panel, plus aggregate token totals. */
export async function listAiUsage({ page = 1, pageSize = 25 } = {}) {
  const lim = Math.max(1, Math.min(100, Math.floor(Number(pageSize)) || 25));
  const off = Math.max(0, (Math.max(1, Math.floor(Number(page)) || 1) - 1) * lim);
  const [[rows], [cnt], [tot]] = await Promise.all([
    execute(
      `SELECT l.uuid, l.action, l.model, l.status, l.error_code, l.prompt_tokens, l.completion_tokens,
          l.total_tokens, l.sections, l.latency_ms, l.prompt_preview,
          DATE_FORMAT(l.created_at, '%Y-%m-%dT%H:%i:%sZ') AS created_at,
          u.email_enc AS user_email_enc, u.full_name_enc
        FROM ai_usage_logs l
        LEFT JOIN users u ON u.id = l.user_id
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT ${lim} OFFSET ${off}`,
    ),
    execute('SELECT COUNT(*) AS total FROM ai_usage_logs'),
    execute(`SELECT
        COALESCE(SUM(total_tokens),0) AS tokens_total,
        COALESCE(SUM(prompt_tokens),0) AS tokens_prompt,
        COALESCE(SUM(completion_tokens),0) AS tokens_completion,
        SUM(status='ok') AS ok_count, SUM(status='error') AS error_count,
        COALESCE(SUM(CASE WHEN created_at >= (NOW() - INTERVAL 30 DAY) THEN total_tokens ELSE 0 END),0) AS tokens_30d
      FROM ai_usage_logs`),
  ]);
  const t = tot[0] || {};
  return {
    logs: rows.map((r) => ({
      uuid: r.uuid, action: r.action, model: r.model, status: r.status, errorCode: r.error_code,
      promptTokens: Number(r.prompt_tokens), completionTokens: Number(r.completion_tokens), totalTokens: Number(r.total_tokens),
      sections: r.sections == null ? null : Number(r.sections), latencyMs: r.latency_ms == null ? null : Number(r.latency_ms),
      promptPreview: r.prompt_preview || '', createdAt: r.created_at,
      user: decName(r.full_name_enc) || decName(r.user_email_enc) || 'Unknown',
    })),
    total: Number(cnt[0].total),
    page: Number(page), pageSize: lim,
    totals: {
      tokens: Number(t.tokens_total), promptTokens: Number(t.tokens_prompt), completionTokens: Number(t.tokens_completion),
      tokens30d: Number(t.tokens_30d), requests: Number(cnt[0].total), ok: Number(t.ok_count || 0), errors: Number(t.error_count || 0),
    },
  };
}
