import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { config } from "./model-config"
import { resolveClaudeCodeMetadata } from "./version"

function createExecFileSyncMock(
  responses: Record<string, string | Error>
): typeof import("node:child_process").execFileSync {
  return ((file: string, args?: readonly string[]) => {
    const key = `${file} ${(args ?? []).join(" ")}`
    const response = responses[key]
    if (response instanceof Error) {
      throw response
    }
    if (typeof response === "string") {
      return response
    }
    throw new Error(`Unexpected command: ${key}`)
  }) as unknown as typeof import("node:child_process").execFileSync
}

describe("version resolution", () => {
  test("prefers CLAUDE_PROXY_CLAUDE_CODE_VERSION when set", () => {
    const metadata = resolveClaudeCodeMetadata({
      env: {
        CLAUDE_PROXY_CLAUDE_CODE_VERSION: "7.7.7"
      },
      execFileSyncImpl: createExecFileSyncMock({
        "which claude": new Error("not found"),
        "claude --version": new Error("not found"),
        "npm root -g": new Error("not found")
      })
    })

    expect(metadata.version).toBe("7.7.7")
    expect(metadata.source).toBe("env:CLAUDE_PROXY_CLAUDE_CODE_VERSION")
  })

  test("uses claude --version when available", () => {
    const metadata = resolveClaudeCodeMetadata({
      platform: "linux",
      execFileSyncImpl: createExecFileSyncMock({
        "which claude": "/usr/local/bin/claude\n",
        "claude --version": "Claude Code 1.0.98\n",
        "npm root -g": new Error("not needed")
      })
    })

    expect(metadata.version).toBe("1.0.98")
    expect(metadata.source).toBe("claude --version")
    expect(metadata.binaryPath).toBe("/usr/local/bin/claude")
  })

  test("falls back to the installed global package version when cli output is unavailable", () => {
    const packagePath = join("/usr/local/lib/node_modules", "@anthropic-ai", "claude-code", "package.json")
    const metadata = resolveClaudeCodeMetadata({
      platform: "linux",
      execFileSyncImpl: createExecFileSyncMock({
        "which claude": new Error("not found"),
        "claude --version": new Error("not found"),
        "npm root -g": "/usr/local/lib/node_modules\n"
      }),
      existsSyncImpl: (path) => path === packagePath,
      readFileSyncImpl: ((path: string | number | Buffer | URL) => {
        if (path !== packagePath) {
          throw new Error(`Unexpected read: ${path}`)
        }
        return JSON.stringify({ version: "1.0.98" })
      }) as unknown as typeof import("node:fs").readFileSync
    })

    expect(metadata.version).toBe("1.0.98")
    expect(metadata.source).toBe("global package.json")
    expect(metadata.packagePath).toBe(packagePath)
    expect(metadata.packageVersion).toBe("1.0.98")
  })

  test("fails in strict mode when the installed claude version cannot be resolved", () => {
    expect(() => resolveClaudeCodeMetadata({
      env: {
        CLAUDE_PROXY_REQUIRE_INSTALLED_CLAUDE: "1"
      },
      platform: "linux",
      execFileSyncImpl: createExecFileSyncMock({
        "which claude": new Error("not found"),
        "claude --version": new Error("not found"),
        "npm root -g": new Error("not found")
      })
    })).toThrow("CLAUDE_PROXY_REQUIRE_INSTALLED_CLAUDE=1")
  })

  test("uses the pinned fallback only when strict mode is disabled", () => {
    const metadata = resolveClaudeCodeMetadata({
      env: {},
      platform: "linux",
      execFileSyncImpl: createExecFileSyncMock({
        "which claude": new Error("not found"),
        "claude --version": new Error("not found"),
        "npm root -g": new Error("not found")
      })
    })

    expect(metadata.version).toBe(config.ccVersion)
    expect(metadata.source).toBe("fallback")
  })
})
