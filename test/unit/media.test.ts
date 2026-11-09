import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { durationOf, expandRoot, safeName, writeMedia } from "../../src/media/policy.js"
import { checkUrl, saveMedia, savedText } from "../../src/media/save.js"

const root = realpathSync(mkdtempSync(join(tmpdir(), "elevenlabs-media-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const bytes = (text: string) => (async function* () { yield Buffer.from(text) })()
const HOSTS = ["elevenlabsusercontent.com"]

/** A response with a body this test controls. */
const response = (status: number, body: string, headers: Record<string, string> = {}) =>
  new Response(status === 204 ? null : body, { status, headers: { "content-type": "audio/mpeg", ...headers } })
const send = (byUrl: Record<string, () => Response>) => (async (url: string) => {
  const handler = byUrl[new URL(url).pathname]
  if (!handler) throw new Error(`unexpected fetch ${url}`)
  return handler()
}) as unknown as typeof fetch

describe("the media root", () => {
  test("expands ~ and resolves a relative path against home", () => {
    expect(expandRoot("~/Downloads/elevenlabs")).toMatch(/\/Downloads\/elevenlabs$/)
    expect(expandRoot("~")).not.toContain("~")
    expect(expandRoot("/srv/media")).toBe("/srv/media")
  })

  test("a name cannot leave the folder", () => {
    expect(safeName("../../etc/passwd", "fallback")).toBe("passwd")
    expect(safeName("a/b/c.mp3", "fallback")).toBe("c.mp3")
    expect(safeName("..", "fallback")).toBe("fallback")
    expect(safeName("", "fallback")).toBe("fallback")
    expect(safeName(".hidden", "fallback")).toBe("hidden")
    expect(safeName("ok name.wav", "f")).toBe("ok name.wav")
  })
})

describe("writeMedia", () => {
  test("writes the bytes, reports them, and creates the root when missing", async () => {
    const folder = join(root, "fresh", "nested")
    const written = await writeMedia({ root: folder, name: "a.mp3", maxBytes: 1024, body: bytes("hello") })
    expect(written.bytes).toBe(5)
    expect(written.sha256).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824")
    expect(readFileSync(written.path, "utf8")).toBe("hello")
    expect(written.path).toBe(join(realpathSync(folder), "a.mp3"))
  })

  test("refuses to replace a file unless asked, and replaces it when asked", async () => {
    const folder = join(root, "replace")
    await writeMedia({ root: folder, name: "a.txt", maxBytes: 1024, body: bytes("one") })
    await expect(writeMedia({ root: folder, name: "a.txt", maxBytes: 1024, body: bytes("two") })).rejects.toThrow("SAVE_FAILED")
    const replaced = await writeMedia({ root: folder, name: "a.txt", maxBytes: 1024, overwrite: true, body: bytes("two") })
    expect(readFileSync(replaced.path, "utf8")).toBe("two")
  })

  test("stops at the byte cap, however the body arrives", async () => {
    const folder = join(root, "cap")
    await expect(writeMedia({ root: folder, name: "big.bin", maxBytes: 8, body: bytes("0123456789") })).rejects.toThrow("MEDIA_TOO_LARGE")
    await expect(writeMedia({ root: folder, name: "big.bin", maxBytes: 8, expectedBytes: 9, body: bytes("x") })).rejects.toThrow("MEDIA_TOO_LARGE")
    // Nothing was published.
    expect(() => readFileSync(join(realpathSync(folder), "big.bin"))).toThrow()
  })

  test("refuses a symlinked root, and never follows one out of it", async () => {
    const outside = join(root, "outside")
    mkdirSync(outside, { recursive: true })
    const link = join(root, "linked")
    symlinkSync(outside, link)
    await expect(writeMedia({ root: link, name: "a.txt", maxBytes: 64, body: bytes("x") })).rejects.toThrow("symbolic link")
    // A symlinked file at the destination is refused too.
    const folder = join(root, "target")
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(outside, "secret.txt"), "secret")
    symlinkSync(join(outside, "secret.txt"), join(folder, "a.txt"))
    await expect(writeMedia({ root: folder, name: "a.txt", maxBytes: 64, overwrite: true, body: bytes("x") })).rejects.toThrow("symbolic link")
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("secret")
  })
})

describe("durationOf", () => {
  const wav = (seconds: number, byteRate = 8000) => {
    const data = Buffer.alloc(Math.round(seconds * byteRate))
    const header = Buffer.alloc(44)
    header.write("RIFF", 0, "ascii")
    header.writeUInt32LE(36 + data.length, 4)
    header.write("WAVE", 8, "ascii")
    header.write("fmt ", 12, "ascii")
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(1, 20)
    header.writeUInt16LE(1, 22)
    header.writeUInt32LE(byteRate, 24)
    header.writeUInt32LE(byteRate, 28)
    header.writeUInt16LE(1, 32)
    header.writeUInt16LE(8, 34)
    header.write("data", 36, "ascii")
    header.writeUInt32LE(data.length, 40)
    return Buffer.concat([header, data])
  }

  test("reads a RIFF/WAVE header, and says nothing when the container does not state a duration", async () => {
    const file = join(root, "tone.wav")
    writeFileSync(file, wav(2))
    expect(await durationOf(file)).toBe(2)
    const other = join(root, "blob.bin")
    writeFileSync(other, Buffer.from("not a container at all"))
    expect(await durationOf(other)).toBeUndefined()
  })
})

describe("the link checks", () => {
  test("a port other than the default https one is refused, and a loopback test host is exempt", () => {
    expect(() => checkUrl("https://elevenlabsusercontent.com:8443/a.mp3", HOSTS)).toThrow("MEDIA_URL_INVALID")
    expect(() => checkUrl("https://elevenlabsusercontent.com:443/a.mp3", HOSTS)).not.toThrow()
    // Only a seam's loopback host may use another port, because a test server listens where it can.
    expect(checkUrl("http://127.0.0.1:5000/media/a.mp3", ["elevenlabsusercontent.com", "127.0.0.1"]).port).toBe("5000")
  })

  test("https only, an allowed host only, no credentials", () => {
    expect(checkUrl("https://x.elevenlabsusercontent.com/a/b.mp3", HOSTS).hostname).toBe("x.elevenlabsusercontent.com")
    expect(checkUrl("https://elevenlabsusercontent.com/a.mp3", HOSTS).hostname).toBe("elevenlabsusercontent.com")
    for (const url of ["http://elevenlabsusercontent.com/a.mp3", "https://example.com/a.mp3", "https://user:pass@elevenlabsusercontent.com/a", "not a url"]) {
      expect(() => checkUrl(url, HOSTS)).toThrow("MEDIA_URL_INVALID")
    }
    // A lookalike domain does not match.
    expect(() => checkUrl("https://elevenlabsusercontent.com.evil.example/a.mp3", HOSTS)).toThrow("MEDIA_URL_INVALID")
  })
})

describe("saveMedia", () => {
  test("downloads, names the file from its type, and reports the path, size and hash", async () => {
    const folder = join(root, "download")
    const saved = await saveMedia({ url: "https://files.elevenlabsusercontent.com/abc", name: "voiceover" }, {
      root: folder,
      maxBytes: 1024,
      hosts: HOSTS,
      fetch: send({ "/abc": () => response(200, "ID3audio") }),
    })
    expect(saved).toMatchObject({ bytes: 8, mime: "audio/mpeg" })
    expect(saved.path.endsWith("voiceover.mp3")).toBe(true)
    expect(saved.sha256).toHaveLength(64)
    expect(savedText(saved)).toContain("Saved audio/mpeg to")
  })

  test("follows a redirect only while every hop stays on the allowed host", async () => {
    let hops = 0
    const fetchImpl = (async (url: string) => {
      hops++
      if (hops === 1) return new Response(null, { status: 302, headers: { location: "https://cdn.elevenlabsusercontent.com/final" } })
      void url
      return response(200, "data", { "content-type": "image/png" })
    }) as unknown as typeof fetch
    const saved = await saveMedia({ url: "https://files.elevenlabsusercontent.com/a", name: "shot" }, { root: join(root, "hop"), maxBytes: 1024, hosts: HOSTS, fetch: fetchImpl })
    expect(saved.path.endsWith("shot.png")).toBe(true)
    // A hop to another host is refused before it is fetched.
    const off = (async () => new Response(null, { status: 302, headers: { location: "https://evil.example/x" } })) as unknown as typeof fetch
    await expect(saveMedia({ url: "https://files.elevenlabsusercontent.com/a" }, { root: join(root, "off"), maxBytes: 1024, hosts: HOSTS, fetch: off })).rejects.toThrow("MEDIA_URL_INVALID")
  })

  test("an expired link says so and tells the user to fetch the generation again, not to generate again", async () => {
    await expect(saveMedia({ url: "https://files.elevenlabsusercontent.com/gone" }, {
      root: join(root, "expired"),
      maxBytes: 1024,
      hosts: HOSTS,
      fetch: send({ "/gone": () => response(403, "signature expired") }),
    })).rejects.toMatchObject({ code: "MEDIA_EXPIRED", nextStep: expect.stringContaining("Fetch the generation again") })
  })

  test("refuses a file larger than the cap before it is downloaded, and aborts one that grows", async () => {
    await expect(saveMedia({ url: "https://files.elevenlabsusercontent.com/big" }, {
      root: join(root, "big"),
      maxBytes: 4,
      hosts: HOSTS,
      fetch: send({ "/big": () => response(200, "0123456789", { "content-length": "10" }) }),
    })).rejects.toMatchObject({ code: "MEDIA_TOO_LARGE" })
    await expect(saveMedia({ url: "https://files.elevenlabsusercontent.com/grow" }, {
      root: join(root, "grow"),
      maxBytes: 4,
      hosts: HOSTS,
      fetch: send({ "/grow": () => response(200, "0123456789") }),
    })).rejects.toMatchObject({ code: "MEDIA_TOO_LARGE" })
  })

  test("a 404 is a link that never existed, not an expiry", async () => {
    await expect(saveMedia({ url: "https://files.elevenlabsusercontent.com/missing" }, {
      root: join(root, "missing"),
      maxBytes: 1024,
      hosts: HOSTS,
      fetch: send({ "/missing": () => response(404, "not found") }),
    })).rejects.toMatchObject({ code: "SAVE_FAILED" })
  })

  test("a malformed per cent escape in the link is handled, not thrown as a URIError", async () => {
    const saved = await saveMedia({ url: "https://files.elevenlabsusercontent.com/bad%E0%A4", name: "clip" }, {
      root: join(root, "escape"),
      maxBytes: 1024,
      hosts: HOSTS,
      fetch: send({ "/bad%E0%A4": () => response(200, "data") }),
    })
    expect(saved.path.endsWith("clip.mp3")).toBe(true)
  })

  test("a type that is not media is refused, and nothing is written", async () => {
    await expect(saveMedia({ url: "https://files.elevenlabsusercontent.com/page" }, {
      root: join(root, "html"),
      maxBytes: 1024,
      hosts: HOSTS,
      fetch: send({ "/page": () => response(200, "<html></html>", { "content-type": "text/html" }) }),
    })).rejects.toMatchObject({ code: "SAVE_FAILED" })
  })

  test("an upstream refusal that is not an expiry is a save failure, and the file is not written", async () => {
    await expect(saveMedia({ url: "https://files.elevenlabsusercontent.com/broken" }, {
      root: join(root, "broken"),
      maxBytes: 1024,
      hosts: HOSTS,
      fetch: send({ "/broken": () => response(500, "boom") }),
    })).rejects.toMatchObject({ code: "SAVE_FAILED" })
  })
})
