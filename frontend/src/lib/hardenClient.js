/**
 * Client-side inspection deterrents (production only).
 *
 * IMPORTANT — this is a DETERRENT, not a security control. Browser DevTools cannot be
 * truly blocked from a web page (the browser gives that capability to the user, and any
 * trap can be bypassed by disabling JS, using the menu, or remote debugging). Real
 * protection is enforced server-side: authentication, RBAC, AES-256-GCM PHI encryption,
 * CSRF, and the append-only audit trail. This just discourages casual right-click /
 * F12 inspection during normal use.
 *
 * Disabled in development so the team keeps full DevTools access.
 */
export function hardenClient() {
  if (!import.meta.env.PROD) return; // dev keeps DevTools

  // 1) Suppress the right-click context menu (Inspect Element entry point).
  window.addEventListener('contextmenu', (e) => e.preventDefault(), { capture: true });

  // 2) Swallow the common DevTools / view-source keyboard shortcuts.
  window.addEventListener(
    'keydown',
    (e) => {
      const k = (e.key || '').toLowerCase();
      const blocked =
        e.key === 'F12' || // DevTools
        (e.ctrlKey && e.shiftKey && (k === 'i' || k === 'j' || k === 'c')) || // Inspect / Console / Picker
        (e.metaKey && e.altKey && (k === 'i' || k === 'j' || k === 'c')) || // macOS equivalents
        (e.ctrlKey && k === 'u'); // View Source
      if (blocked) { e.preventDefault(); e.stopPropagation(); }
    },
    { capture: true },
  );
}
