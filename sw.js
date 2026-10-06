// Service Worker for GOMON HUB TOURNAMENT (PWA Offline & Push Engine)

const CACHE_NAME = 'gomon-hub-v9.3';
const PRECACHE_ASSETS = [
    '/',
    '/static/css/style.css?v=5.5.7',
    '/static/css/auth-components.css?v=5.4.3',
    '/static/js/app.js?v=5.7.1',
    '/manifest.json',
    '/favicon.ico',
    '/gomon_hub_logo.png',
    '/gomon_hub_logo.png?v=3'
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

// Fetch Handler: Network-First for Navigation/HTML, Cache-First for Static Assets, Network-Only for APIs & WebSockets
self.addEventListener('fetch', (event) => {
    // Only intercept GET requests
    if (event.request.method !== 'GET') {
        return;
    }

    const url = new URL(event.request.url);

    // Bypass API calls, websockets, pingers, and non-http schemes directly to the live server
    if (url.pathname.startsWith('/api/') || 
        url.pathname.startsWith('/ws') || 
        url.pathname === '/ping' ||
        !url.protocol.startsWith('http')) {
        return;
    }

    // 1. Navigation / HTML pages (e.g., '/', '/index.html'): Network-First with Cache Fallback
    if (event.request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html')) {
        event.respondWith(
            fetch(event.request).then((networkResponse) => {
                if (networkResponse && networkResponse.status === 200) {
                    const clone = networkResponse.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put('/', clone));
                }
                return networkResponse;
            }).catch(() => {
                return caches.match('/').then((cached) => {
                    if (cached) {
                        return cached;
                    }
                    return new Response('Offline: Network connection unavailable', {
                        status: 503,
                        statusText: 'Service Unavailable',
                        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
                    });
                });
            })
        );
        return;
    }

    // 2. Static Assets (CSS, JS, Images, Icons, Fonts, Manifest): Cache-First with Network Fetch
    const isStaticAsset = url.pathname.startsWith('/static/') || 
        url.pathname.endsWith('.css') || 
        url.pathname.endsWith('.js') || 
        url.pathname.endsWith('.png') || 
        url.pathname.endsWith('.jpg') || 
        url.pathname.endsWith('.jpeg') || 
        url.pathname.endsWith('.webp') || 
        url.pathname.endsWith('.ico') || 
        url.pathname.endsWith('.svg') || 
        url.pathname.endsWith('.woff2') || 
        url.pathname === '/manifest.json' || 
        url.pathname === '/favicon.ico';

    if (isStaticAsset) {
        event.respondWith(
            caches.match(event.request).then((cached) => {
                if (cached) {
                    return cached;
                }
                return fetch(event.request).then((networkResponse) => {
                    if (networkResponse && networkResponse.status === 200) {
                        const clone = networkResponse.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                    }
                    return networkResponse;
                });
            })
        );
        return;
    }
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
