import { useEffect } from 'react';
import { createPortal } from 'react-dom';

export default function Modal({ title, onClose, children, footer, width = 460, size }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onKey);
    // Lock background scroll while a modal is open (prevents header/content bleed).
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const isFull = size === 'full';
  // Render into <body> so the fixed overlay escapes any ancestor stacking/overflow
  // context (e.g. the sticky app header) and always covers the whole viewport.
  return createPortal(
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className={`modal ${isFull ? 'modal--full' : ''}`}
        style={isFull ? undefined : { maxWidth: width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="row modal-head">
          <h3>{title}</h3>
          <span className="spacer" />
          <button className="btn ghost sm modal-x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="row modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
