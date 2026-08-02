// Service Worker для Qazaq Tili.
// Версия кэша здесь НЕ прописывается вручную — она вычисляется автоматически
// из содержимого index.html (простой хэш). Значит: меняешь index.html →
// заливаешь на GitHub → пользователи автоматически получают новую версию
// при следующем заходе. Трогать этот файл руками не нужно.

const CACHE_PREFIX = 'qazaq-tili-';

// Простой быстрый хэш строки (не криптографический, но для наших целей достаточно —
// нужно только отличить "файл изменился" от "файл не изменился").
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

// Установка: скачиваем index.html, считаем его хэш и кэшируем под именем,
// которое зависит от этого хэша.
self.addEventListener('install', (event) => {
  event.waitUntil(
    fetch('./index.html', { cache: 'no-store' })
      .then((response) => response.text())
      .then((html) => {
        const version = simpleHash(html);
        const cacheName = CACHE_PREFIX + version;
        return caches.open(cacheName).then((cache) => {
          // Кладём уже скачанный текст напрямую, чтобы не качать index.html дважды.
          return cache.put(
            './index.html',
            new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
          );
        });
      })
  );
  self.skipWaiting();
});

// Активация: удаляем все кэши с другим хэшем (старые версии index.html).
self.addEventListener('activate', (event) => {
  event.waitUntil(
    fetch('./index.html', { cache: 'no-store' })
      .then((response) => response.text())
      .then((html) => {
        const currentVersion = CACHE_PREFIX + simpleHash(html);
        return caches.keys().then((keys) =>
          Promise.all(
            keys
              .filter((key) => key.startsWith(CACHE_PREFIX) && key !== currentVersion)
              .map((key) => caches.delete(key))
          )
        );
      })
      .catch(() => {}) // если сети нет прямо в момент активации — просто не чистим, не критично
  );
  self.clients.claim();
});

// Запросы: "network first, fallback to cache" — если есть интернет, всегда
// пробуем получить свежую версию (и обновляем кэш под её собственным хэшем);
// если сети нет — отдаём то, что есть в любом из наших кэшей.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Внешние API (Wiktionary, Glosbe, MyMemory, OpenRouter) не трогаем —
  // у них не может быть офлайн-режима по своей природе.
  if (url.origin !== self.location.origin) return;
  if (req.method !== 'GET') return;

  event.respondWith(
    fetch(req)
      .then(async (networkResponse) => {
        // Файл получен из сети — пересчитываем его хэш и кладём в свежий кэш.
        const clone = networkResponse.clone();
        const text = await clone.text();
        const version = CACHE_PREFIX + simpleHash(text);
        const cache = await caches.open(version);
        await cache.put(req, new Response(text, { headers: clone.headers }));
        return networkResponse;
      })
      .catch(async () => {
        // Сети нет — ищем этот запрос в ЛЮБОМ из наших кэшей (последняя
        // успешно закэшированная версия), не важно под каким хэшем он лежит.
        const keys = await caches.keys();
        for (const key of keys) {
          if (!key.startsWith(CACHE_PREFIX)) continue;
          const cache = await caches.open(key);
          const match = await cache.match(req) || await cache.match('./index.html');
          if (match) return match;
        }
        return new Response('Офлайн: страница ещё не была закэширована.', { status: 503 });
      })
  );
});
