// sw.js — minimal offline-first-ish service worker.
// Strategy:
//   - On install: precache the shell (index, manifest, icons, offline page).
//   - On fetch: network-first for navigations; cache-fallback on failure; a
//     final /offline.html fallback for navigations when nothing is cached.
//   - On activate: drop any cache whose name doesn't match the current CACHE.
// Bump CACHE_VERSION on each deploy that changes static assets.

'use strict';

const CACHE_VERSION = 'v1-2026-04-23';
const CACHE_NAME = `comms-${CACHE_VERSION}`;

const PRECACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.svg',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/offline.html',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(
      names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Never cache the API — it's all dynamic and auth-scoped.
  if (url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match(req).then((r) => r || caches.match('/offline.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      if (res && res.status === 200 && res.type === 'basic') {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(req, clone));
      }
      return res;
    }).catch(() => cached))
  );
});
