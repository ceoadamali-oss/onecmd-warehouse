const PIN_MAX_FAILURES = 5;
const PIN_LOCKOUT_MS = 15 * 60 * 1000;
const pinFailureBuckets = new Map();

export function getClientIp(req) {
  const forwarded = req.headers?.['x-forwarded-for'];
  return (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim() || 'unknown';
}

/** Returns false and sends 429 when the IP is locked out from PIN attempts. */
export function checkPinLockout(req, res) {
  const ip = getClientIp(req);
  const bucket = pinFailureBuckets.get(ip);
  const now = Date.now();

  if (!bucket || now > bucket.resetAt) {
    return true;
  }

  if (bucket.count >= PIN_MAX_FAILURES) {
    res.status(429).json({ error: 'Too many failed PIN attempts. Try again in 15 minutes.' });
    return false;
  }

  return true;
}

export function recordPinFailure(req) {
  const ip = getClientIp(req);
  const now = Date.now();
  const bucket = pinFailureBuckets.get(ip);

  if (!bucket || now > bucket.resetAt) {
    pinFailureBuckets.set(ip, { count: 1, resetAt: now + PIN_LOCKOUT_MS });
    return;
  }

  bucket.count += 1;
}

export function clearPinFailures(req) {
  pinFailureBuckets.delete(getClientIp(req));
}
