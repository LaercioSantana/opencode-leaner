import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import http from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const script = fileURLToPath(new URL("../scripts/log-proxy.mjs", import.meta.url))

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function within(promise, message) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 3000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function startProxy(t, handler, logResponse) {
  const directory = await mkdtemp(path.join(tmpdir(), "opencode-log-proxy-"))
  const logFile = path.join(directory, "requests.log")
  const upstream = http.createServer(handler)
  upstream.listen(0, "127.0.0.1")
  await once(upstream, "listening")
  const child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      OPENCODE_LEANER_PROXY_PORT: "0",
      OPENCODE_LEANER_PROXY_UPSTREAM: `http://127.0.0.1:${upstream.address().port}`,
      OPENCODE_LEANER_PROXY_LOG_FILE: logFile,
      OPENCODE_LEANER_PROXY_LOG_RESPONSE: logResponse ? "1" : "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  const exited = once(child, "exit")
  t.after(async () => {
    child.kill()
    await exited
    upstream.closeAllConnections()
    await new Promise((resolve) => upstream.close(resolve))
    await rm(directory, { recursive: true, force: true })
  })
  child.stderr.on("data", (data) => { stderr += data })
  const ready = new Promise((resolve, reject) => {
    child.on("error", reject)
    child.on("exit", (code) => reject(new Error(`proxy exited (${code}): ${stderr}`)))
    child.stdout.on("data", (data) => {
      stdout += data
      const match = stdout.match(/log-proxy: (http:\/\/127\.0\.0\.1:\d+)/)
      if (match) resolve(match[1])
    })
  })
  const url = await within(ready, "proxy did not start")
  return {
    url,
    log: () => readFile(logFile, "utf8"),
    child,
    stderr: () => stderr,
  }
}

