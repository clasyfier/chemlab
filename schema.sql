-- ChemLab database schema — run this in Supabase: SQL Editor → New query → paste → Run
create table if not exists public.profiles (
  id uuid references auth.users on delete cascade primary key,
  email text,
  premium boolean not null default false,
  ls_customer_id text,
  progress jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "read own profile"   on public.profiles for select using (auth.uid() = id);
create policy "insert own profile" on public.profiles for insert with check (auth.uid() = id);
create policy "update own profile" on public.profiles for update using (auth.uid() = id);

-- users may update their progress but never their own premium flag
revoke update on public.profiles from authenticated;
grant  update (progress, email, updated_at) on public.profiles to authenticated;

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
