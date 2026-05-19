// ═══════════════════════════════════════════════════════
// /api/profile — User profile (requires auth)
// ═══════════════════════════════════════════════════════


import { supabaseAdmin }                        from './_lib/supabase.js';
import { rateLimit, getIP, sanitize, validate,
         respond, withErrorHandling,
         requireAuth, ApiError }                from './_lib/middleware.js';

export default withErrorHandling(async function handler(req) {
  const ip = getIP(req);
  const rl = rateLimit(ip, 'profile', 30, 60_000);
  if (!rl.allowed) return respond.tooMany(rl.reset);

  const { user } = await requireAuth(req);

  // GET — fetch profile + stats
  if (req.method === 'GET') {
    const [profileRes, favRes, playRes] = await Promise.all([
      supabaseAdmin.from('profiles').select('*').eq('id', user.id).single(),
      supabaseAdmin.from('favorites').select('game_id', { count: 'exact', head: true }).eq('user_id', user.id),
      supabaseAdmin.from('play_history').select('game_id', { count: 'exact', head: true }).eq('user_id', user.id),
    ]);

    return respond.ok({
      profile: {
        ...profileRes.data,
        email:       user.email,
        fav_count:   favRes.count  || 0,
        play_count:  playRes.count || 0,
      },
    });
  }

  // PATCH — update profile
  if (req.method === 'PATCH') {
    const body = await req.json();
    const updates = {};

    if (body.username !== undefined) {
      const username = sanitize(body.username);
      if (!validate.username(username)) return respond.error('Invalid username format');

      // Check uniqueness (exclude current user)
      const { data: taken } = await supabaseAdmin
        .from('profiles')
        .select('id')
        .eq('username', username)
        .neq('id', user.id)
        .maybeSingle();

      if (taken) return respond.error('Username already taken');
      updates.username = username;
    }

    if (Object.keys(updates).length === 0) return respond.error('Nothing to update');

    const { data, error } = await supabaseAdmin
      .from('profiles')
      .update(updates)
      .eq('id', user.id)
      .select()
      .single();

    if (error) throw new ApiError(400, error.message);
    return respond.ok({ profile: data });
  }

  return respond.error('Method not allowed', 405);
});

export const config = { runtime: 'nodejs' };