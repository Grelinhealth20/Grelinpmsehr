import { ROLES } from '../config/env.js';

/**
 * Role-based access control. Pass the roles allowed to reach the route.
 * master_admin implicitly satisfies any super_admin-gated route.
 */
export function authorize(...allowedRoles) {
  const allowed = new Set(allowedRoles);
  return (req, res, next) => {
    const role = req.user?.role;
    if (!role) return res.status(401).json({ error: 'Authentication required.' });
    if (role === ROLES.MASTER_ADMIN) return next(); // top of the hierarchy
    if (allowed.has(role)) return next();
    return res.status(403).json({ error: 'You do not have permission to perform this action.', code: 'FORBIDDEN' });
  };
}

/** Convenience: administrative surface (master + super admin). */
export const requireAdmin = authorize(ROLES.SUPER_ADMIN);
