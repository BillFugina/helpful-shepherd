import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import {
  ACCESS_LEVELS,
  ADMIN_ROLE,
  CONFIRM_TO_GRANT,
  FIELD_GROUP_LABELS,
  FIELD_GROUPS,
  levelFor,
  ROLE_LABELS,
  ROLES,
  type AccessLevel,
  type FieldGroup,
  type Role,
} from '../../shared/access'
import { errorText } from '../lib/errors'
import { useTRPC } from '../lib/trpc'

const LEVEL_LABELS: Record<AccessLevel, string> = { none: 'None', view: 'View', review: 'Review', edit: 'Edit' }

/** The Company Manager's grant matrix. Anything not granted is denied. */
export function AccessPage() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const matrix = useQuery(trpc.access.matrix.queryOptions())
  const [error, setError] = useState<string | null>(null)
  const setGrant = useMutation(
    trpc.access.setGrant.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.access.matrix.queryKey() }),
      onError: (e) => setError(errorText(e)),
    }),
  )

  function change(role: Role, fieldGroup: FieldGroup, level: AccessLevel) {
    setError(null)
    let confirmSensitive = false
    if (CONFIRM_TO_GRANT.has(fieldGroup) && level !== 'none') {
      confirmSensitive = window.confirm(
        `${FIELD_GROUP_LABELS[fieldGroup]} holds the most sensitive data. Give ${ROLE_LABELS[role]} "${LEVEL_LABELS[level]}" access?`,
      )
      if (!confirmSensitive) return
    }
    setGrant.mutate({ role, fieldGroup, level, confirmSensitive })
  }

  if (matrix.isPending) return <p className="muted">Loading…</p>
  if (matrix.error) return <p className="error">{errorText(matrix.error)}</p>

  return (
    <section>
      <h1>Access by role</h1>
      <p className="muted">
        Every field belongs to a group. A role sees a group only if it's granted here. Changes are logged. The Company
        Manager's own access is fixed so nobody gets locked out.
      </p>
      {error ? <p className="error">{error}</p> : null}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Field group</th>
              {ROLES.map((r) => (
                <th key={r}>{ROLE_LABELS[r]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {FIELD_GROUPS.map((g) => (
              <tr key={g}>
                <td>{FIELD_GROUP_LABELS[g]}</td>
                {ROLES.map((r) => (
                  <td key={r}>
                    <select
                      aria-label={`${ROLE_LABELS[r]}: ${FIELD_GROUP_LABELS[g]}`}
                      value={levelFor(matrix.data[r], g)}
                      disabled={r === ADMIN_ROLE || setGrant.isPending}
                      onChange={(e) => change(r, g, e.target.value as AccessLevel)}
                    >
                      {ACCESS_LEVELS.map((l) => (
                        <option key={l} value={l}>
                          {LEVEL_LABELS[l]}
                        </option>
                      ))}
                    </select>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
