import { describe, expect, test } from "bun:test"
import {
  buildBillingHeaderValue,
  computeCch,
  computeVersionSuffix,
  extractFirstUserMessageText,
  type BillingMessage
} from "./signing"

const simpleMessages: BillingMessage[] = [
  { role: "user", content: "hello world" }
]

const complexMessages: BillingMessage[] = [
  {
    role: "user",
    content: [
      { type: "image" },
      { type: "text", text: "hello world" }
    ]
  }
]

describe("signing", () => {
  test("extracts the first user text from string content", () => {
    expect(extractFirstUserMessageText(simpleMessages)).toBe("hello world")
  })

  test("extracts the first user text from block content", () => {
    expect(extractFirstUserMessageText(complexMessages)).toBe("hello world")
  })

  test("computes known cch values", () => {
    expect(computeCch("hello world")).toBe("b94d2")
    expect(computeCch("")).toBe("e3b0c")
  })

  test("computes the known version suffix", () => {
    expect(computeVersionSuffix("hello world", "2.1.90")).toBe("0dc")
  })

  test("builds the billing header string", () => {
    expect(buildBillingHeaderValue(simpleMessages, "2.1.90", "cli")).toBe(
      "x-anthropic-billing-header: cc_version=2.1.90.0dc; cc_entrypoint=cli; cch=b94d2;"
    )
  })
})
