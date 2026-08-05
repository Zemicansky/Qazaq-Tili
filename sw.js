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
// ДОБАВЛЕНО: после активации новой версии сообщаем всем открытым вкладкам
// об этом (postMessage). Раньше страница никак не узнавала, что вышла новая
// версия, и пользователь либо продолжал видеть старую закэшированную копию,
// либо (если замечал, что что-то не так) вручную чистил "данные сайта" в
// браузере — а это стирает заодно и localStorage (стрики/прогресс/бэкапы),
// хотя кэш Service Worker и localStorage физически никак не связаны и чистить
// их вместе не требовалось. Теперь достаточно обычной перезагрузки страницы —
// см. обработчик 'controllerchange' и SW_UPDATE_MSG в index.html.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    fetch('./index.html', { cache: 'no-store' })
      .then((response) => response.text())
      .then((html) => {
        const currentVersion = CACHE_PREFIX + simpleHash(html);
        // ВАЖНО: не удалять CACHE_PREFIX+'assets' — это отдельный, постоянный
        // кэш для бинарных файлов (см. isTextLikeResponse в обработчике fetch
        // ниже), а не версия index.html по хэшу. Он не должен чиститься при
        // каждом обновлении текста страницы, иначе бинарные ассеты (если
        // появятся) заново перекачивались бы из сети при каждом деплое.
        const assetsCache = CACHE_PREFIX + 'assets';
        return caches.keys().then((keys) =>
          Promise.all(
            keys
              .filter((key) => key.startsWith(CACHE_PREFIX) && key !== currentVersion && key !== assetsCache)
              .map((key) => caches.delete(key))
          )
        );
      })
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then((clients) => {
        clients.forEach((client) => client.postMessage({ type: 'SW_UPDATED' }));
      })
      .catch(() => {}) // если сети нет прямо в момент активации — просто не чистим, не критично
  );
  self.clients.claim();
});

// Запросы: "network first, fallback to cache" — если есть интернет, всегда
// пробуем получить свежую версию (и обновляем кэш под её собственным хэшем);
// если сети нет — отдаём то, что есть в любом из наших кэшей.
//
// БАГФИКС (на будущее, сейчас не проявляется): раньше тело ЛЮБОГО ответа со
// своего домена читалось через .text() и пересохранялось как текстовая
// Response — нормально для index.html (это HTML-текст), но для бинарных
// файлов (картинки, шрифты, отдельные .js/.json не в UTF-8 и т.п.) чтение
// как текста необратимо портит байты при повторной сборке через new
// Response(text,...). Сейчас весь сайт — один index.html, поэтому баг не
// проявлялся, но если в будущем появятся отдельные ассеты (например, при
// разделении файла на index.html + data.js + картинки), они начали бы
// кэшироваться битыми. Теперь тип определяется по Content-Type ответа:
// текстовые/HTML/JS/JSON-подобные файлы по-прежнему хэшируются как текст
// (чтобы hash-версионирование продолжало работать так же, как раньше), а
// всё остальное (картинки, шрифты, PDF и т.п.) кэшируется как есть, побайтово,
// через arrayBuffer — без риска повреждения.
function isTextLikeResponse(response) {
  const type = (response.headers.get('content-type') || '').toLowerCase();
  return (
    type.includes('text/') ||
    type.includes('javascript') ||
    type.includes('json') ||
    type.includes('xml') ||
    type.includes('svg')
  );
}

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
        const clone = networkResponse.clone();
        if (isTextLikeResponse(networkResponse)) {
          // Текстовый файл — пересчитываем хэш от содержимого и кладём в
          // свежий кэш под версией, зависящей от этого хэша (как раньше).
          const text = await clone.text();
          const version = CACHE_PREFIX + simpleHash(text);
          const cache = await caches.open(version);
          await cache.put(req, new Response(text, { headers: clone.headers }));
        } else {
          // Бинарный файл — сохраняем побайтово, без прогона через текстовый
          // хэш (версионирование сайта в целом всё равно зависит от хэша
          // index.html, см. install/activate выше).
          const buffer = await clone.arrayBuffer();
          const cache = await caches.open(CACHE_PREFIX + 'assets');
          await cache.put(req, new Response(buffer, { headers: clone.headers }));
        }
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
