// Phone alerts for the theatre app. The browser keeps this script registered
// after a visit and wakes it when a push arrives, even with the app closed.
// It only shows alerts and opens the app; it caches nothing.

const FALLBACK_TITLE = 'Theatre Raleigh'

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

/** A same-origin URL from the message, or the Arrivals board. */
function pageFor(navigate) {
  try {
    const url = new URL(navigate, self.location.origin)
    if (url.origin === self.location.origin) return url.href
  } catch {
    // fall through
  }
  return new URL('/arrivals', self.location.origin).href
}

// The server sends the Declarative Web Push shape:
// { web_push: 8030, notification: { title, body, navigate, ... } }.
// Newer Safari can show it without this script; everywhere else this does.
self.addEventListener('push', (event) => {
  let message
  try {
    message = event.data ? event.data.json() : {}
  } catch {
    message = {}
  }
  const n = (message && message.notification) || {}
  const title = typeof n.title === 'string' && n.title ? n.title : FALLBACK_TITLE
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof n.body === 'string' ? n.body : '',
      icon: '/icon-192.png',
      lang: 'en-US',
      data: { url: pageFor(n.navigate) },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = pageFor(event.notification.data && event.notification.data.url)
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue
        await client.focus()
        if ('navigate' in client) await client.navigate(url)
        return
      }
      await self.clients.openWindow(url)
    })(),
  )
})

// The push service replaced this device's address. Subscribe again with the
// same settings; the app sends the new address to the server next time it opens.
self.addEventListener('pushsubscriptionchange', (event) => {
  const options = event.oldSubscription && event.oldSubscription.options
  if (!options) return
  event.waitUntil(self.registration.pushManager.subscribe(options).catch(() => undefined))
})
