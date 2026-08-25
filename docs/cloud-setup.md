# 계정 로그인 동기화 붙이기 (10분)

앱 쓰는 사람이 **이메일/비번으로 로그인**해서, 폰과 컴퓨터에서 같은 데이터를 보게 하는 설정입니다.
깃허브 계정 같은 건 필요 없고, 쓰는 사람은 그냥 로그인만 하면 됩니다.

이 설정은 **한 번만** 하면 됩니다.

## 1. Supabase 프로젝트 만들기 (무료)

1. https://supabase.com 가입 → **New project**
2. 이름 아무거나, 지역은 `Northeast Asia (Seoul)` 추천
3. 데이터베이스 비밀번호는 아무거나 정하고 따로 적어두세요 (앱에서는 안 씁니다)

## 2. 테이블과 권한 만들기

프로젝트 화면 왼쪽 **SQL Editor** → 아래를 통째로 붙여넣고 **Run**.

```sql
create table if not exists public.portfolios (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.portfolios enable row level security;

-- 로그인한 사람은 '자기 행'만 읽고 쓸 수 있다
create policy "read own"   on public.portfolios for select using (auth.uid() = user_id);
create policy "insert own" on public.portfolios for insert with check (auth.uid() = user_id);
create policy "update own" on public.portfolios for update using (auth.uid() = user_id);
```

## 3. 이메일 인증 끄기 (선택, 권장)

**Authentication → Sign In / Providers → Email** 에서 `Confirm email` 을 꺼두면
가입 즉시 바로 쓸 수 있습니다. 켜두면 메일함에서 링크를 눌러야 합니다.

## 4. 앱에 주소 넣기

**Project Settings → API** 에서 두 값을 복사해 `web/cloud.json` 에 채우고 커밋합니다.

```json
{
  "url": "https://xxxxxxxxxxxx.supabase.co",
  "anonKey": "eyJhbGciOi...."
}
```

`anon` 키는 **공개돼도 되는 값**입니다. 브라우저에 들어가는 게 정상이고,
실제 접근 제어는 위에서 만든 RLS 정책이 합니다. (`service_role` 키는 절대 넣지 마세요.)

푸시하면 깃허브 페이지가 다시 배포되고, 앱 **설정 → 기기 동기화** 에
로그인 화면이 생깁니다.

## 5. 쓰는 방법

- 폰에서 앱 열기 → 설정 → 기기 동기화 → 이메일/비번으로 **가입**
- 컴퓨터에서 같은 주소 열기 → 같은 이메일/비번으로 **로그인**
- 끝. 앱을 켤 때 자동으로 내려받고, 뭘 고치면 몇 초 뒤 자동으로 올라갑니다

## 알아둘 것

- 무료 프로젝트는 **일주일 정도 아무도 안 쓰면 잠자기 상태**가 됩니다.
  그때는 Supabase 대시보드에서 한 번 깨워주면 됩니다.
- 로그인을 안 해도 앱은 그냥 동작합니다. 그 기기에만 저장될 뿐입니다.
- `web/cloud.json` 을 비워두면 로그인 화면 대신 이 문서 안내가 뜹니다.
