// 계정 기반 동기화 (Supabase).
//
// 왜 이게 필요한가
//   앱을 쓰는 사람이 깃허브 계정이 없어도, 폰과 컴퓨터에서 이메일/비번으로
//   로그인해 같은 데이터를 보게 하려면 진짜 백엔드가 하나 있어야 한다.
//   Supabase 는 무료이고, 브라우저에서 바로 호출되며(CORS), 로그인과
//   행 단위 권한(RLS)이 기본으로 들어 있다.
//
// 여기서 쓰는 anon key 는 공개돼도 되는 값이다. 실제 접근 제어는
// Supabase 의 RLS 가 "자기 행만 읽고 쓴다"로 막는다.

const CONFIG_URL = './cloud.json';
const TOKEN_KEY = 'chanhong.cloud.session';
const TABLE = 'portfolios';

let config = null;

export async function loadConfig() {
  if (config !== null) return config;
  try {
    const res = await fetch(`${CONFIG_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error('없음');
    const d = await res.json();
    config = (d.url && d.anonKey && !String(d.url).includes('여기에')) ? d : false;
  } catch {
    config = false;
  }
  return config;
}

export function isConfigured() { return Boolean(config); }

// ─────────────────────────────── 세션
export function loadSession() {
  try { return JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null'); } catch { return null; }
}

function saveSession(s) {
  try { localStorage.setItem(TOKEN_KEY, JSON.stringify(s)); } catch { /* 무시 */ }
  return s;
}

export function clearSession() {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* 무시 */ }
}

// ─────────────────────────────── 통신
async function call(path, { method = 'GET', body, token, headers = {} } = {}) {
  let res;
  try {
    res = await fetch(`${config.url}${path}`, {
      method,
      headers: {
        apikey: config.anonKey,
        Authorization: `Bearer ${token || config.anonKey}`,
        'Content-Type': 'application/json',
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    // 네트워크 자체가 안 될 때 브라우저는 "Failed to fetch" 만 준다
    throw new Error('서버에 연결할 수 없습니다. 인터넷 연결이나 cloud.json 주소를 확인하세요');
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = data?.msg || data?.message || data?.error_description || data?.error
      || `오류 ${res.status}`;
    throw new Error(translate(msg));
  }
  return data;
}

function translate(msg) {
  const m = String(msg);
  if (/Invalid login credentials/i.test(m)) return '이메일이나 비밀번호가 틀렸습니다';
  if (/User already registered/i.test(m)) return '이미 가입된 이메일입니다. 로그인하세요';
  if (/Password should be at least/i.test(m)) return '비밀번호는 6자 이상이어야 합니다';
  if (/Email not confirmed/i.test(m)) return '메일함에서 인증 링크를 눌러주세요';
  if (/Unable to validate email/i.test(m)) return '이메일 형식이 올바르지 않습니다';
  return m;
}

function store(d) {
  if (!d?.access_token) throw new Error('로그인 응답이 이상합니다');
  return saveSession({
    accessToken: d.access_token,
    refreshToken: d.refresh_token,
    userId: d.user?.id,
    email: d.user?.email,
    expiresAt: Date.now() + (Number(d.expires_in) || 3600) * 1000,
  });
}

export async function signUp(email, password) {
  const d = await call('/auth/v1/signup', { method: 'POST', body: { email, password } });
  // 이메일 인증이 켜져 있으면 토큰이 안 온다
  if (!d?.access_token) return { needsConfirm: true };
  return { session: store(d) };
}

export async function signIn(email, password) {
  const d = await call('/auth/v1/token?grant_type=password', {
    method: 'POST', body: { email, password },
  });
  return store(d);
}

async function fresh() {
  const s = loadSession();
  if (!s) throw new Error('로그인이 필요합니다');
  if (Date.now() < s.expiresAt - 60_000) return s;
  const d = await call('/auth/v1/token?grant_type=refresh_token', {
    method: 'POST', body: { refresh_token: s.refreshToken },
  });
  return store(d);
}

// ─────────────────────────────── 데이터
export async function pull() {
  const s = await fresh();
  const rows = await call(
    `/rest/v1/${TABLE}?select=data,updated_at&user_id=eq.${s.userId}`,
    { token: s.accessToken },
  );
  if (!rows?.length) return null;
  return { data: rows[0].data, updatedAt: rows[0].updated_at };
}

export async function push(data) {
  const s = await fresh();
  await call(`/rest/v1/${TABLE}`, {
    method: 'POST',
    token: s.accessToken,
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: [{ user_id: s.userId, data, updated_at: new Date().toISOString() }],
  });
  return new Date().toISOString();
}
