// 서비스워커 - 앱 껍데기를 캐시해서 비행기 모드에서도 켜지게 한다.
// 데이터(거래·설정)는 localStorage/IndexedDB 에 있으므로 여기서는 다루지 않는다.

const VERSION = 'v22';
const CACHE = `portfolio-shell-${VERSION}`;
const SHELL = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/store.js',
  './js/engine.js',
  './js/rules.js',
  './js/quotes.js',
  './js/ui.js',
  './js/util.js',
  './js/tickers.js',
  './js/sync.js',
  './js/xlsx.js',
  './js/cloud.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-maskable-512.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()), // 일부 파일이 없어도 설치는 계속
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // 시세 API 와 로컬 서버 API 는 절대 캐시하지 않는다 (오래된 가격이 남으면 안 됨)
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // 앱 껍데기는 network-first: 새 버전이 있으면 바로 받고, 없으면 캐시로 동작
  e.respondWith(
    fetch(request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(request).then((hit) => hit
        || caches.match('./index.html'))),
  );
});
