import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  try {
    const limit  = Math.min(Number(req.query.limit  || 50), 100);
    const offset = Number(req.query.offset || 0);
    const cat    = req.query.cat    || '';
    const search = req.query.search || '';
    const sort   = req.query.sort   || 'play_count';

    let query = supabase
      .from('games')
      .select('*', { count: 'exact' })
      .order(sort === 'rating' ? 'rating' : 'play_count', { ascending: false })
      .range(offset, offset + limit - 1);

    if (cat && cat !== 'All') {
      if (cat === '__hot__')      query = query.eq('is_hot', true);
      else if (cat === '__new__') query = query.eq('is_new', true);
      else                        query = query.eq('category', cat);
    }

    if (search) {
      query = query.or(`title.ilike.%${search}%,category.ilike.%${search}%`);
    }

    const { data, error, count } = await query;

    if (error) return res.status(500).json({ ok: false, error: error.message });

    return res.status(200).json({ ok: true, data: { games: data, total: count } });

  } catch (err) {
    console.error('[games error]', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}