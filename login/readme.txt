1. Go to your Supabase dashboard and open the SQL Editor.

2. Run this query to create a profiles table that links to Supabase's built-in auth.users:

SQL

create table public.profiles (
  id uuid references auth.users on delete cascade primary key,
  username text,
  role text default 'user' check (role in ('user', 'moderator', 'admin'))
);

-- Enable Row Level Security
alter table public.profiles enable row level security;

-- Allow users to read and update their own profile
create policy "Public profiles are viewable by everyone." on profiles for select using (true);
create policy "Users can update own profile." on profiles for update using (auth.uid() = id);

3. Create a Database Trigger so that whenever someone signs up, a row is automatically created in profiles with the default role of 'user':

SQL
create function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, username, role)
  values (new.id, new.raw_user_meta_data->>'username', 'user');
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

(Note: Once you register test accounts, you can go into the Supabase Table Editor and manually change a user's role column to 'admin' or 'moderator' to test your permission levels).

File 1: index.html (Page 1 - Login & Registration)
This page handles logging in, signing up, and routing users to the dashboard once authenticated.