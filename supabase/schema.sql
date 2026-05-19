-- ═══════════════════════════════════════════════════════════
-- ZapPlay — Production Database Schema
-- Run this entire file in Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════

-- ── EXTENSIONS ──
create extension if not exists "uuid-ossp";
create extension if not exists "pg_trgm"; -- for fast text search

-- ═══════════════════════════════════════════════════════════
-- TABLES
-- ═══════════════════════════════════════════════════════════

-- PROFILES (extends Supabase auth.users)
create table if not exists public.profiles (
  id           uuid references auth.users(id) on delete cascade primary key,
  username     text unique not null,
  avatar_url   text,
  is_admin     boolean default false,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

-- GAMES
create table if not exists public.games (
  id            serial primary key,
  title         text not null,
  category      text not null,
  description   text default '',
  thumbnail_url text default '',
  game_url      text not null,
  rating        numeric(3,1) default 0 check (rating >= 0 and rating <= 5),
  play_count    integer default 0 check (play_count >= 0),
  is_new        boolean default true,
  is_hot        boolean default false,
  tags          text[] default '{}',
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- FAVORITES
create table if not exists public.favorites (
  id         serial primary key,
  user_id    uuid references public.profiles(id) on delete cascade not null,
  game_id    integer references public.games(id) on delete cascade not null,
  created_at timestamptz default now(),
  unique(user_id, game_id)
);

-- PLAY HISTORY
create table if not exists public.play_history (
  id         serial primary key,
  user_id    uuid references public.profiles(id) on delete cascade not null,
  game_id    integer references public.games(id) on delete cascade not null,
  played_at  timestamptz default now()
);

-- RATINGS
create table if not exists public.ratings (
  id         serial primary key,
  user_id    uuid references public.profiles(id) on delete cascade not null,
  game_id    integer references public.games(id) on delete cascade not null,
  score      integer not null check (score between 1 and 5),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(user_id, game_id)
);

-- ═══════════════════════════════════════════════════════════
-- INDEXES (performance)
-- ═══════════════════════════════════════════════════════════

create index if not exists idx_games_category    on public.games(category);
create index if not exists idx_games_is_hot      on public.games(is_hot) where is_hot = true;
create index if not exists idx_games_is_new      on public.games(is_new) where is_new = true;
create index if not exists idx_games_play_count  on public.games(play_count desc);
create index if not exists idx_games_rating      on public.games(rating desc);
create index if not exists idx_games_title_trgm  on public.games using gin(title gin_trgm_ops);
create index if not exists idx_favorites_user    on public.favorites(user_id);
create index if not exists idx_play_history_user on public.play_history(user_id);
create index if not exists idx_play_history_game on public.play_history(game_id);
create index if not exists idx_ratings_game      on public.ratings(game_id);

-- ═══════════════════════════════════════════════════════════
-- FUNCTIONS & TRIGGERS
-- ═══════════════════════════════════════════════════════════

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, username)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data->>'username',
      split_part(new.email, '@', 1)
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Auto-update updated_at timestamps
create or replace function public.handle_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_profiles_updated_at
  before update on public.profiles
  for each row execute procedure public.handle_updated_at();

create trigger set_games_updated_at
  before update on public.games
  for each row execute procedure public.handle_updated_at();

create trigger set_ratings_updated_at
  before update on public.ratings
  for each row execute procedure public.handle_updated_at();

-- Atomic play count increment (prevents race conditions)
create or replace function public.increment_play_count(game_id integer)
returns void
language plpgsql
security definer
as $$
begin
  update public.games
  set play_count = play_count + 1
  where id = game_id;
end;
$$;

-- Recalculate average rating after insert/update
create or replace function public.recalculate_rating()
returns trigger
language plpgsql
security definer
as $$
declare
  avg_rating numeric(3,1);
begin
  select round(avg(score)::numeric, 1)
  into avg_rating
  from public.ratings
  where game_id = new.game_id;

  update public.games
  set rating = coalesce(avg_rating, 0)
  where id = new.game_id;

  return new;
end;
$$;

create trigger on_rating_change
  after insert or update on public.ratings
  for each row execute procedure public.recalculate_rating();

-- ═══════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY (RLS)
-- ═══════════════════════════════════════════════════════════

alter table public.profiles    enable row level security;
alter table public.games       enable row level security;
alter table public.favorites   enable row level security;
alter table public.play_history enable row level security;
alter table public.ratings     enable row level security;

-- ── PROFILES ──
-- Anyone can read profiles (for leaderboards etc)
create policy "profiles_select_public"
  on public.profiles for select
  using (true);

-- Users can only update their own profile
create policy "profiles_update_own"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- ── GAMES ──
-- Anyone can read games
create policy "games_select_public"
  on public.games for select
  using (true);

-- Only admins can insert/update/delete games
create policy "games_insert_admin"
  on public.games for insert
  with check (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_admin = true
    )
  );

