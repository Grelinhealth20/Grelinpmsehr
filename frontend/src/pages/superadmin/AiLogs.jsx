import { useCallback, useEffect, useRef, useState } from 'react';
import { aiLogsApi, toApiError } from '../../lib/api.js';
import { useToast } from '../../components/Toast.jsx';

/**
 * Super-Admin AI Logs — every AI (custom-template) request with REAL OpenAI token usage, captured in
 * real time from the ai_usage_logs table. Read-only. Auto-refreshes so new requests appear live.
 * Every value is real (actual token counts, latency, status) — nothing synthesized.
 */
const PER_PAGE = 25;
const fmt = (n) => Number(n || 0).toLocaleString();
const when = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? (iso || '—') : d.toLocaleString(); };

export default function AiLogs() {
  const toast = useToast();
  const [logs, setLogs] = useState(null);
  const [totals, setTotals] = useState(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const firstLoad = useRef(true);

  const load = useCallback(async (p, silent = false) => {
    if (!silent) setLoading(true);
    try {
      const { data } = await aiLogsApi.list({ page: p, pageSize: PER_PAGE });
      setLogs(data.logs || []);
      setTotals(data.totals || null);
      setTotal(data.total || 0);
    } catch (e) { if (!silent) toast.error(toApiError(e).message); }
    finally { setLoading(false); firstLoad.current = false; }
  }, [toast]);

  useEffect(() => { load(page); }, [page, load]);
  // Real-time: silently refresh the current page every 12s so new requests appear without a click.
  useEffect(() => {
    const id = setInterval(() => load(page, true), 12000);
    return () => clearInterval(id);
  }, [page, load]);

  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  useEffect(() => { if (page > pages) setPage(pages); }, [pages, page]);

  return (
    <div className="ail">
      <div className="ail-head">
        <div>
          <h2 className="ail-title">AI Template Assistant — Usage</h2>
          <p className="ail-sub">Every request and its real OpenAI token spend, captured live.</p>
        </div>
        <button className="btn ghost sm" onClick={() => load(page)} disabled={loading}>{loading ? <span className="spinner" /> : '↻ Refresh'}</button>
      </div>

      <div className="ail-stats">
        <Stat k="Total tokens" v={fmt(totals?.tokens)} accent />
        <Stat k="Last 30 days" v={fmt(totals?.tokens30d)} />
        <Stat k="Prompt / Completion" v={`${fmt(totals?.promptTokens)} / ${fmt(totals?.completionTokens)}`} />
        <Stat k="Requests" v={fmt(totals?.requests)} />
        <Stat k="Succeeded" v={fmt(totals?.ok)} good />
        <Stat k="Failed" v={fmt(totals?.errors)} bad={!!(totals?.errors)} />
      </div>

      <div className="ail-tablewrap">
        <table className="ail-table">
          <thead>
            <tr>
              <th>Time</th><th>Provider</th><th>Model</th><th>Status</th><th>Description</th>
              <th className="ail-num">Prompt</th><th className="ail-num">Completion</th><th className="ail-num">Total</th>
              <th className="ail-num">Sections</th><th className="ail-num">Latency</th>
            </tr>
          </thead>
          <tbody>
            {firstLoad.current && loading ? (
              <tr><td colSpan={10} className="table-empty"><span className="spinner dark" /> Loading…</td></tr>
            ) : (logs && logs.length === 0) ? (
              <tr><td colSpan={10} className="table-empty">No AI requests yet.</td></tr>
            ) : (logs || []).map((l) => (
              <tr key={l.uuid}>
                <td className="ail-time">{when(l.createdAt)}</td>
                <td>{l.user}</td>
                <td className="mono">{l.model || '—'}</td>
                <td><span className={`ail-badge ${l.status === 'ok' ? 'ok' : 'err'}`}>{l.status === 'ok' ? 'OK' : (l.errorCode || 'Error')}</span></td>
                <td className="ail-desc" title={l.promptPreview}>{l.promptPreview || '—'}</td>
                <td className="ail-num">{fmt(l.promptTokens)}</td>
                <td className="ail-num">{fmt(l.completionTokens)}</td>
                <td className="ail-num ail-total">{fmt(l.totalTokens)}</td>
                <td className="ail-num">{l.sections ?? '—'}</td>
                <td className="ail-num">{l.latencyMs != null ? `${fmt(l.latencyMs)} ms` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div className="pager pager-c">
          <span className="pager-label">Showing {(page - 1) * PER_PAGE + 1}–{Math.min(page * PER_PAGE, total)} of {total}</span>
          <span className="spacer" />
          <button className="pager-btn" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>‹ Prev</button>
          <span className="pager-num is-on">{page} / {pages}</span>
          <button className="pager-btn" disabled={page >= pages || loading} onClick={() => setPage((p) => Math.min(pages, p + 1))}>Next ›</button>
        </div>
      )}
    </div>
  );
}

function Stat({ k, v, accent, good, bad }) {
  return (
    <div className={`ail-stat ${accent ? 'accent' : ''} ${good ? 'good' : ''} ${bad ? 'bad' : ''}`}>
      <span className="ail-stat-k">{k}</span>
      <span className="ail-stat-v">{v ?? '—'}</span>
    </div>
  );
}
