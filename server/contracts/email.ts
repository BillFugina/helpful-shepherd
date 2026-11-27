import { createHash } from 'node:crypto'

/**
 * The email a filled contract goes out with. Plain text, in the Company
 * Manager's name, asking for the signed copy back by reply (there's no
 * e-signature service, so it's marked signed by hand when it comes back).
 */
export function contractEmail(input: {
  firstName: string
  theatre: string
  productionTitle: string
  templateName: string
  /** The agent's name, when they're copied. */
  agentName?: string | null
  senderName: string
}): { subject: string; text: string } {
  const theatre = input.theatre.trim() || 'The theatre'
  const greeting = input.firstName ? `Hi ${input.firstName},` : 'Hi,'
  const agent = input.agentName?.trim()
  const text = [
    greeting,
    '',
    `Your ${input.templateName} for ${input.productionTitle} at ${theatre} is attached.${agent ? ` I’ve copied ${agent}.` : ''}`,
    '',
    'Please look it over, sign it, and send the signed copy back by replying to this email. If anything looks wrong, reply and let me know before you sign.',
    '',
    'Thank you!',
    '',
    input.senderName.trim() || theatre,
    theatre,
  ].join('\n')
  return { subject: `${input.templateName}: ${input.productionTitle}`, text }
}

/** Who a sent contract went to, in words for the contract page. Names only, never addresses. */
export function sentToWords(personName: string, agent: { name: string; agency: string | null } | null): string {
  const words = agent
    ? `${personName} and their agent ${agent.name}${agent.agency?.trim() ? ` (${agent.agency.trim()})` : ''}`
    : personName
  return `${words} by email`.slice(0, 300)
}

/**
 * The same contract to the same people gets the same key, so Resend sends it
 * once even if the app retries after a lost reply. Anything different (a new
 * value, another address) is a new email.
 */
export function contractEmailKey(contractId: string, parts: readonly (string | Uint8Array)[]): string {
  const hash = createHash('sha256')
  for (const p of parts) {
    hash.update(p)
    hash.update('\u0000')
  }
  return `contract/${contractId}/${hash.digest('hex').slice(0, 32)}`
}