create policy "games_update_admin"
  on public.games for update
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_admin = true
    )
  );

create policy "games_delete_admin"
  on public.games for delete
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_admin = true
    )
  );

-- ── FAVORITES ──
-- Users can only see/manage their own favorites
create policy "favorites_select_own"
  on public.favorites for select
  using (auth.uid() = user_id);

create policy "favorites_insert_own"
  on public.favorites for insert
  with check (auth.uid() = user_id);

create policy "favorites_delete_own"
  on public.favorites for delete
  using (auth.uid() = user_id);

-- ── PLAY HISTORY ──
-- Users can only see/insert their own history
create policy "play_history_select_own"
  on public.play_history for select
  using (auth.uid() = user_id);

create policy "play_history_insert_own"
  on public.play_history for insert
  with check (auth.uid() = user_id);

-- ── RATINGS ──
-- Anyone can read ratings (for avg calculation)
create policy "ratings_select_public"
  on public.ratings for select
  using (true);

-- Users can only insert/update their own rating
create policy "ratings_insert_own"
  on public.ratings for insert
  with check (auth.uid() = user_id);

create policy "ratings_update_own"
  on public.ratings for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ═══════════════════════════════════════════════════════════
-- REALTIME PUBLICATIONS
-- Enable realtime on tables that need live updates
-- ═══════════════════════════════════════════════════════════

-- Enable realtime for games (live play count, rating updates)
alter publication supabase_realtime add table public.games;

-- Enable realtime for new games notification
-- (already covered by games table above)

-- ═══════════════════════════════════════════════════════════
-- SEED DATA — initial games
-- ═══════════════════════════════════════════════════════════

