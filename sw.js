/* 上岸工作台 Service Worker —— 离线可用 + 自动更新
 * 策略：导航请求 network-first（保证每次拿到最新页面），
 *       静态资源 cache-first（图标/清单离线缓存）。
 * 改线上 index.html 后，用户下次打开即自动更新。
 */
const CACHE = 'kaogong-pwa-v3';
const CORE = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(CORE).catch(() => {})).catch(() => {})
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // version.json 必须始终走网络：否则版本检测永远拿到缓存里的旧值，
  // 用户收不到「发现新版本」提示，手机端会一直卡在旧版（复盘页空白等 bug 修不了）
  if (url.pathname.endsWith('version.json')) {
    e.respondWith(
      fetch(req)
        .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}); return res; })
        .catch(() => caches.match(req))
    );
    return;
  }

  // 导航请求：network-first，失败回退缓存（离线可用 + 自动更新）
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // 静态资源：cache-first，回退网络并写入缓存
  e.respondWith(
    caches.match(req).then((hit) =>
      hit ||
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => hit)
    )
  );
});
