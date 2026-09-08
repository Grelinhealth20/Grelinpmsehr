/**
 * Module-level Access Control enforcement — the Super Admin "Access Control" toggles
 * (users.access_level.permissions). Model agreed with the product:
 *
 *   ROLE provides the baseline; a per-user permission GRANTS a capability to a user whose role does
 *   not already have it. So a provider keeps their clinical workflow by default, and a non-provider
 *   (e.g. a billing user) only reaches the EHR / edits notes when explicitly granted. DELETE is
 *   privileged: it is grant-required for EVERYONE (no role baseline), since notes are normally amended.
 *
 * Reads req.user (role + accessLevel.permissions) set by authenticate. Deny → 403 with a typed code the
 * client surfaces. No fallback: an unknown/half-configured permission object simply means "not granted".
 */
const permsOf = (req) => (req.user && req.user.accessLevel && req.user.accessLevel.permissions) || {};
const roleOf = (req) => req.user && req.user.role;

/** May the user reach the EHR System at all? Providers always; anyone else needs the ehr.access grant. */
export function requireEhrAccess(req, res, next) {
  if (roleOf(req) === 'provider' || permsOf(req).ehr?.access) return next();
  return res.status(403).json({ error: 'You do not have access to the EHR System.', code: 'EHR_ACCESS_DENIED' });
}

/** May the user create / edit / amend clinical notes? Providers baseline (own notes are owner-scoped);
 *  non-providers need the ehr.editNotes grant. */
export function requireEditNotes(req, res, next) {
  if (roleOf(req) === 'provider' || permsOf(req).ehr?.editNotes) return next();
  return res.status(403).json({ error: 'You do not have permission to edit clinical notes.', code: 'EHR_EDIT_NOTES_DENIED' });
}

/** May the user delete a clinical note? Grant-required for everyone (privileged, audited). */
export function requireDeleteNotes(req, res, next) {
  if (permsOf(req).ehr?.deleteNotes) return next();
  return res.status(403).json({ error: 'You do not have permission to delete clinical notes.', code: 'EHR_DELETE_NOTES_DENIED' });
}
