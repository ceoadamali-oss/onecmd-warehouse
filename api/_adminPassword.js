/** Shared Super Admin password - ADMIN_PASSWORD takes precedence over SUPER_ADMIN_PASSWORD. */
export function getAdminPassword() {
  return process.env.ADMIN_PASSWORD || process.env.SUPER_ADMIN_PASSWORD || '';
}

export function verifyAdminPassword(candidate) {
  const expected = getAdminPassword();
  if (!expected) return { ok: false, configured: false };
  if (!candidate || String(candidate).trim() !== String(expected)) {
    return { ok: false, configured: true };
  }
  return { ok: true, configured: true };
}