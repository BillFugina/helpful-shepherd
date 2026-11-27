// web-push 4 ships no types. Only what server/push/send.ts uses.
declare module 'web-push' {
  export interface PushSubscriptionTarget {
    endpoint: string
    keys: { p256dh: string; auth: string }
  }
  export interface VapidDetails {
    subject: string
    publicKey: string
    privateKey: string
  }
  export interface RequestOptions {
    vapidDetails?: VapidDetails
    TTL?: number
    urgency?: 'very-low' | 'low' | 'normal' | 'high'
    topic?: string
    timeout?: number
  }
  export interface SendResult {
    statusCode: number
    body: string
    headers: Record<string, string | string[] | undefined>
  }
  export class WebPushError extends Error {
    statusCode: number
    body: string
    endpoint: string
  }
  export function sendNotification(
    subscription: PushSubscriptionTarget,
    payload?: string | Buffer | null,
    options?: RequestOptions,
  ): Promise<SendResult>
  export function generateVAPIDKeys(): { publicKey: string; privateKey: string }
}
