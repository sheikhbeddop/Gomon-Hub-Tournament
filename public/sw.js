// Service Worker for GOMON HUB TOURNAMENT (PWA Offline & Push Engine)

const CACHE_NAME = 'gomon-hub-v5.5';
const PRECACHE_ASSETS = [
    '/',
    '/static/css/style.css?v=5.4.1',
    '/static/css/auth-components.css?v=5.4.1',
    '/static/js/app.js?v=5.4.2',
    '/manifest.json',
    '/favicon.ico',
    '/gomon_hub_logo.png'
];

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(PRECACHE_ASSETS).catch((err) => {
                console.warn('[SW Precache Notice]', err);
            });
        })
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((name) => {
                    if (name !== CACHE_NAME) {
                        return caches.delete(name);
                    }
                })
            );
        }).then(() => clients.claim())
    );
});

self.addEventListener('message', (event) => {
    if (event.data && event.data.action === 'skipWaiting') {
        self.skipWaiting();
    }
});

// Fetch Handler: Stale-While-Revalidate for Static Assets, Network-First for Pages & API
self.addEventListener('fetch', (event) => {
    // Only intercept GET requests
    if (event.request.method !== 'GET') {
        return;
    }

    const url = new URL(event.request.url);

    // Bypass API calls, websockets, and non-http schemes
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws') || !url.protocol.startsWith('http')) {
        return;
    }

    const isStaticAsset = url.pathname.startsWith('/static/') || 
        url.pathname.endsWith('.css') || 
        url.pathname.endsWith('.js') || 
        url.pathname.endsWith('.png') || 
        url.pathname.endsWith('.jpg') || 
        url.pathname.endsWith('.ico') || 
        url.pathname.endsWith('.svg');

    // 1. Static Assets: Instant Cache-First with Background Revalidation (Zero-Lag UI)
    if (isStaticAsset) {
        event.respondWith(
            caches.match(event.request).then((cachedResponse) => {
                const networkFetch = fetch(event.request).then((networkResponse) => {
                    if (networkResponse && networkResponse.status === 200) {
                        const clone = networkResponse.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                    }
                    return networkResponse;
                }).catch(() => cachedResponse);

                return cachedResponse || networkFetch;
            })
        );
        return;
    }

    // 2. Navigation / HTML pages: Network-first with offline fallback
    event.respondWith(
        fetch(event.request)
            .then((networkResponse) => {
                if (networkResponse && networkResponse.status === 200) {
                    const responseClone = networkResponse.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, responseClone);
                    });
                }
                return networkResponse;
            })
            .catch(async () => {
                const cached = await caches.match(event.request);
                if (cached) return cached;
                if (event.request.mode === 'navigate') {
                    const rootCached = await caches.match('/');
                    if (rootCached) return rootCached;
                }
                return new Response('Offline: Network connection unavailable', {
                    status: 503,
                    statusText: 'Service Unavailable',
                    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
                });
            })
    );
});

self.addEventListener('push', (event) => {
    let data = {
        title: 'GOMON HUB TOURNAMENT Alert!',
        body: 'Room ID and Password are now available!',
        icon: '/gomon_hub_logo.png',
        badge: '/gomon_hub_logo.png',
        url: '/'
    };

    if (event.data) {
        try {
            data = event.data.json();
        } catch (e) {
            data.body = event.data.text();
        }
    }

    const options = {
        body: data.body,
        icon: data.icon || '/gomon_hub_logo.png',
        badge: data.badge || '/gomon_hub_logo.png',
        vibrate: [200, 100, 200, 100, 200],
        data: {
            url: data.url || '/'
        },
        actions: [
            { action: 'open', title: '🎮 ওপেন করুন' }
        ]
    };

    event.waitUntil(
        self.registration.showNotification(data.title, options)
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const targetUrl = event.notification.data ? event.notification.data.url : '/';

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            for (const client of clientList) {
                if (client.url === targetUrl && 'focus' in client) {
                    return client.focus();
                }
            }
            if (clients.openWindow) {
                return clients.openWindow(targetUrl);
            }
        })
    );
});
