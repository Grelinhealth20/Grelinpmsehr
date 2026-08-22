import { createContext, useContext, useState, useCallback } from 'react';

const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const push = useCallback((message, type = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, message, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  const toast = {
    success: (m) => push(m, 'success'),
    error: (m) => push(m, 'error'),
    info: (m) => push(m, 'info'),
  };

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div style={{ position: 'fixed', top: 18, right: 18, display: 'flex', flexDirection: 'column', gap: 10, zIndex: 80 }}>
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`alert ${t.type === 'error' ? 'error' : t.type === 'success' ? 'success' : 'info'}`}
            style={{ minWidth: 260, maxWidth: 360, boxShadow: 'var(--shadow-md)' }}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
