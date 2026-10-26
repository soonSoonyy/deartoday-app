// Dear, Today 서비스워커 — 앱 셸을 캐시해 설치형 PWA로 동작하게 함.
// API 응답은 절대 캐시하지 않음(항상 최신 데이터를 받아야 하므로).
// 배포로 내용이 바뀌면 CACHE 이름의 버전을 올려 이전 캐시를 정리함.
const CACHE = 'deartoday-v1';
const APP_SHELL = ['/', '/index.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // API는 캐시하지 않고 항상 네트워크로.
  if (url.pathname.startsWith('/api/')) return;

  // 페이지 이동은 네트워크 우선, 실패하면 캐시된 앱 셸로 폴백(오프라인 대비).
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/', copy));
          return res;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  // 그 외 정적 자원은 캐시 우선, 없으면 네트워크에서 받아 캐시에 저장.
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((res) => {
      if (res.ok && url.origin === self.location.origin) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy));
      }
      return res;
    }))
  );
});
