const fs = require("node:fs")
const { mkdirSync, writeFileSync } = fs
const path = require("node:path")
const http = require("node:http")
const https = require("node:https")
const { URL } = require("node:url")

const RAW_CAPTURE_PATH = process.env.CLAUDE_OFFICIAL_CAPTURE_RAW_PATH
const BINARY_PATH = process.env.CLAUDE_OFFICIAL_CAPTURE_BINARY_PATH || null
const RUN_ID = process.env.CLAUDE_OFFICIAL_CAPTURE_RUN_ID || null

function shouldCaptureUrl(url) {
  try {
    const parsed = new URL(url)
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "api.anthropic.com" &&
      parsed.pathname === "/v1/messages"
    )
  } catch {
    return false
  }
}

function ensureParentDirectory(filePath) {
  mkdirSync(path.dirname(filePath), { recursive: true })
}

function writeCapture(capture) {
  if (!RAW_CAPTURE_PATH) return
  ensureParentDirectory(RAW_CAPTURE_PATH)
  writeFileSync(RAW_CAPTURE_PATH, JSON.stringify(capture, null, 2), "utf-8")
}

function headersToObject(headers) {
  if (!headers) return {}

  if (typeof headers.forEach === "function") {
    const object = {}
    headers.forEach((value, key) => {
      object[key] = value
    })
    return object
  }

  if (Array.isArray(headers)) {
    return headers.reduce((accumulator, entry) => {
      if (Array.isArray(entry) && entry.length >= 2) {
        accumulator[String(entry[0]).toLowerCase()] = String(entry[1])
      }
      return accumulator
    }, {})
  }

  return Object.entries(headers).reduce((accumulator, [key, value]) => {
    if (Array.isArray(value)) {
      accumulator[key.toLowerCase()] = value.join(", ")
    } else if (value !== undefined && value !== null) {
      accumulator[key.toLowerCase()] = String(value)
    }
    return accumulator
  }, {})
}

function toBuffer(chunk, encoding) {
  if (chunk === undefined || chunk === null) return null
  if (Buffer.isBuffer(chunk)) return chunk
  if (typeof chunk === "string") return Buffer.from(chunk, encoding)
  if (ArrayBuffer.isView(chunk)) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  if (chunk instanceof ArrayBuffer) return Buffer.from(chunk)
  return Buffer.from(String(chunk))
}

function createCapture(request, transport, response) {
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    runtime: {
      transport,
      binaryPath: BINARY_PATH,
      argv: process.argv.slice(1),
      runId: RUN_ID
    },
    request,
    response
  }
}

async function patchFetch() {
  if (!RAW_CAPTURE_PATH || typeof globalThis.fetch !== "function" || typeof globalThis.Request !== "function") {
    return
  }

  const originalFetch = globalThis.fetch
  globalThis.fetch = async function wrappedFetch(input, init) {
    const request = new globalThis.Request(input, init)
    if (!shouldCaptureUrl(request.url)) {
      return originalFetch.call(this, request)
    }

    const requestBody = request.method === "GET" || request.method === "HEAD"
      ? null
      : await request.clone().text()
    const requestRecord = {
      url: request.url,
      method: request.method,
      headers: headersToObject(request.headers),
      body: requestBody
    }

    try {
      const response = await originalFetch.call(this, request)
      writeCapture(createCapture(requestRecord, "fetch", {
        status: response.status,
        headers: headersToObject(response.headers),
        contentType: response.headers.get("content-type")
      }))
      return response
    } catch (error) {
      writeCapture(createCapture(requestRecord, "fetch", {
        status: null,
        headers: {},
        contentType: null,
        error: error instanceof Error ? error.message : String(error)
      }))
      throw error
    }
  }
}

function normalizeRequestUrl(protocol, input, options) {
  try {
    if (input instanceof URL) {
      return new URL(input.toString())
    }

    if (typeof input === "string") {
      return new URL(input)
    }

    const source = (typeof input === "object" && input !== null ? input : options) || {}
    const transportProtocol = source.protocol || protocol
    const hostname = source.hostname || source.host
    const port = source.port ? `:${source.port}` : ""
    const requestPath = source.path || source.pathname || "/"
    if (!hostname) return null
    return new URL(`${transportProtocol}//${hostname}${port}${requestPath}`)
  } catch {
    return null
  }
}

function normalizeRequestMethod(input, options) {
  const source = (typeof input === "object" && input !== null ? input : options) || {}
  return source.method || options?.method || "GET"
}

function normalizeRequestHeaders(input, options) {
  const source = (typeof input === "object" && input !== null ? input : options) || {}
  return headersToObject(source.headers || options?.headers)
}

function patchRequestModule(moduleRef, originalRequest, protocol, transport) {
  if (!RAW_CAPTURE_PATH) return

  moduleRef.request = function wrappedRequest(input, options, callback) {
    const url = normalizeRequestUrl(protocol, input, options)
    const shouldCapture = url && shouldCaptureUrl(url.toString())
    const request = originalRequest.apply(this, arguments)

    if (!shouldCapture) {
      return request
    }

    const chunks = []
    const originalWrite = request.write
    const originalEnd = request.end

    request.write = function patchedWrite(chunk, encoding, cb) {
      const buffer = toBuffer(chunk, encoding)
      if (buffer) chunks.push(buffer)
      return originalWrite.call(this, chunk, encoding, cb)
    }

    request.end = function patchedEnd(chunk, encoding, cb) {
      const buffer = toBuffer(chunk, encoding)
      if (buffer) chunks.push(buffer)
      return originalEnd.call(this, chunk, encoding, cb)
    }

    request.on("response", (response) => {
      writeCapture(createCapture({
        url: url.toString(),
        method: normalizeRequestMethod(input, options),
        headers: normalizeRequestHeaders(input, options),
        body: chunks.length > 0 ? Buffer.concat(chunks).toString("utf-8") : null
      }, transport, {
        status: response.statusCode ?? null,
        headers: headersToObject(response.headers),
        contentType: response.headers["content-type"] || null
      }))
    })

    request.on("error", (error) => {
      writeCapture(createCapture({
        url: url.toString(),
        method: normalizeRequestMethod(input, options),
        headers: normalizeRequestHeaders(input, options),
        body: chunks.length > 0 ? Buffer.concat(chunks).toString("utf-8") : null
      }, transport, {
        status: null,
        headers: {},
        contentType: null,
        error: error instanceof Error ? error.message : String(error)
      }))
    })

    if (typeof callback === "function") {
      request.on("response", callback)
    }

    return request
  }
}

if (RAW_CAPTURE_PATH) {
  patchFetch()
  patchRequestModule(http, http.request, "http:", "http.request")
  patchRequestModule(https, https.request, "https:", "https.request")
}

module.exports = {
  headersToObject,
  shouldCaptureUrl
}
