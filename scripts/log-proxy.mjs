import http from "node:http"
import fs from "node:fs"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"

const PORT = Number(process.env.OPENCODE_LEANER_PROXY_PORT ?? 18077)
const UPSTREAM = process.env.OPENCODE_LEANER_PROXY_UPSTREAM ?? "http://192.168.2.56:8077/v1"
const LOG_FILE = process.env.OPENCODE_LEANER_PROXY_LOG_FILE ?? "/tmp/opencode-proxy-requests.txt"
const LOG_RESPONSE = process.env.OPENCODE_LEANER_PROXY_LOG_RESPONSE === "1"

const server = http.createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString("utf8")
  const ts = new Date().toISOString()

  let model = "n/a"
  let pretty = raw
  try {
    const parsed = JSON.parse(raw)
    model = parsed.model ?? "n/a"
    pretty = JSON.stringify(parsed, null, 2)
  } catch {
    // non-JSON body, keep raw
  }

  fs.appendFileSync(
    LOG_FILE,
    `\n=== ${ts} | ${req.method} ${req.url} | model ${model} ===\n${pretty}\n`,
  )

  const headers = { ...req.headers }
  delete headers.host
  delete headers["content-length"]

  if (res.destroyed) return
  const controller = new AbortController()
  res.once("close", () => controller.abort())

  const upstreamUrl = new URL(req.url, UPSTREAM)
  let upstream
  try {
    upstream = await fetch(upstreamUrl, {
      method: req.method,
      signal: controller.signal,
      headers,
      body: raw.length > 0 ? Buffer.from(raw) : undefined,
    })
  } catch (err) {
    res.statusCode = 502
    res.end(`upstream error: ${err.message}`)
    return
  }

  res.statusCode = upstream.status
  for (const [k, v] of upstream.headers) res.setHeader(k, v)

  if (!upstream.body) {
    res.end()
    return
  }

  const response = []
  const streams = [Readable.fromWeb(upstream.body)]
  if (LOG_RESPONSE) {
    streams.push(new Transform({
      transform(chunk, _encoding, callback) {
        response.push(chunk)
        callback(null, chunk)
      },
    }))
  }

  try {
    // Forward and capture in one pass, honoring backpressure and cancellation.
    await pipeline(...streams, res)
    if (LOG_RESPONSE) {
      const text = Buffer.concat(response).toString("utf8")
      fs.appendFileSync(LOG_FILE, `\n--- response (${upstream.status}) ---\n${text}\n`)
    }
  } catch (err) {
    // pipeline destroys the response and upstream body on stream errors/disconnects.
    console.error(`response error: ${err.message}`)
  }
})

server.listen(PORT, "127.0.0.1", () => {
  console.log(`log-proxy: http://127.0.0.1:${server.address().port} -> ${UPSTREAM}`)
  console.log(`logging requests to ${LOG_FILE}`)
  if (LOG_RESPONSE) console.log("logging responses too")
})
