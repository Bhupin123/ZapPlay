// ═══════════════════════════════════════════════════════
// /api/auth — Server-side authentication
// All logic runs on Vercel Edge — keys never reach browser
// ═══════════════════════════════════════════════════════


import { supabaseAdmin }                                     from './_lib/supabase.js';
import { rateLimit, getIP, sanitize, validate,
         respond, withErrorHandling, requireAuth, ApiError } from './_lib/middleware.js';

export default withErrorHandling(async function handler(req) {
  const ip     = getIP(req);
  const url    = new URL(req.url);
  const action = url.searchParams.get('action');

  // ── Rate limit: 10 auth attempts per minute per IP ──
  const rl = rateLimit(ip, `auth:${action}`, 10, 60_000);
  if (!rl.allowed) return respond.tooMany(rl.reset);

  if (req.method !== 'POST') return respond.error('Method not allowed', 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return respond.error('Invalid JSON body', 400);
  }

  switch (action) {

    // ════════════════════════════════════════
    // SIGN UP
    // ════════════════════════════════════════
    case 'signup': {
      const email    = sanitize(body.email    || '');
      const password = body.password          || '';
      const username = sanitize(body.username || '');

      // Validate
      if (!validate.email(email))    return respond.error('Invalid email address');
      if (!validate.password(password)) return respond.error('Password must be 8–72 characters');
      if (!validate.username(username)) return respond.error('Username must be 3–24 chars, letters/numbers/underscores only');

      // Check username uniqueness
      const { data: existing } = await supabaseAdmin
        .from('profiles')
        .select('id')
        .eq('username', username)
        .maybeSingle();

      if (existing) return respond.error('Username already taken');

      // Create auth user
      const { data, error } = await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: false, // Supabase sends confirmation email
        user_metadata: { username },
      });

      if (error) {
        if (error.message.includes('already registered'))
          return respond.error('An account with this email already exists');
        throw new ApiError(400, error.message);
      }

      return respond.ok({
        message: 'Account created. Check your email to verify.',
        userId: data.user.id,
      }, 201);
    }

    // ════════════════════════════════════════
    // SIGN IN — returns JWT session
    // ════════════════════════════════════════
    case 'signin': {
      const email    = sanitize(body.email || '');
      const password = body.password       || '';

      if (!validate.email(email)) return respond.error('Invalid email address');
      if (!password)              return respond.error('Password is required');

      const { data, error } = await supabaseAdmin.auth.signInWithPassword({
        email, password,
      });

      if (error) return respond.error('Incorrect email or password', 401);

      return respond.ok({
        access_token:  data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at:    data.session.expires_at,
        user: {
          id:       data.user.id,
          email:    data.user.email,
          username: data.user.user_metadata?.username,
        },
      });
    }

    // ════════════════════════════════════════
    // REFRESH TOKEN
    // ════════════════════════════════════════
    case 'refresh': {
      const refreshToken = body.refresh_token || '';
      if (!refreshToken) return respond.error('Refresh token required');

      const { data, error } = await supabaseAdmin.auth.refreshSession({ refresh_token: refreshToken });
      if (error) return respond.error('Session expired. Please sign in again.', 401);

      return respond.ok({
        access_token:  data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at:    data.session.expires_at,
      });
    }

    // ════════════════════════════════════════
    // FORGOT PASSWORD
    // ════════════════════════════════════════
    case 'forgot': {
      const email = sanitize(body.email || '');
      if (!validate.email(email)) return respond.error('Invalid email address');

      // Always return success to prevent email enumeration
      await supabaseAdmin.auth.resetPasswordForEmail(email, {
        redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/reset-password`,
      });

      return respond.ok({ message: 'If an account exists, a reset link was sent.' });
    }

    // ════════════════════════════════════════
    // SIGN OUT — invalidate token server-side
    // ════════════════════════════════════════
    case 'signout': {
      try {
        const { user } = await requireAuth(req);
        await supabaseAdmin.auth.admin.signOut(user.id);
      } catch { /* ignore — already signed out */ }

      return respond.ok({ message: 'Signed out' });
    }

    // ════════════════════════════════════════
    // VERIFY TOKEN — validate session
    // ════════════════════════════════════════
    case 'verify': {
      const { user } = await requireAuth(req);
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('username, avatar_url, created_at')
        .eq('id', user.id)
        .single();

      return respond.ok({
        user: {
          id:         user.id,
          email:      user.email,
          username:   profile?.username || user.user_metadata?.username,
          avatar_url: profile?.avatar_url,
          created_at: profile?.created_at,
        },
      });
    }

    default:
      return respond.error('Unknown action', 400);
  }
});

export const config = { runtime: 'nodejs' };