// ═══════════════════════════════════════════════════════
// /api/favorites — Favorites (requires auth)
// ═══════════════════════════════════════════════════════


import { supabaseAdmin }                                     from './_lib/supabase.js';
import { rateLimit, getIP, validate,
         respond, withErrorHandling,
         requireAuth, ApiError }                             from './_lib/middleware.js';

export default withErrorHandling(async function handler(req) {
  const ip   = getIP(req);
  const rl   = rateLimit(ip, 'favorites', 60, 60_000);
  if (!rl.allowed) return respond.tooMany(rl.reset);

  const { user } = await requireAuth(req);

  // GET — fetch all favorites for user
  if (req.method === 'GET') {
    const { data, error } = await supabaseAdmin
      .from('favorites')
      .select('game_id, games(id, title, category, thumbnail_url, rating, play_count, is_hot, is_new, tags)')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (error) throw new ApiError(500, error.message);
    return respond.ok({ favorites: data.map(f => f.games) });
  }

  // POST — add favorite
  if (req.method === 'POST') {
    const body   = await req.json();
    const gameId = Number(body.game_id);
    if (!validate.int(gameId, 1)) return respond.error('Invalid game_id');

    // Verify game exists
    const { data: game } = await supabaseAdmin.from('games').select('id').eq('id', gameId).maybeSingle();
    if (!game) return respond.error('Game not found', 404);

    const { error } = await supabaseAdmin
      .from('favorites')
      .insert({ user_id: user.id, game_id: gameId });

    if (error) {
      if (error.code === '23505') return respond.error('Already in favorites');
      throw new ApiError(400, error.message);
    }

    return respond.ok({ message: 'Added to favorites' }, 201);
  }

  // DELETE — remove favorite
  if (req.method === 'DELETE') {
    const body   = await req.json();
    const gameId = Number(body.game_id);
    if (!validate.int(gameId, 1)) return respond.error('Invalid game_id');

    const { error } = await supabaseAdmin
      .from('favorites')
      .delete()
      .eq('user_id', user.id)
      .eq('game_id', gameId);

    if (error) throw new ApiError(400, error.message);
    return respond.ok({ message: 'Removed from favorites' });
  }

  return respond.error('Method not allowed', 405);
});

export const config = { runtime: 'nodejs' };