insert into public.games (title, category, description, thumbnail_url, game_url, is_hot, is_new, tags, play_count, rating) values
('Turbo Smash Arena',    'Action',   'Battle waves of enemies in a fast-paced arena. Unlock power-ups and dominate the leaderboard.',       'https://picsum.photos/seed/1zp/320/200',  'https://www.crazygames.com/embed/1v1-lol',                              true,  false, '{fighting,arena,multiplayer}', 1240000, 4.8),
('Pixel Dungeon Rush',   'Adventure','Descend into pixel dungeons. Collect loot, level up and face terrifying bosses.',                      'https://picsum.photos/seed/2zp/320/200',  'https://html-classic.itch.zone/html/1136965/index.html',                false, true,  '{rpg,dungeon,pixel}',          890000,  4.5),
('Color Block Puzzle',   'Puzzle',   'Match colorful blocks before the board fills up. Hundreds of hand-crafted levels.',                    'https://picsum.photos/seed/3zp/320/200',  'https://www.puzzle-tetris.com/',                                        true,  false, '{puzzle,color,relaxing}',      2100000, 4.7),
('Galaxy Drift Racing',  'Racing',   'Race through neon-lit space tracks. Drift, boost and dominate the galaxy circuit.',                    'https://picsum.photos/seed/4zp/320/200',  'https://play.famobi.com/swerve-car',                                    false, true,  '{racing,space,drift}',         760000,  4.6),
('Sniper Strike Elite',  'Shooting', 'Take on precision sniper missions. One shot, one kill — stay hidden, stay deadly.',                    'https://picsum.photos/seed/5zp/320/200',  'https://html-classic.itch.zone/html/5604381/index.html',                true,  false, '{sniper,shooter,stealth}',     1560000, 4.4),
('Soccer Masters 2025',  'Sports',   'Fast-paced soccer matches against AI or friends. Score stunning goals and lift the cup.',               'https://picsum.photos/seed/6zp/320/200',  'https://play.famobi.com/penalty-shooters-2',                            false, true,  '{soccer,sport,multiplayer}',   980000,  4.3),
('Zombie Wave Survival', 'Action',   'Barricade, arm up and survive endless zombie waves in this intense top-down shooter.',                  'https://picsum.photos/seed/7zp/320/200',  'https://html-classic.itch.zone/html/1136965/index.html',                true,  false, '{zombie,survival,wave}',       2300000, 4.5),
('Brain Teaser IQ',      'Puzzle',   'Push your mental limits with clever riddles, logic puzzles and brain teasers.',                        'https://picsum.photos/seed/8zp/320/200',  'https://www.puzzle-tetris.com/',                                        true,  true,  '{brain,logic,iq}',             1700000, 4.9),
('Kart Thunder GP',      'Racing',   'Cartoon kart racing packed with weapons, shortcuts and chaos across 8 unique tracks.',                 'https://picsum.photos/seed/9zp/320/200',  'https://play.famobi.com/swerve-car',                                    false, false, '{kart,racing,cartoon}',        540000,  4.2),
('Neon Slither IO',      'IO',       'Grow your glowing snake by eating orbs. Become the biggest in the neon arena.',                        'https://picsum.photos/seed/10zp/320/200', 'https://slither.io/',                                                   true,  false, '{io,snake,multiplayer}',       3200000, 4.6),
('Bubble Shooter Pro',   'Casual',   'Classic bubble popping fun with hundreds of challenging levels and satisfying combos.',                 'https://picsum.photos/seed/11zp/320/200', 'https://play.famobi.com/bubble-shooter-pro',                            false, false, '{bubble,casual,color}',        4100000, 4.4),
('Cyber Ninja Blade',    'Action',   'Slash through cyberpunk enemies with fluid combos, parries and unlockable abilities.',                  'https://picsum.photos/seed/12zp/320/200', 'https://html-classic.itch.zone/html/5604381/index.html',                false, true,  '{ninja,action,blade}',         890000,  4.7),
('Word Chain Master',    'Puzzle',   'Chain words together faster than the clock. A smart vocabulary challenge.',                             'https://picsum.photos/seed/13zp/320/200', 'https://www.puzzle-tetris.com/',                                        false, true,  '{word,vocabulary,brain}',      670000,  4.5),
('Deep Sea Diver',       'Adventure','Dive into the mysterious ocean, discover treasures and survive sea creatures.',                         'https://picsum.photos/seed/14zp/320/200', 'https://html-classic.itch.zone/html/1136965/index.html',                false, true,  '{ocean,explore,treasure}',     430000,  4.3),
('Tower Defense Ultra',  'Strategy', 'Build the ultimate defense and stop waves of enemies. 50+ tower types.',                               'https://picsum.photos/seed/15zp/320/200', 'https://html-classic.itch.zone/html/1136965/index.html',                true,  false, '{tower,defense,strategy}',     1900000, 4.8),
('Stunt Bike Xtreme',    'Racing',   'Pull off insane stunts on your dirt bike across dangerous ramps and obstacles.',                        'https://picsum.photos/seed/16zp/320/200', 'https://play.famobi.com/swerve-car',                                    false, true,  '{stunt,bike,extreme}',         340000,  4.1),
('Farm & Harvest',       'Casual',   'Build your dream farm, grow crops, raise animals and trade with neighbors.',                           'https://picsum.photos/seed/17zp/320/200', 'https://play.famobi.com/bubble-shooter-pro',                            false, false, '{farm,simulation,relaxing}',   2800000, 4.6),
('Retro Pixel War',      'Shooting', 'Classic arcade top-down shooter with pixel art graphics and a chiptune soundtrack.',                   'https://picsum.photos/seed/18zp/320/200', 'https://html-classic.itch.zone/html/5604381/index.html',                false, false, '{retro,pixel,arcade}',         760000,  4.3),
('Chess Champions',      'Strategy', 'Play chess against intelligent AI at multiple difficulty levels.',                                     'https://picsum.photos/seed/19zp/320/200', 'https://lichess.org/',                                                  true,  false, '{chess,strategy,classic}',     1200000, 4.9),
('Sky Runner Infinite',  'Casual',   'Endless runner in the clouds. Dodge obstacles, collect coins, unlock characters.',                     'https://picsum.photos/seed/20zp/320/200', 'https://play.famobi.com/bubble-shooter-pro',                            true,  false, '{runner,infinite,casual}',     5600000, 4.4),
('Monster Truck Mayhem', 'Racing',   'Crush cars in massive monster trucks. Demolition derby mayhem across 12 arenas.',                      'https://picsum.photos/seed/21zp/320/200', 'https://play.famobi.com/swerve-car',                                    false, true,  '{truck,monster,destruction}',  430000,  4.2),
('Space Shooter X',      'Shooting', 'Space invaders-inspired shooter with modern graphics and epic boss battles.',                          'https://picsum.photos/seed/22zp/320/200', 'https://html-classic.itch.zone/html/5604381/index.html',                false, true,  '{space,arcade,shooter}',       980000,  4.5),
('Merge Dragon City',    'Casual',   'Merge dragons, build your island city and unlock rare dragon species.',                                'https://picsum.photos/seed/23zp/320/200', 'https://play.famobi.com/bubble-shooter-pro',                            true,  false, '{merge,dragon,city}',          3400000, 4.7),
('Parkour Street Run',   'Action',   'Sprint, flip and wall-run across sprawling urban environments.',                                       'https://picsum.photos/seed/24zp/320/200', 'https://html-classic.itch.zone/html/1136965/index.html',                false, true,  '{parkour,runner,urban}',       1100000, 4.4)
on conflict do nothing;
