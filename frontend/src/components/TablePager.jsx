/**
 * Reusable table pager — "Showing X–Y of N" + First/Prev/sliding-window/Next/Last.
 * Works for both server-side pagination (parent refetches on onGo) and client-side (parent slices).
 */
export default function TablePager({ page, total, pageSize, onGo }) {
  if (!total) return null;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  let lo = Math.max(1, page - 2);
  let hi = Math.min(totalPages, page + 2);
  if (page <= 3) hi = Math.min(totalPages, 5);
  if (page >= totalPages - 2) lo = Math.max(1, totalPages - 4);
  const win = [];
  for (let i = lo; i <= hi; i += 1) win.push(i);
  const go = (n) => { const t = Math.min(totalPages, Math.max(1, n)); if (t !== page) onGo(t); };

  return (
    <div className="tbl-pager">
      <span className="tbl-pager-range">Showing <b>{from.toLocaleString()}–{to.toLocaleString()}</b> of <b>{total.toLocaleString()}</b></span>
      <span className="spacer" />
      {totalPages > 1 && (
        <div className="tbl-pager-nav">
          <button type="button" className="pgb" disabled={page <= 1} onClick={() => go(1)} title="First page" aria-label="First page">«</button>
          <button type="button" className="pgb" disabled={page <= 1} onClick={() => go(page - 1)} title="Previous page" aria-label="Previous page">‹</button>
          {lo > 1 && <span className="pg-ell">…</span>}
          {win.map((n) => (
            <button type="button" key={n} className={`pgb ${n === page ? 'is-on' : ''}`} onClick={() => go(n)} aria-current={n === page ? 'page' : undefined}>{n}</button>
          ))}
          {hi < totalPages && <span className="pg-ell">…</span>}
          <button type="button" className="pgb" disabled={page >= totalPages} onClick={() => go(page + 1)} title="Next page" aria-label="Next page">›</button>
          <button type="button" className="pgb" disabled={page >= totalPages} onClick={() => go(totalPages)} title="Last page" aria-label="Last page">»</button>
        </div>
      )}
    </div>
  );
}
