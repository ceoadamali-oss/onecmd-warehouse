import crypto from 'crypto';

function getSecret() {
  const secret = process.env.SESSION_JWT_SECRET || process.env.MANAGER_SESSION_SECRET;
  if (secret && secret.length >= 32) return secret;
  if (process.env.NODE_ENV !== 'production') {
    return 'dev-only-session-secret-change-before-production!!';
  }
  throw new Error('SESSION_JWT_SECRET must be set (min 32 chars) in production.');
}

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

function fromB64url(input) {
  return Buffer.from(input, 'base64url').toString('utf8');
}

export function signStaffSession(payload, ttlHours = 12) {
  const secret = getSecret();
  const session = {
    ...payload,
    exp: Date.now() + ttlHours * 60 * 60 * 1000,
  };
  const body = b64url(JSON.stringify(session));
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyStaffSession(token) {
  try {
    const secret = getSecret();
    const [body, sig] = token.split('.');
    if (!body || !sig) return { ok: false, error: 'Malformed token' };

    const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return { ok: false, error: 'Invalid token signature' };
    }

    const session = JSON.parse(fromB64url(body));
    if (!session?.username || !session?.role || !session.exp) {
      return { ok: false, error: 'Invalid token payload' };
    }
    if (Date.now() > session.exp) {
      return { ok: false, error: 'Session expired' };
    }
    return { ok: true, session };
  } catch {
    return { ok: false, error: 'Invalid token' };
  }
}

export function readBearerToken(req) {
  const raw = req.headers?.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice(7).trim();
}

export function requireStaffAuth(req, res, options) {
  const token = readBearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'Authentication required.' });
    return null;
  }

  const verified = verifyStaffSession(token);
  if (!verified.ok) {
    res.status(401).json({ error: verified.error });
    return null;
  }

  if (options?.roles && !options.roles.includes(verified.session.role)) {
    res.status(403).json({ error: 'Insufficient permissions.' });
    return null;
  }

  return verified.session;
}

export function isSuperAdminSession(session) {
  return session?.role === 'SUPER_ADMIN';
}
