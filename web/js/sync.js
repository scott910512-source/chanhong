// 기기 간 동기화. 깃허브 Gist 를 개인 저장소로 쓴다.
//
// 왜 Gist 인가
//   - 서버를 따로 띄울 필요가 없다 (이 앱은 깃허브 페이지에 올라간 정적 파일이다)
//   - 깃허브 API 는 CORS 를 열어놔서 브라우저에서 바로 호출된다
//   - 무료이고, 저장할 때마다 버전이 남는다
//
// 알아둘 것
//   - secret gist 는 "검색에 안 뜬다" 는 뜻이지 비밀번호가 걸린 게 아니다.
//     주소(32자리 임의 문자열)를 아는 사람은 볼 수 있다.
//   - 토큰은 이 기기 브라우저에만 저장된다. gist 권한만 준 토큰을 쓰고,
//     기기를 잃어버리면 깃허브에서 그 토큰을 폐기하면 된다.

const API = 'https://api.github.com';
const FILENAME = 'chanhong-portfolio.json';

async function gh(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new Error('토큰이 잘못됐거나 만료됐습니다');
  if (res.status === 403) throw new Error('권한이 없습니다. 토큰에 gist 권한을 주세요');
  if (res.status === 404) throw new Error('저장소를 찾을 수 없습니다 (연결 코드 확인)');
  if (!res.ok) throw new Error(`깃허브 오류 ${res.status}`);
  return res.json();
}

export async function createRemote(token, data) {
  const d = await gh('/gists', {
    token,
    method: 'POST',
    body: {
      description: '찬홍팍 주식관리 데이터 (앱이 자동으로 관리합니다)',
      public: false,
      files: { [FILENAME]: { content: JSON.stringify(data, null, 1) } },
    },
  });
  return d.id;
}

export async function pull(token, gistId) {
  const d = await gh(`/gists/${gistId}`, { token });
  const file = d.files?.[FILENAME] || Object.values(d.files || {})[0];
  if (!file) throw new Error('저장소가 비어 있습니다');
  // 1MB 를 넘으면 깃허브가 내용을 잘라서 주므로 원본을 따로 받는다
  const text = file.truncated ? await (await fetch(file.raw_url)).text() : file.content;
  return { data: JSON.parse(text), updatedAt: d.updated_at };
}

export async function push(token, gistId, data) {
  await gh(`/gists/${gistId}`, {
    token,
    method: 'PATCH',
    body: { files: { [FILENAME]: { content: JSON.stringify(data, null, 1) } } },
  });
  return new Date().toISOString();
}

// ─────────────────────────────── 연결 코드
// 다른 기기에서 토큰·주소를 일일이 입력하지 않게 한 덩어리로 만든다.
export function makeCode(token, gistId) {
  return `chanhong.${btoa(unescape(encodeURIComponent(`${gistId}:${token}`)))}`;
}

export function readCode(code) {
  const raw = String(code || '').trim();
  if (!raw.startsWith('chanhong.')) throw new Error('연결 코드 형식이 아닙니다');
  const decoded = decodeURIComponent(escape(atob(raw.slice('chanhong.'.length))));
  const at = decoded.indexOf(':');
  if (at < 0) throw new Error('연결 코드가 손상됐습니다');
  return { gistId: decoded.slice(0, at), token: decoded.slice(at + 1) };
}

// ─────────────────────────────── 병합
// 두 기기에서 각자 고쳤을 수 있으니 통째로 덮어쓰지 않는다.
//   거래 : id 기준 합집합에서 삭제 기록(tombstone)을 뺀다
//   설정 : 더 최근에 저장된 쪽을 통째로 쓴다
//   시세 : 종목별로 더 최신 값을 쓴다
export function merge(local, remote) {
  if (!remote) return { ...local };

  const tombstones = new Map();
  for (const t of [...(local.deletedIds || []), ...(remote.deletedIds || [])]) {
    const prev = tombstones.get(t.id);
    if (!prev || t.at > prev) tombstones.set(t.id, t.at);
  }

  const byId = new Map();
  for (const tx of [...(remote.transactions || []), ...(local.transactions || [])]) {
    byId.set(tx.id, tx); // 뒤(로컬)가 이기므로 같은 id 는 이 기기 수정본이 남는다
  }
  for (const [id, at] of tombstones) {
    const tx = byId.get(id);
    // 지운 뒤에 다시 고친 거래라면 살려둔다
    if (tx && !(tx.updatedAt && tx.updatedAt > at)) byId.delete(id);
  }

  const localNewer = (local.updatedAt || '') >= (remote.updatedAt || '');
  const settingsFrom = localNewer ? local : remote;

  const quotes = { ...(remote.quotes || {}) };
  for (const [ticker, q] of Object.entries(local.quotes || {})) {
    const cur = quotes[ticker];
    if (!cur || (q.asOf || '') > (cur.asOf || '')) quotes[ticker] = q;
  }

  const fxNewer = (local.fx?.asOf || '') >= (remote.fx?.asOf || '');
  return {
    ...settingsFrom,
    // API 키는 기기 전용이라 업로드하지 않는다. 병합 때 이 기기 값을 지켜야 한다.
    apiKeys: local.apiKeys || {},
    assets: { ...(remote.assets || {}), ...(local.assets || {}) },
    transactions: [...byId.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
    deletedIds: [...tombstones].map(([id, at]) => ({ id, at })).slice(-200),
    quotes,
    fx: fxNewer ? local.fx : remote.fx,
  };
}
