// Phone alerts in the browser: the service worker, this device's push
// subscription, and what the settings page needs to know about the device.

const ENDPOINT_KEY = 'push-endpoint'

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  )
}

/** iPhone or iPad, including an iPad that says it's a Mac. */
export function isIos(): boolean {
  const ua = navigator.userAgent
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
}

/** Opened from the Home Screen (or installed), not in a browser tab. */
export function isInstalled(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

/** A name for the device list. Worked out here, never sent anywhere else. */
export function deviceLabel(): string {
  const ua = navigator.userAgent
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad'
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet'
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'browser'
  const os = /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Computer'
  return `${os} (${browser})`
}

/** Registers public/sw.js once per page load. Quietly does nothing where it can't. */
export function registerServiceWorker(): void {
  if (!pushSupported()) return
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined)
}

/** This device's push subscription, if it has one. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null
  const reg = await navigator.serviceWorker.getRegistration('/')
  return (await reg?.pushManager.getSubscription()) ?? null
}

/** The VAPID public key as the bytes subscribe() wants. */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(padded)
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

function sameKey(a: ArrayBuffer | null, b: Uint8Array): boolean {
  if (!a) return false
  const x = new Uint8Array(a)
  return x.length === b.length && x.every((v, i) => v === b[i])
}

export interface SubscriptionInput {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

export function toInput(sub: PushSubscription): SubscriptionInput {
  const json = sub.toJSON()
  return { endpoint: sub.endpoint, keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' } }
}

/**
 * Asks to show notifications, then subscribes this device. Must be called
 * straight from a tap: iPhone only asks when the request comes from one.
 */
export async function subscribeDevice(publicKey: string): Promise<SubscriptionInput> {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    throw new Error(
      permission === 'denied'
        ? 'Notifications are blocked for this app. Turn them on in your device or browser settings, then try again.'
        : 'Notifications weren’t allowed, so alerts stay off.',
    )
  }
  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
  await navigator.serviceWorker.ready
  const key = keyBytes(publicKey)
  let existing = await reg.pushManager.getSubscription()
  if (existing && !sameKey(existing.options.applicationServerKey, key)) {
    // Made with keys this server no longer uses: pushes to it would be refused.
    await existing.unsubscribe()
    existing = null
  }
  const sub = existing ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }))
  return toInput(sub)
}

/** The address this device last told the server about, to spot a changed one. */
export function savedEndpoint(): string | null {
  try {
    return localStorage.getItem(ENDPOINT_KEY)
  } catch {
    return null
  }
}

export function saveEndpoint(endpoint: string | null): void {
  try {
    if (endpoint) localStorage.setItem(ENDPOINT_KEY, endpoint)
    else localStorage.removeItem(ENDPOINT_KEY)
  } catch {
    // Private mode or storage blocked: the next visit just can't spot a change.
  }
}
