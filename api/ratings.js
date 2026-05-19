// ═══════════════════════════════════════════════════════
// /api/ratings — Game ratings (requires auth)
// ═══════════════════════════════════════════════════════


import { supabaseAdmin }                        from './_lib/supabase.js';
import { rateLimit, getIP, validate,
         respond, withErrorHandling,
         requireAuth, ApiError }                from './_lib/middleware.js';

export default withErrorHandling(async function handler(req) {
  const ip = getIP(req);
  const rl = rateLimit(ip, 'ratings', 30, 60_000);
  if (!rl.allowed) return respond.tooMany(rl.reset);

  const { user } = await requireAuth(req);

  if (req.method !== 'POST') return respond.error('Method not allowed', 405);

  const body   = await req.json();
  const gameId = Number(body.game_id);
  const score  = Number(body.score);

  if (!validate.int(gameId, 1))    return respond.error('Invalid game_id');
  if (!validate.int(score, 1, 5))  return respond.error('Score must be between 1 and 5');

  // Upsert rating
  const { error } = await supabaseAdmin
    .from('ratings')
    .upsert(
      { user_id: user.id, game_id: gameId, score },
      { onConflict: 'user_id,game_id' }
    );

  if (error) throw new ApiError(400, error.message);

  // Recalculate average rating for game
  const { data: avgData } = await supabaseAdmin
    .from('ratings')
    .select('score')
    .eq('game_id', gameId);

  if (avgData?.length) {
    const avg = avgData.reduce((s, r) => s + r.score, 0) / avgData.length;
    await supabaseAdmin.from('games').update({ rating: Math.round(avg * 10) / 10 }).eq('id', gameId);
  }

  return respond.ok({ message: 'Rating saved', score });
});

export const config = { runtime: 'nodejs' };