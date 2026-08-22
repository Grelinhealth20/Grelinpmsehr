import { useState } from 'react';
import Modal from './Modal.jsx';

export default function ConfirmDialog({ title, message, confirmLabel = 'Confirm', danger, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={title}
      onClose={onClose}
      width={420}
      footer={
        <>
          <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className={`btn ${danger ? 'danger' : ''}`} onClick={go} disabled={busy}>
            {busy ? <span className="spinner dark" /> : confirmLabel}
          </button>
        </>
      }
    >
      <p className="muted">{message}</p>
    </Modal>
  );
}
