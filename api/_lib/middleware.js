// ═══════════════════════════════════════════════════════
// Professional middleware: auth, rate limiting, validation
// ═══════════════════════════════════════════════════════
import { supabaseAdmin } from './supabase.js';

// ── In-memory rate limit store (per IP, per endpoint) ──
const rateLimitStore = new Map();

export function rateLimit(ip, endpoint, max = 20, windowMs = 60_000) {
  const key   = `${ip}:${endpoint}`;
  const now   = Date.now();
  const entry = rateLimitStore.get(key) || { count: 0, reset: now + windowMs };

  if (now > entry.reset) {
    entry.count = 0;
    entry.reset = now + windowMs;
  }

  entry.count++;
  rateLimitStore.set(key, entry);

  return {
    allowed:   entry.count <= max,
    remaining: Math.max(0, max - entry.count),
    reset:     entry.reset,
  };
}

function getHeader(req, name) {
  if (typeof req.headers.get === 'function') {
    return req.headers.get(name);
  }
  return req.headers[name] || null;
}

export function getIP(req) {
  const fwd  = getHeader(req, 'x-forwarded-for');
  const real = getHeader(req, 'x-real-ip');
  return fwd?.split(',')[0]?.trim() || real || 'unknown';
}

export async function requireAuth(req) {
  const authHeader = getHeader(req, 'authorization') || '';
  const token = authHeader.replace('Bearer ', '').trim();

  if (!token) {
    throw new ApiError(401, 'Authentication required');
  }

  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);

  if (error || !user) {
    throw new ApiError(401, 'Invalid or expired token');
  }

  return { user, token };
}

export async function optionalAuth(req) {
  try {
    return await requireAuth(req);
  } catch {
    return { user: null, token: null };
  }
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status  = status;
    this.message = message;
  }
}

export const respond = {
  ok:     (data, status = 200) => Response.json({ ok: true,  data },                { status }),
  error:  (msg,  status = 400) => Response.json({ ok: false, error: msg },          { status }),
  unauth: ()                   => Response.json({ ok: false, error: 'Unauthorized' },{ status: 401 }),
  tooMany: (reset)             => Response.json(
    { ok: false, error: 'Too many requests. Please wait and try again.' },
    { status: 429, headers: { 'Retry-After': String(Math.ceil((reset - Date.now()) / 1000)) } }
  ),
};

export function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str.trim().replace(/[<>"'`]/g, '');
}

export const validate = {
  email:    (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  username: (v) => /^[a-zA-Z0-9_]{3,24}$/.test(v),
  password: (v) => typeof v === 'string' && v.length >= 8 && v.length <= 72,
  uuid:     (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
  int:      (v, min = 1, max = Infinity) => Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max,
};

export function withErrorHandling(handler) {
  return async (req, res) => {
    try {
      const result = await handler(req, res);
      if (result instanceof Response) {
        const body = await result.text();
        const status = result.status;
        const ct = result.headers.get('content-type') || 'application/json';
        if (res && typeof res.status === 'function') {
          res.status(status).setHeader('Content-Type', ct).send(body);
        }
        return result;
      }
      return result;
    } catch (err) {
      if (err instanceof ApiError) {
        const body = JSON.stringify({ ok: false, error: err.message });
        if (res && typeof res.status === 'function') {
          res.status(err.status).setHeader('Content-Type', 'application/json').send(body);
        }
        return new Response(body, { status: err.status, headers: { 'Content-Type': 'application/json' } });
      }
      console.error('[ZapPlay API Error]', err);
      const body = JSON.stringify({ ok: false, error: 'Internal server error' });
      if (res && typeof res.status === 'function') {
        res.status(500).setHeader('Content-Type', 'application/json').send(body);
      }
      return new Response(body, { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  };
}