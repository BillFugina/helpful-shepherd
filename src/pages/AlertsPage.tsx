import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { errorText } from '../lib/errors'
import {
  currentSubscription,
  deviceLabel,
  isInstalled,
  isIos,
  pushSupported,
  saveEndpoint,
  subscribeDevice,
} from '../lib/push'
import { useTRPC } from '../lib/trpc'

/**
 * Phone alerts for flight changes: turn them on or off for this device, send
 * a test, and see every device this login has them on.
 */
export function AlertsPage() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  // This device's push address, once the browser says (null: none yet).
  const [endpoint, setEndpoint] = useState<string | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // iPhone and iPad only offer web alerts to an app opened from the Home Screen.
  const needsInstall = isIos() && !isInstalled()
  const supported = !needsInstall && pushSupported()

  useEffect(() => {
    let live = true
    currentSubscription()
      .then((s) => live && setEndpoint(s?.endpoint ?? null))
      .catch(() => live && setEndpoint(null))
    return () => {
      live = false
    }
  }, [])

  const status = useQuery({
    ...trpc.push.status.queryOptions({ endpoint: endpoint ?? undefined }),
    enabled: endpoint !== undefined,
  })
  const refetch = () => queryClient.invalidateQueries({ queryKey: trpc.push.status.queryKey() })
  const subscribe = useMutation(trpc.push.subscribe.mutationOptions())
  const unsubscribe = useMutation(trpc.push.unsubscribe.mutationOptions())
  const remove = useMutation(trpc.push.remove.mutationOptions({ onSuccess: refetch }))
  const test = useMutation(trpc.push.test.mutationOptions())

  const s = status.data
  const thisDeviceOn = !!s?.devices.some((d) => d.thisDevice)

  async function turnOn() {
    if (!s?.publicKey) return
    setError(null)
    setBusy(true)
    try {
      // Straight from the tap: iPhone only shows the permission prompt then.
      const sub = await subscribeDevice(s.publicKey)
      await subscribe.mutateAsync({ ...sub, deviceLabel: deviceLabel() })
      saveEndpoint(sub.endpoint)
      setEndpoint(sub.endpoint)
      await refetch()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function turnOff() {
    setError(null)
    setBusy(true)
    try {
      const sub = await currentSubscription()
      if (sub) {
        await unsubscribe.mutateAsync({ endpoint: sub.endpoint })
        await sub.unsubscribe()
      }
      saveEndpoint(null)
      setEndpoint(null)
      await refetch()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <h1>Phone alerts</h1>
      <p className="muted">
        Get a notification when a company member's flight is delayed, changes gate, is cancelled or lands, as well as
        the email. Alerts say who, which flight and what changed, nothing more.
      </p>

      {!supported ? (
        needsInstall ? (
          <div className="card">
            <strong>On iPhone, add the app to your Home Screen first</strong>
            <ol>
              <li>In Safari, tap the Share button.</li>
              <li>Tap Add to Home Screen, then Add.</li>
              <li>Open Theatre Raleigh from the new icon and sign in.</li>
              <li>Come back to this page and turn alerts on.</li>
            </ol>
            <p className="muted small">
              iPhone only allows web alerts for apps on the Home Screen (iOS 16.4 or later).
            </p>
          </div>
        ) : (
          <p className="warning">This browser can't show phone alerts. Try Chrome, Edge, Firefox or Safari.</p>
        )
      ) : status.isPending ? (
        <p className="muted">Loading…</p>
      ) : status.error ? (
        <p className="error">{errorText(status.error)}</p>
      ) : (
        <>
          {s!.reason ? <p className="warning">{s!.reason}</p> : null}
          {s!.held ? <p className="warning">{s!.held}</p> : null}
          {s!.canTurnOn ? (
            <div className="card">
              <strong>This device: {thisDeviceOn ? 'alerts on' : 'alerts off'}</strong>
              <div className="actions">
                {thisDeviceOn ? (
                  <>
                    <button type="button" disabled={busy || test.isPending} onClick={() => test.mutate()}>
                      Send a test alert
                    </button>
                    <button type="button" className="secondary" disabled={busy} onClick={turnOff}>
                      Turn off on this device
                    </button>
                  </>
                ) : (
                  <button type="button" disabled={busy} onClick={turnOn}>
                    Turn on alerts on this device
                  </button>
                )}
              </div>
              {test.data ? (
                <p className="muted small">
                  {test.data.sent
                    ? `Sent to ${test.data.sent} ${test.data.sent === 1 ? 'device' : 'devices'}.`
                    : test.data.held
                      ? 'Held: nothing was sent (see above).'
                      : 'Nothing was sent. Try turning alerts off and on again.'}
                  {test.data.removed ? ` Removed ${test.data.removed} that no longer accept alerts.` : ''}
                </p>
              ) : null}
              {test.error ? <p className="error">{errorText(test.error)}</p> : null}
            </div>
          ) : null}
          {error ? <p className="error">{error}</p> : null}

          <h2>Devices with alerts on</h2>
          {s!.devices.length === 0 ? (
            <p className="muted">None yet.</p>
          ) : (
            <ul className="stack">
              {s!.devices.map((d) => (
                <li key={d.id} className="card row">
                  <div>
                    <strong>
                      {d.deviceLabel}
                      {d.thisDevice ? ' (this device)' : ''}
                    </strong>
                    <div className="muted small">
                      Turned on {new Date(d.createdAt).toLocaleDateString('en-US')}
                      {d.lastSentAt ? `, last alert ${new Date(d.lastSentAt).toLocaleString('en-US')}` : ''}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="secondary"
                    disabled={remove.isPending || busy}
                    onClick={() => (d.thisDevice ? turnOff() : remove.mutate({ id: d.id }))}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          {remove.error ? <p className="error">{errorText(remove.error)}</p> : null}
        </>
      )}
    </section>
  )
}
