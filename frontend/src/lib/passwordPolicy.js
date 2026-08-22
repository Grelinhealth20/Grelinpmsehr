/**
 * Client-side password policy — mirrors the server's authoritative rules so the
 * user gets instant feedback. The server ALWAYS re-validates (never trust the
 * client), but this reduces failed round-trips and guides toward strong secrets.
 */
export const MIN_LENGTH = 12;

export function evaluatePassword(pw = '') {
  const checks = [
    { id: 'len', label: `At least ${MIN_LENGTH} characters`, ok: pw.length >= MIN_LENGTH },
    { id: 'lower', label: 'A lowercase letter', ok: /[a-z]/.test(pw) },
    { id: 'upper', label: 'An uppercase letter', ok: /[A-Z]/.test(pw) },
    { id: 'digit', label: 'A number', ok: /[0-9]/.test(pw) },
    { id: 'special', label: 'A special character', ok: /[^A-Za-z0-9]/.test(pw) },
    { id: 'nospace', label: 'No spaces', ok: pw.length > 0 && !/\s/.test(pw) },
  ];
  const passed = checks.filter((c) => c.ok).length;
  const valid = checks.every((c) => c.ok);
  const score = Math.min(100, Math.round((passed / checks.length) * 100));
  let strength = 'Weak';
  if (score >= 100) strength = 'Strong';
  else if (score >= 66) strength = 'Fair';
  return { checks, valid, score, strength };
}
