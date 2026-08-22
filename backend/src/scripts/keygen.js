import crypto from 'node:crypto';

/**
 * Generate the secrets required by .env. Run: `npm run keygen`
 * Copy the printed values into your .env (do NOT commit them).
 */
const key = () => crypto.randomBytes(32).toString('base64');
const secret = () => crypto.randomBytes(48).toString('base64url');

console.log('# --- Paste into backend/.env ---');
console.log(`PHI_ENC_KEY=${key()}`);
console.log(`BLIND_INDEX_KEY=${key()}`);
console.log(`JWT_ACCESS_SECRET=${secret()}`);
console.log(`JWT_REFRESH_SECRET=${secret()}`);
