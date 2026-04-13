import { createHash } from "node:crypto"

const BILLING_SALT = "59cf53e54c78"

export interface MessageContentBlock {
  type?: string
  text?: string
}

export interface BillingMessage {
  role?: string
  content?: string | MessageContentBlock[]
}

export function extractFirstUserMessageText(messages: BillingMessage[]): string {
  const userMessage = messages.find((message) => message.role === "user")
  if (!userMessage) return ""

  if (typeof userMessage.content === "string") {
    return userMessage.content
  }

  if (Array.isArray(userMessage.content)) {
    const textBlock = userMessage.content.find((block) => block.type === "text")
    if (textBlock?.text) return textBlock.text
  }

  return ""
}

export function computeCch(messageText: string): string {
  return createHash("sha256").update(messageText).digest("hex").slice(0, 5)
}

export function computeVersionSuffix(messageText: string, version: string): string {
  const sampled = [4, 7, 20]
    .map((index) => (index < messageText.length ? messageText[index] : "0"))
    .join("")
  return createHash("sha256")
    .update(`${BILLING_SALT}${sampled}${version}`)
    .digest("hex")
    .slice(0, 3)
}

export function buildBillingHeaderValue(
  messages: BillingMessage[],
  version: string,
  entrypoint: string
): string {
  const messageText = extractFirstUserMessageText(messages)
  const suffix = computeVersionSuffix(messageText, version)
  const cch = computeCch(messageText)

  return (
    "x-anthropic-billing-header: " +
    `cc_version=${version}.${suffix}; ` +
    `cc_entrypoint=${entrypoint}; ` +
    `cch=${cch};`
  )
}
