-- ChemLab database schema — run this in Supabase: SQL Editor → New query → paste → Run
create table if not exists public.profiles (
  id uuid references auth.users on delete cascade primary key,
  email text,
  premium boolean not null default false,
  nickname text,
  avatar text,
  avatar_hue int,
  payment_customer_id text,
  progress jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "read own profile"   on public.profiles for select using (auth.uid() = id);
create policy "insert own profile" on public.profiles for insert with check (auth.uid() = id);
create policy "update own profile" on public.profiles for update using (auth.uid() = id);

-- users may update their progress but never their own premium flag
revoke update on public.profiles from authenticated;
grant  update (progress, email, nickname, avatar, avatar_hue, updated_at) on public.profiles to authenticated;

-- auto-create a profile row on signup
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Ranked: prestige test tubes + public leaderboard (added 2026-07-22)
alter table public.profiles add column if not exists tubes integer not null default 0;
grant update (progress, email, nickname, avatar, avatar_hue, updated_at, tubes) on public.profiles to authenticated;
create or replace function public.leaderboard()
returns table(nickname text, avatar_hue int, tubes int)
language sql security definer set search_path=public stable as $fn$
  select coalesce(nullif(nickname,''),'anonymous chemist'), avatar_hue, tubes
  from public.profiles where tubes > 0
  order by tubes desc, updated_at asc limit 25
$fn$;
grant execute on function public.leaderboard() to anon, authenticated;

-- Admin flag: server-set only (not in the authenticated update grant)
alter table public.profiles add column if not exists admin boolean not null default false;

-- Unique nicknames + availability check
create unique index if not exists profiles_nickname_unique on public.profiles (lower(nickname)) where nickname is not null and nickname <> '';
create or replace function public.nick_taken(name text) returns boolean
language sql security definer set search_path=public stable as $fn$
  select exists(select 1 from profiles where lower(nickname)=lower(name) and id <> auth.uid());
$fn$;
grant execute on function public.nick_taken(text) to authenticated;

-- Store (2026-07-24): lifetime/examiner/report/season/cosmetics/quota
alter table public.profiles
  add column if not exists lifetime boolean not null default false,
  add column if not exists examiner boolean not null default false,
  add column if not exists examiner_sub text,
  add column if not exists report_credits integer not null default 0,
  add column if not exists season_until timestamptz,
  add column if not exists flair text,
  add column if not exists ai_month text,
  add column if not exists ai_used integer not null default 0;
grant update (progress, email, nickname, avatar, avatar_hue, updated_at, tubes, flair) on public.profiles to authenticated;
-- leaderboard() now also returns flair
