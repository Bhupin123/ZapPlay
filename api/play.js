// ═══════════════════════════════════════════════════════
// /api/play — Play tracking + increment counter
// ═══════════════════════════════════════════════════════


import { supabaseAdmin }                        from './_lib/supabase.js';
import { rateLimit, getIP, validate,
         respond, withErrorHandling,
         optionalAuth, ApiError }               from './_lib/middleware.js';

export default withErrorHandling(async function handler(req) {
  const ip = getIP(req);
  const rl = rateLimit(ip, 'play', 30, 60_000);
  if (!rl.allowed) return respond.tooMany(rl.reset);

  if (req.method !== 'POST') return respond.error('Method not allowed', 405);

  const { user } = await optionalAuth(req);
  const body     = await req.json();
  const gameId   = Number(body.game_id);

  if (!validate.int(gameId, 1)) return respond.error('Invalid game_id');

  // Verify game exists
  const { data: game } = await supabaseAdmin
    .from('games')
    .select('id, play_count')
    .eq('id', gameId)
    .maybeSingle();

  if (!game) return respond.error('Game not found', 404);

  // Atomic play count increment
  await supabaseAdmin.rpc('increment_play_count', { game_id: gameId });

  // Track history if logged in
  if (user) {
    await supabaseAdmin.from('play_history').insert({
      user_id: user.id,
      game_id: gameId,
    });
  }

  return respond.ok({ message: 'Play tracked' });
});

export const config = { runtime: 'nodejs' };