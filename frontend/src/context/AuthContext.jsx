import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { authApi, settingsApi, setCsrfToken, toApiError } from '../lib/api.js';

const AuthContext = createContext(null);

const DEFAULT_SETTINGS = { eligibilityEnabled: true };

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [mustReset, setMustReset] = useState(false);
  const [mfaStage, setMfaStage] = useState('ok'); // 'ok' | 'setup' (scan QR) | 'pending' (enter code)
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);

  // Load system feature flags (eligibility on/off, …). Never blocks the app —
  // defaults keep everything enabled if the fetch fails.
  const refreshSettings = useCallback(async () => {
    try {
      const { data } = await settingsApi.get();
      setSettings({ ...DEFAULT_SETTINGS, ...(data.settings || {}) });
      return data.settings;
    } catch { return null; }
  }, []);

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
        setMfaStage(mfaStageFromMe(data.mfa));
        refreshSettings();
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
    setMfaStage(data.mfaStage || 'ok');
    refreshSettings();
    return data;
  }, [refreshSettings]);

  // Called by the MFA enroll/verify screens on success — a fresh full session was issued.
  const completeMfa = useCallback((csrfToken) => {
    if (csrfToken) setCsrfToken(csrfToken);
    setMfaStage('ok');
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
    setMfaStage('ok');
  }, []);

  const value = {
    user, mustReset, mfaStage, loading, login, logout, completePasswordReset, completeMfa, toApiError,
    settings, eligibilityEnabled: settings.eligibilityEnabled !== false, refreshSettings, setSettings,
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// Derive the MFA stage from the /me `mfa` object.
function mfaStageFromMe(mfa) {
  if (!mfa || !mfa.enabled) return 'ok';
  if (!mfa.enrolled) return 'setup';
  return mfa.satisfied ? 'ok' : 'pending';
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
