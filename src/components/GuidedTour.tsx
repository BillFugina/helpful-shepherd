import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { useNavigate } from 'react-router'
import {
  closeTour,
  getTour,
  goToTourStep,
  pickShowcaseContract,
  startTour,
  subscribeTour,
  TOUR_STEPS,
  tourStep,
  type TourPlace,
  type TourStep,
} from '../lib/tour'
import { useTRPC } from '../lib/trpc'

type Trpc = ReturnType<typeof useTRPC>

export function useTour() {
  return useSyncExternalStore(subscribeTour, getTour, getTour)
}

/**
 * The guided tour of the guest demo. Rendered only for the guest. Opens by
 * itself the first time a guest lands in this tab; after that it opens from
 * the "Take the tour" buttons. A small panel in the corner, not a modal: the
 * page underneath stays usable, and Esc or the close button ends the tour.
 */
export function GuidedTour() {
  const tour = useTour()
  useEffect(() => {
    if (tour === null) startTour(0)
  }, [tour])
  if (!tour?.open) return null
  return <TourPanel step={tour.step} />
}

function TourPanel({ step }: { step: number }) {
  const s = tourStep(step)
  const last = step === TOUR_STEPS.length - 1
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const trpc = useTRPC()
  const headingRef = useRef<HTMLHeadingElement>(null)

  // Focus the panel when it opens, so keyboard and screen reader users land in it.
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true })
  }, [])

  // Esc ends the tour, unless something else on the page already used the key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) closeTour()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // Leaves room under the page so the panel never covers its last lines.
  useEffect(() => {
    document.body.classList.add('touring')
    return () => document.body.classList.remove('touring')
  }, [])

  // Go to the stop's page. Only when the step changes: a guest who wanders off
  // mid-tour isn't pulled back until they press Next or Back.
  useEffect(() => {
    let cancelled = false
    void pathFor(s, queryClient, trpc).then((path) => {
      if (!cancelled && path && path !== window.location.pathname) void navigate(path)
    })
    return () => {
      cancelled = true
    }
  }, [s, queryClient, trpc, navigate])

  // Point at the part of the page the stop is about, once it has rendered.
  useEffect(() => (s.target ? pointAt(s.target) : undefined), [s])

  return (
    <aside className="tour-panel" role="dialog" aria-modal="false" aria-labelledby="tour-title">
      <div className="tour-top">
        <span className="muted small">
          Tour · {step + 1} of {TOUR_STEPS.length}
        </span>
        <button type="button" className="link tour-close" aria-label="Close the tour" onClick={closeTour}>
          ×
        </button>
      </div>
      <div aria-live="polite" aria-atomic="true">
        <h2 id="tour-title" ref={headingRef} tabIndex={-1}>
          {s.title}
        </h2>
        <p>{s.body}</p>
      </div>
      <div className="tour-progress" aria-hidden="true">
        {TOUR_STEPS.map((t, i) => (
          <span key={t.id} className={i === step ? 'on' : undefined} />
        ))}
      </div>
      <div className="actions tour-actions">
        {step > 0 ? (
          <button type="button" className="secondary" onClick={() => goToTourStep(step - 1)}>
            Back
          </button>
        ) : (
          <button type="button" className="secondary" onClick={closeTour}>
            Skip
          </button>
        )}
        <button type="button" onClick={() => (last ? closeTour() : goToTourStep(step + 1))}>
          {last ? 'Finish' : 'Next'}
        </button>
      </div>
    </aside>
  )
}

/** The page a stop opens, looking up demo records where it needs one. */
async function pathFor(step: TourStep, queryClient: QueryClient, trpc: Trpc): Promise<string | undefined> {
  if (!step.place) return step.path
  try {
    return (await placePath(step.place, queryClient, trpc)) ?? step.path
  } catch {
    return step.path
  }
}

async function placePath(place: TourPlace, queryClient: QueryClient, trpc: Trpc): Promise<string | null> {
  if (place === 'season') {
    const seasons = await queryClient.fetchQuery(trpc.seasons.list.queryOptions())
    return seasons[0] ? `/seasons/${seasons[0].id}` : null
  }
  const productions = await queryClient.fetchQuery(trpc.productions.list.queryOptions())
  if (place === 'documents') return productions[0] ? `/productions/${productions[0].id}/documents` : null
  // A filled Equity contract shows the most; settle for any contract if there's none.
  let fallback: string | null = null
  for (const p of productions) {
    const data = await queryClient.fetchQuery(trpc.contracts.byProduction.queryOptions({ productionId: p.id }))
    const id = pickShowcaseContract(data.engagements)
    if (!id) continue
    const equity = data.engagements.some((e) =>
      e.contracts.some((c) => c.id === id && c.template.format === 'equity_itc_form'),
    )
    if (equity) return `/contracts/${id}`
    fallback ??= `/contracts/${id}`
  }
  return fallback
}

/**
 * Outlines the element marked data-tour={name} and scrolls it into view,
 * waiting for it if the page is still loading. Returns the cleanup.
 */
function pointAt(name: string): () => void {
  const selector = `[data-tour="${name}"]`
  let marked: Element | null = null
  let scrolled = false
  const mark = () => {
    if (marked?.isConnected) return
    marked?.classList.remove('tour-target')
    marked = document.querySelector(selector)
    if (!marked) return
    marked.classList.add('tour-target')
    if (!scrolled) {
      scrolled = true
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      marked.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' })
    }
  }
  mark()
  // The page may still be loading, or may redraw the element: mark it whenever it (re)appears.
  const observer = new MutationObserver(mark)
  observer.observe(document.body, { childList: true, subtree: true })
  return () => {
    observer.disconnect()
    marked?.classList.remove('tour-target')
  }
}
