-- ============================================================
--  찬홍팍 주식관리 - Supabase 초기 설정
--  Supabase 프로젝트 > 왼쪽 메뉴 SQL Editor 에 통째로 붙여넣고 Run
--  한 번만 실행하면 됩니다. 여러 번 실행해도 안전합니다.
-- ============================================================

-- 1) 데이터 테이블
--    사용자 한 명당 한 줄. 앱 데이터 전체가 data(jsonb) 한 칸에 들어간다.
create table if not exists public.portfolios (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- 2) 행 단위 보안 켜기
--    이걸 켜야 "남의 데이터는 못 본다" 가 데이터베이스 차원에서 강제된다.
alter table public.portfolios enable row level security;

-- 3) 권한: 로그인한 사람은 '자기 행' 만 읽고 쓸 수 있다
drop policy if exists "read own"   on public.portfolios;
drop policy if exists "insert own" on public.portfolios;
drop policy if exists "update own" on public.portfolios;

create policy "read own"
  on public.portfolios for select
  using (auth.uid() = user_id);

create policy "insert own"
  on public.portfolios for insert
  with check (auth.uid() = user_id);

create policy "update own"
  on public.portfolios for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ============================================================
--  확인용: 아래를 실행하면 정책 3개가 보이면 정상입니다.
--    select policyname, cmd from pg_policies where tablename = 'portfolios';
-- ============================================================
