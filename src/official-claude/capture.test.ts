import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  buildRedactedOfficialClaudeCapture,
  finalizeOfficialClaudeCapture,
  getOfficialClaudeCapturePaths,
  readOfficialClaudeRedactedCapture,
  writeOfficialClaudeRawCapture
} from "./capture"

describe("official claude capture", () => {
  test("uses /captures when it exists and otherwise falls back to the workspace captures directory", () => {
    const dockerPaths = getOfficialClaudeCapturePaths(
      "/app",
      {},
      ((path: string) => path === "/captures") as typeof import("node:fs").existsSync
    )
    expect(dockerPaths.rawPath).toBe("/captures/official-claude/latest-raw.json")
    expect(dockerPaths.redactedPath).toBe("/captures/official-claude/latest-redacted.json")

    const localPaths = getOfficialClaudeCapturePaths(
      "/workspace",
      {},
      (() => false) as typeof import("node:fs").existsSync
    )
    expect(localPaths.rawPath).toBe(join("/workspace", "captures", "official-claude", "latest-raw.json"))
    expect(localPaths.redactedPath).toBe(join("/workspace", "captures", "official-claude", "latest-redacted.json"))
  })

  test("redacts prompt text and sensitive headers while preserving official request identity", () => {
    const redacted = buildRedactedOfficialClaudeCapture({
      schemaVersion: 1,
      capturedAt: "2026-04-13T00:00:00.000Z",
      runtime: {
        transport: "fetch",
        binaryPath: "/usr/bin/claude",
        argv: ["-p", "hello"],
        runId: "run-123"
      },
      request: {
        url: "https://api.anthropic.com/v1/messages",
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          "user-agent": "claude-cli/2.1.104 (external, cli)",
          "anthropic-beta": "claude-code-20250219"
        },
        body: JSON.stringify({
          model: "claude-opus-4-6",
          system: "Stay helpful",
          messages: [{ role: "user", content: "hello world" }],
          tools: [{ name: "bash", description: "Run bash", input_schema: { type: "object", required: ["command"] } }]
        })
      },
      response: {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      }
    })

    expect(redacted.request.headers.authorization).toBe("[redacted-header-1]")
    expect(redacted.request.headers["user-agent"]).toBe("claude-cli/2.1.104 (external, cli)")
    expect(JSON.stringify(redacted.request.body)).not.toContain("hello world")
    expect(JSON.stringify(redacted.request.body)).not.toContain("Stay helpful")
    expect(JSON.stringify(redacted.request.body)).toContain("claude-opus-4-6")
    expect(JSON.stringify(redacted.request.body)).toContain("\"name\":\"bash\"")
  })

  test("finalizes the current raw capture into a redacted copy and validates the run id", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "official-claude-capture-"))
    const rawPath = join(tempDir, "latest-raw.json")
    const redactedPath = join(tempDir, "latest-redacted.json")

    await writeOfficialClaudeRawCapture(rawPath, {
      schemaVersion: 1,
      capturedAt: "2026-04-13T00:00:00.000Z",
      runtime: {
        transport: "fetch",
        runId: "run-123"
      },
      request: {
        url: "https://api.anthropic.com/v1/messages",
        method: "POST",
        headers: {
          authorization: "Bearer secret"
        },
        body: JSON.stringify({
          model: "claude-opus-4-6",
          messages: [{ role: "user", content: "hello world" }]
        })
      }
    })

    const redacted = await finalizeOfficialClaudeCapture(rawPath, redactedPath, "run-123")

    expect(redacted.request.headers.authorization).toBe("[redacted-header-1]")
    expect(JSON.stringify(redacted.request.body)).not.toContain("hello world")
    await expect(finalizeOfficialClaudeCapture(rawPath, redactedPath, "other-run")).rejects.toThrow(
      "does not belong to the current run"
    )
  })

  test("reads an already-redacted capture without degrading the request body", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "official-claude-redacted-"))
    const redactedPath = join(tempDir, "latest-redacted.json")

    await Bun.write(redactedPath, JSON.stringify({
      schemaVersion: 1,
      capturedAt: "2026-04-13T00:00:00.000Z",
      runtime: {
        transport: "fetch",
        runId: "run-123"
      },
      request: {
        url: "https://api.anthropic.com/v1/messages",
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          "user-agent": "claude-cli/2.1.104 (external, cli)"
        },
        body: {
          model: "claude-opus-4-6",
          messages: [{ role: "user", content: [{ type: "text", text: "[redacted-user-1]" }] }]
        }
      }
    }, null, 2))

    const capture = await readOfficialClaudeRedactedCapture(redactedPath)

    expect(capture.request.headers.authorization).toBe("[redacted-header-1]")
    expect((capture.request.body as Record<string, unknown>).model).toBe("claude-opus-4-6")
    expect(JSON.stringify(capture.request.body)).toContain("[redacted-user-1]")
  })
})
