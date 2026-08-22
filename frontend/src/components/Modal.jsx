import { useEffect } from 'react';

export default function Modal({ title, onClose, children, footer, width = 460 }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" style={{ maxWidth: width }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="row" style={{ padding: '18px 22px', borderBottom: '1px solid var(--c-line)' }}>
          <h3 style={{ fontSize: 17 }}>{title}</h3>
          <span className="spacer" />
          <button className="btn ghost sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && (
          <div
            className="row"
            style={{ gap: 10, padding: '16px 22px', borderTop: '1px solid var(--c-line)', justifyContent: 'flex-end' }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