async function responseLog(proxy) {
  return within((async () => {
    for (;;) {
      const log = await proxy.log()
      if (log.includes("--- response (")) return log
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  })(), "response was not logged")
}

for (const logResponse of [true, false]) {
  test(`streams before upstream ends with response logging ${logResponse ? "on" : "off"}`, async (t) => {
    const finish = deferred()
    const first = Buffer.from("data: first\n\n")
    const last = Buffer.from("data: last\n\ndata: [DONE]\n\n")
    const requestBody = JSON.stringify({ model: "fixture", stream: true })
    let receivedBody = ""
    let receivedUrl
    const proxy = await startProxy(t, async (req, res) => {
      receivedUrl = req.url
      for await (const chunk of req) receivedBody += chunk
      res.writeHead(201, { "content-type": "text/event-stream", "x-proxy-fixture": "stream" })
      res.write(first)
      await finish.promise
      res.end(last)
    }, logResponse)
    t.after(() => finish.resolve())
    try {
      const response = await within(fetch(`${proxy.url}/v1/chat/completions?fixture=1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody,
      }), "proxy withheld response headers until upstream ended")
      assert.equal(response.status, 201)
      assert.equal(response.headers.get("content-type"), "text/event-stream")
      assert.equal(response.headers.get("x-proxy-fixture"), "stream")
      const reader = response.body.getReader()
      const chunk = await within(reader.read(), "proxy withheld first chunk until upstream ended")
      assert.equal(chunk.done, false)
      assert.deepEqual(Buffer.from(chunk.value), first)
      finish.resolve()
      const chunks = [Buffer.from(chunk.value)]
      for (;;) {
        const next = await within(reader.read(), "response did not finish")
        if (next.done) break
        chunks.push(Buffer.from(next.value))
      }
      const expected = Buffer.concat([first, last])
      assert.deepEqual(Buffer.concat(chunks), expected)
      assert.equal(receivedBody, requestBody)
      assert.equal(receivedUrl, "/v1/chat/completions?fixture=1")
      const log = logResponse ? await responseLog(proxy) : await proxy.log()
      assert.match(log, /model fixture/)
      assert.equal(log.includes(`--- response (201) ---\n${expected.toString()}\n`), logResponse)
      assert.equal(proxy.child.exitCode, null)
    } finally {
      finish.resolve()
    }
  })

  test(`preserves binary bytes and split UTF-8 with response logging ${logResponse ? "on" : "off"}`, async (t) => {
    const finish = deferred()
    const first = Buffer.from([0x00, 0xf0, 0x9f])
    const last = Buffer.from([0x98, 0x80, 0xff, 0x80, 0x01])
    const expected = Buffer.concat([first, last])
    const proxy = await startProxy(t, async (_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": expected.length })
      res.write(first)
      await finish.promise
      res.end(last)
    }, logResponse)
    t.after(() => finish.resolve())
    try {
      const response = await within(fetch(proxy.url), "proxy withheld binary response")
      assert.equal(response.headers.get("content-type"), "application/octet-stream")
      assert.equal(response.headers.get("content-length"), String(expected.length))
      const reader = response.body.getReader()
      const chunk = await within(reader.read(), "proxy withheld binary chunk")
      assert.deepEqual(Buffer.from(chunk.value), first)
      finish.resolve()
      const chunks = [Buffer.from(chunk.value)]
      for (;;) {
        const next = await within(reader.read(), "binary response did not finish")
        if (next.done) break
        chunks.push(Buffer.from(next.value))
      }
      assert.deepEqual(Buffer.concat(chunks), expected)
      const log = logResponse ? await responseLog(proxy) : await proxy.log()
      assert.equal(log.includes(`--- response (200) ---\n${expected.toString("utf8")}\n`), logResponse)
    } finally {
      finish.resolve()
    }
  })
}

for (const logResponse of [true, false]) {
  test(`handles an interrupted upstream with response logging ${logResponse ? "on" : "off"}`, async (t) => {
    const interrupt = deferred()
    const proxy = await startProxy(t, async (req, res) => {
      if (req.url === "/health") return res.end("ok")
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write("data: first\n\n")
      await interrupt.promise
      res.destroy()
    }, logResponse)
    t.after(() => interrupt.resolve())
    try {
      const response = await within(fetch(proxy.url), "proxy withheld response")
      const reader = response.body.getReader()
      await within(reader.read(), "proxy withheld first chunk")
      interrupt.resolve()
      await within(assert.rejects(reader.read()), "upstream failure did not reach the client")
      assert.equal((await proxy.log()).includes("--- response ("), false)
      const healthy = await within(fetch(`${proxy.url}/health`), "proxy stopped serving after a stream error")
      assert.equal(await healthy.text(), "ok")
      assert.equal(proxy.child.exitCode, null, proxy.stderr())
    } finally {
      interrupt.resolve()
    }
  })

  test(`cancels upstream on client disconnect with response logging ${logResponse ? "on" : "off"}`, async (t) => {
    const closed = deferred()
    const proxy = await startProxy(t, (req, res) => {
      if (req.url === "/health") return res.end("ok")
      res.on("close", () => closed.resolve())
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write("data: first\n\n")
      // Intentionally never finish. Disconnect must cancel the upstream reader.
    }, logResponse)
    const request = http.get(proxy.url)
    t.after(() => request.destroy())
    const [response] = await within(once(request, "response"), "proxy withheld response")
    await within(once(response, "data"), "proxy withheld first chunk")
    response.destroy()
    await within(closed.promise, "upstream remained open after the client disconnected")
    assert.equal((await proxy.log()).includes("--- response ("), false)
    const healthy = await within(fetch(`${proxy.url}/health`), "proxy stopped serving after client disconnect")
    assert.equal(await healthy.text(), "ok")
    assert.equal(proxy.child.exitCode, null, proxy.stderr())
  })

  test(`cancels before upstream headers with response logging ${logResponse ? "on" : "off"}`, async (t) => {
    const started = deferred()
    const closed = deferred()
    const proxy = await startProxy(t, (_req, res) => {
      res.on("close", () => closed.resolve())
      started.resolve()
      // Leave fetch waiting for headers when the downstream connection closes.
    }, logResponse)
    const request = http.get(proxy.url)
    request.on("error", () => {}) // Destroying an unanswered request emits ECONNRESET.
    t.after(() => request.destroy())
    await within(started.promise, "upstream request did not start")
    request.destroy()
    await within(closed.promise, "upstream remained open before response headers")
    assert.equal(proxy.child.exitCode, null, proxy.stderr())
  })

  test(`handles an empty response with response logging ${logResponse ? "on" : "off"}`, async (t) => {
    const proxy = await startProxy(t, (_req, res) => {
      res.writeHead(204, { "x-proxy-fixture": "empty" })
      res.end()
    }, logResponse)
    const response = await within(fetch(proxy.url), "empty response did not finish")
    assert.equal(response.status, 204)
    assert.equal(response.headers.get("x-proxy-fixture"), "empty")
    assert.equal(await response.text(), "")
    assert.equal((await proxy.log()).includes("--- response ("), false)
  })
}
