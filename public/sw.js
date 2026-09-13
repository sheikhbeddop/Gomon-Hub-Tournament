// Service Worker for GOMON HUB TOURNAMENT (PWA Offline & Push Engine)

const CACHE_NAME = 'gomon-hub-v5.3';
const PRECACHE_ASSETS = [
    '/',
    '/static/css/style.css',
    '/static/css/auth-components.css',
    '/static/js/app.js',
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

// Fetch Handler: Network-first with dynamic cache update & offline fallback
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

    event.respondWith(
        fetch(event.request)
            .then((networkResponse) => {
                // If valid response, clone into cache
                if (networkResponse && networkResponse.status === 200) {
                    const responseClone = networkResponse.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, responseClone);
                    });
                }
                return networkResponse;
            })
            .catch(async () => {
                // Network failed: attempt to serve from cache
                const cached = await caches.match(event.request);
                if (cached) {
                    return cached;
                }
                // If navigating to a page, serve cached root
                if (event.request.mode === 'navigate') {
                    const rootCached = await caches.match('/');
                    if (rootCached) {
                        return rootCached;
                    }
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
