import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { authApi, setCsrfToken, toApiError } from '../lib/api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [mustReset, setMustReset] = useState(false);
  const [loading, setLoading] = useState(true);

  // Restore an existing session on load (cookies are httpOnly; ask the server).
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        // Refresh first to mint a fresh CSRF token bound to this session.
        const r = await authApi.refresh();
        if (r.data?.csrfToken) setCsrfToken(r.data.csrfToken);
        const { data } = await authApi.me();
        if (!active) return;
        setUser(data.user);
        setMustReset(!!data.mustResetPassword);
      } catch {
        if (active) setUser(null);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const login = useCallback(async (email, password) => {
    const { data } = await authApi.login(email, password);
    setCsrfToken(data.csrfToken);
    setUser(data.user);
    setMustReset(!!data.mustResetPassword);
    return data;
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      /* ignore */
    }
    setCsrfToken(null);
    setUser(null);
    setMustReset(false);
  }, []);

  const completePasswordReset = useCallback(async () => {
    // After a password change the server revokes sessions; force a clean login.
    setCsrfToken(null);
    setUser(null);
    setMustReset(false);
  }, []);

  const value = { user, mustReset, loading, login, logout, completePasswordReset, toApiError };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
