import { elevenlabsError } from "../constants.js"
import { durationOf, safeName, writeMedia } from "./policy.js"

/** The link checks, the download and the file write, with the seams a test needs. */
export interface SaveDeps {
  readonly root: string
  readonly maxBytes: number
  /** The hosts a link may point at. The real list is ElevenLabs' user-content domain; a test seam adds its own. */
  readonly hosts: readonly string[]
  readonly fetch?: typeof fetch
  readonly signal?: AbortSignal
  readonly overwrite?: boolean
}

export interface Saved {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
  readonly mime: string
  readonly durationSeconds?: number
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/wave": ".wav",
  "audio/ogg": ".ogg",
  "audio/flac": ".flac",
  "audio/mp4": ".m4a",
  "audio/aac": ".aac",
  "audio/webm": ".weba",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
}

const HOP_LIMIT = 4

/** A loopback literal, which only a test seam ever allows: production's host list is ElevenLabs' own. */
const loopback = (hostname: string) => hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1"

/** `https` only, a host this plugin allows and no credentials in the URL. */
export function checkUrl(raw: string, hosts: readonly string[]): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw invalid("That is not a URL.")
  }
  // Plain http is refused, except for a loopback host a test seam added: a signed ElevenLabs link is never loopback.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback(url.hostname) && hosts.some(loopback))) {
    throw invalid(`Only an https link is fetched, and this one is ${url.protocol.replace(":", "")}.`)
  }
  // Only the default https port: a signed link never carries another, and an odd port is not ElevenLabs' host as we know
  // it. A loopback host a test seam added is exempt, because a test server listens where it can.
  const loopbackHost = loopback(url.hostname) && hosts.some(loopback)
  if (!loopbackHost && url.port !== "" && url.port !== "443") throw invalid(`The link names port ${url.port}; only the default https port is fetched.`)
  if (url.username !== "" || url.password !== "") throw invalid("The link carries a username or password.")
  if (!hosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
    throw invalid(`The link is on ${url.hostname}, and only ElevenLabs' generated-file hosts are fetched.`)
  }
  return url
}

const invalid = (message: string) =>
  elevenlabsError("MEDIA_URL_INVALID", message, "Pass the link a generation returned, such as one on elevenlabsusercontent.com.")

/** The types a generated file can be. Anything else is not a file a generation produces, and is refused. */
const MEDIA_TYPE = /^(?:image|audio|video)\/|^application\/octet-stream$/

const expired = (status: number) =>
  elevenlabsError(
    "MEDIA_EXPIRED",
    `ElevenLabs no longer serves that link (HTTP ${status}). A generated file's link expires about two hours after the generation.`,
    "Fetch the generation again to get a fresh link, then save that; generating it again spends more credits.",
  )

/** Follows redirects by hand, so every hop is checked against the same host list. */
async function follow(start: URL, deps: SaveDeps): Promise<Response> {
  const send = deps.fetch ?? fetch
  let url = start
  for (let hop = 0; hop <= HOP_LIMIT; hop++) {
    const response = await send(url.toString(), {
      redirect: "manual",
      ...(deps.signal ? { signal: deps.signal } : {}),
      headers: { accept: "*/*" },
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location")
      await response.body?.cancel().catch(() => undefined)
      if (!location) throw invalid("The link redirected without saying where.")
      // The same rules apply at every hop: a redirect cannot move the download off the allowed hosts.
      url = checkUrl(new URL(location, url).toString(), deps.hosts)
      continue
    }
    // A refused or expired signature is an expired link; a 404 is a link that never existed, and says so.
    if (response.status === 401 || response.status === 403 || response.status === 410) throw expired(response.status)
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined)
      throw elevenlabsError("SAVE_FAILED", "ElevenLabs has no file at that link.", "Check the link you passed: a generation's link is long and easy to cut short.")
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw elevenlabsError("SAVE_FAILED", `ElevenLabs answered HTTP ${response.status} for that link.`, "Try again; if it keeps failing, fetch the generation again for a fresh link.")
    }
    return response
  }
  throw invalid(`The link redirected more than ${HOP_LIMIT} times.`)
}

/** The name to write: the caller's, else the link's, with the extension the response's type implies. */
function nameFor(response: Response, url: URL, asked: string | undefined): string {
  const mime = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase()
  const extension = EXTENSIONS[mime]
  const last = url.pathname.split("/").filter(Boolean).at(-1) ?? ""
  // A malformed per cent escape in the link is not a reason to fail with a raw URIError.
  let fromUrl = last
  try {
    fromUrl = decodeURIComponent(last)
  } catch {
    fromUrl = last.replace(/%(?![0-9A-Fa-f]{2})/g, "%25")
  }
  const base = safeName(asked ?? fromUrl, `elevenlabs-${Date.now()}`)
  if (extension === undefined) return base
  return base.toLowerCase().endsWith(extension) ? base : `${base.replace(/\.[A-Za-z0-9]{1,5}$/, "")}${extension}`
}

/** Downloads one generated file under the media root and reports what was written. No bytes reach the model. */
export async function saveMedia(input: { readonly url: string; readonly name?: string }, deps: SaveDeps): Promise<Saved> {
  const url = checkUrl(input.url, deps.hosts)
  const response = await follow(url, deps)
  const declared = Number(response.headers.get("content-length") ?? "")
  if (Number.isFinite(declared) && declared > deps.maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw elevenlabsError(
      "MEDIA_TOO_LARGE",
      `The file is ${declared} bytes and the limit is ${deps.maxBytes}.`,
      `Raise "maxMediaBytes" in this plugin's options if you mean to keep a file this large.`,
    )
  }
  if (!response.body) throw elevenlabsError("SAVE_FAILED", "ElevenLabs sent no file body.", "Try again, then fetch the generation again for a fresh link.")
  const mime = (response.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim().toLowerCase()
  if (!MEDIA_TYPE.test(mime)) {
    await response.body.cancel().catch(() => undefined)
    throw elevenlabsError(
      "SAVE_FAILED",
      `ElevenLabs sent ${mime}, which is not an image, audio or video file.`,
      "Save the link a generation returned, not a page or an API response.",
    )
  }
  const written = await writeMedia({
    root: deps.root,
    name: nameFor(response, url, input.name),
    maxBytes: deps.maxBytes,
    ...(deps.overwrite === undefined ? {} : { overwrite: deps.overwrite }),
    ...(deps.signal ? { signal: deps.signal } : {}),
    ...(Number.isFinite(declared) ? { expectedBytes: declared } : {}),
    body: response.body as unknown as AsyncIterable<Uint8Array>,
  })
  const duration = await durationOf(written.path).catch(() => undefined)
  return { ...written, mime, ...(duration === undefined ? {} : { durationSeconds: duration }) }
}

/** The line the model reads: where the file is, how big, and what it is. */
export function savedText(saved: Saved) {
  const size = saved.bytes < 1024 ? `${saved.bytes} bytes` : saved.bytes < 1024 * 1024 ? `${Math.round(saved.bytes / 102.4) / 10} KB` : `${Math.round(saved.bytes / 104857.6) / 10} MB`
  const duration = saved.durationSeconds === undefined ? "" : `, ${saved.durationSeconds} s`
  return `Saved ${saved.mime} to ${saved.path} (${size}${duration}).`
}
