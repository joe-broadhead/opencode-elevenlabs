// Writing a downloaded file under the media root. The policy is the family's: every directory on the way is a real
// directory and not a symlink, the canonical path stays inside the canonical root, the bytes go to a private staging
// file opened with O_NOFOLLOW and published with one link or rename, and the publication re-checks the directories and
// the target first. Node has no dirfd-relative openat, so this detects a changed directory; it is not a sandbox against
// someone who owns the root.
import { createHash } from "node:crypto"
import { constants, promises as fs, readSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { elevenlabsError } from "../constants.js"

export interface WriteOptions {
  readonly root: string
  readonly name: string
  readonly maxBytes: number
  readonly overwrite?: boolean
  readonly signal?: AbortSignal
  /** The response body, or any async iterable of bytes. */
  readonly body: AsyncIterable<Uint8Array>
  /** The declared `content-length`, when the response gives one. */
  readonly expectedBytes?: number
}

export interface Written {
  /** The canonical absolute path. */
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}

const tooLarge = (maxBytes: number) =>
  elevenlabsError("MEDIA_TOO_LARGE", `The file is larger than the ${maxBytes} byte limit.`, `Raise "maxMediaBytes" in this plugin's options if you mean to keep a file this large.`)

const refused = (message: string) => elevenlabsError("SAVE_FAILED", message, "Check the plugin's mediaRoot and its permissions, then try again.")

/** `~` is the user's home folder; every other path is taken as written, and a relative one is resolved against the process's working directory. */
export function expandRoot(root: string): string {
  const expanded = root === "~" ? homedir() : root.startsWith("~/") ? path.join(homedir(), root.slice(2)) : root
  return path.resolve(expanded)
}

/** A file name that cannot leave the folder: no separators, no `..`, no NUL, no leading dot. */
export function safeName(name: string, fallback: string): string {
  const base = path.basename(name.replaceAll("\\", "/"))
  const cleaned = base.replace(/[\u0000-\u001f\u007f/\\]/g, "-").replace(/^\.+/, "").trim()
  return cleaned === "" || cleaned === "." || cleaned === ".." ? fallback : cleaned.slice(0, 180)
}

interface Identity {
  readonly path: string
  readonly canonical: string
  readonly dev: bigint
  readonly ino: bigint
}

const contains = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

async function identity(directory: string, create: boolean): Promise<Identity> {
  if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 }).catch(() => undefined)
  let stat
  try {
    stat = await fs.lstat(directory, { bigint: true })
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") throw refused(`The folder ${directory} does not exist.`)
    throw error
  }
  if (stat.isSymbolicLink()) throw refused(`The folder ${directory} is a symbolic link, which this plugin does not write through.`)
  if (!stat.isDirectory()) throw refused(`${directory} is not a folder.`)
  return { path: directory, canonical: await fs.realpath(directory), dev: stat.dev, ino: stat.ino }
}

async function recheck(directories: readonly Identity[]) {
  for (const previous of directories) {
    const current = await identity(previous.path, false)
    if (current.canonical !== previous.canonical || current.dev !== previous.dev || current.ino !== previous.ino) {
      throw refused("The media folder changed while the file was being written.")
    }
  }
}

async function targetState(target: string, overwrite: boolean) {
  let stat
  try {
    stat = await fs.lstat(target)
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return
    throw error
  }
  if (stat.isSymbolicLink()) throw refused("The file at the destination is a symbolic link, which this plugin does not replace.")
  if (!stat.isFile()) throw refused("The destination is not a regular file.")
  if (!overwrite) throw refused("A file with that name is already there; pass overwrite: true to replace it.")
}

/**
 * Streams a body into `root/name`. The root is created when missing (0700). Nothing outside the canonical root is ever
 * written, and an existing file is only replaced with `overwrite: true`.
 */
export async function writeMedia(options: WriteOptions): Promise<Written> {
  const { maxBytes, signal } = options
  signal?.throwIfAborted()
  if (options.expectedBytes !== undefined && options.expectedBytes > maxBytes) throw tooLarge(maxBytes)
  const root = await identity(expandRoot(options.root), true)
  const name = safeName(options.name, "elevenlabs-download")
  const target = path.join(root.canonical, name)
  if (!contains(root.canonical, target)) throw refused("The file name resolves outside the media folder.")
  await targetState(target, options.overwrite === true)
  await recheck([root])

  const staging = await fs.mkdtemp(path.join(root.canonical, ".elevenlabs-save-"))
  const staged = path.join(staging, "content")
  const hash = createHash("sha256")
  let bytes = 0
  let cleanupDegraded = false
  try {
    await fs.chmod(staging, 0o700)
    const handle = await fs.open(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      for await (const chunk of options.body) {
        signal?.throwIfAborted()
        bytes += chunk.byteLength
        if (bytes > maxBytes) throw tooLarge(maxBytes)
        hash.update(chunk)
        await handle.write(chunk)
      }
      signal?.throwIfAborted()
      await handle.sync()
    } finally {
      await handle.close()
    }
    await recheck([root])
    await targetState(target, options.overwrite === true)
    signal?.throwIfAborted()
    // The staged file's identity is read before it is published: a rename removes the staged name.
    const stagedStat = await fs.lstat(staged, { bigint: true })
    if (options.overwrite === true) await fs.rename(staged, target)
    else await fs.link(staged, target)
    // The published file is the one this call wrote: same inode, a regular file, not a link.
    const published = await fs.lstat(target, { bigint: true })
    if (published.isSymbolicLink() || !published.isFile() || published.ino !== stagedStat.ino) {
      throw refused("The file that was published is not the one this call wrote.")
    }
    return { path: target, bytes, sha256: hash.digest("hex") }
  } finally {
    try {
      await fs.unlink(staged).catch(() => undefined)
    } catch {
      cleanupDegraded = true
    }
    try {
      await fs.rmdir(staging)
    } catch {
      cleanupDegraded = true
    }
    if (cleanupDegraded) {
      // A leftover staging folder is under the root and named for this plugin; it is never recursive-removed.
    }
  }
}

/**
 * The PCM stream a WAV file's `fmt ` chunk describes, in the fields a decoder reads to turn bytes into seconds. The
 * `byteRate` field is deliberately not among them: it is redundant with these three, nothing checks it, and a file
 * that lies in it is a file that sets its own price.
 */
export interface PcmFormat {
  readonly sampleRate: number
  readonly channels: number
  readonly bitsPerSample: number
}

/** What a RIFF/WAVE file's own chunks say about its audio. Found by walking, never by a fixed offset. */
export interface RiffPcm {
  readonly format: PcmFormat
  /** Where the `data` chunk's bytes begin in the file. */
  readonly dataOffset: number
  /** The size the `data` chunk's own header states, which the file need not honour. */
  readonly statedDataBytes: number
}

const seconds = (value: number) => Math.round(value * 1000) / 1000
const CHUNK_ID = /^[\x20-\x7e]{4}$/

/** The ranges a real PCM stream sits in. Outside them the fields are not a measurement, so the file is not measured. */
const SAMPLE_RATE_MIN = 8_000
const SAMPLE_RATE_MAX = 192_000
const CHANNELS_MAX = 8
const BIT_DEPTHS = new Set([8, 16, 24, 32])
const WAVE_FORMAT_PCM = 1
const WAVE_FORMAT_EXTENSIBLE = 0xfffe
/** How many chunk headers one walk reads. A file is bounded by its own size; this bounds the work as well. */
const MAX_CHUNKS = 10_000

/**
 * Reads `length` bytes at `offset`, or undefined when the file does not hold them. A walk reads chunk headers at the
 * offsets the chunks themselves give, so the bytes it needs are a handful of eight-byte reads wherever `data` sits.
 */
export type ChunkReader = (offset: number, length: number) => Buffer | undefined

/** A reader over bytes already in hand. Anything past them is not there, so a walk that needs them refuses. */
export const readerOf =
  (chunk: Buffer): ChunkReader =>
  (offset, length) =>
    offset >= 0 && length >= 0 && offset + length <= chunk.length ? chunk.subarray(offset, offset + length) : undefined

/**
 * The PCM stream a `fmt ` body describes, or undefined when it describes something else. Format tag 1 is PCM;
 * `WAVE_FORMAT_EXTENSIBLE` is PCM when its sub-format GUID begins with the PCM one. Every other tag — ADPCM, A-law,
 * IEEE float, an MP3 or an Opus stream in a WAV wrapper — states a size in compressed bytes, which is not a duration.
 */
export function pcmFormatIn(body: Buffer): PcmFormat | undefined {
  if (body.length < 16) return undefined
  const tag = body.readUInt16LE(0)
  if (tag === WAVE_FORMAT_EXTENSIBLE) {
    // The sub-format GUID sits at offset 24 of a 40-byte body; its first field is the format tag it stands for.
    if (body.length < 28 || body.readUInt32LE(24) !== WAVE_FORMAT_PCM) return undefined
  } else if (tag !== WAVE_FORMAT_PCM) return undefined
  const channels = body.readUInt16LE(2)
  const sampleRate = body.readUInt32LE(4)
  const bitsPerSample = body.readUInt16LE(14)
  if (channels < 1 || channels > CHANNELS_MAX) return undefined
  if (sampleRate < SAMPLE_RATE_MIN || sampleRate > SAMPLE_RATE_MAX) return undefined
  if (!BIT_DEPTHS.has(bitsPerSample)) return undefined
  return { sampleRate, channels, bitsPerSample }
}

/** Bytes of audio one second of this stream occupies, as a decoder computes it from the fields it reads. */
export const bytesPerSecondOf = (format: PcmFormat) => (format.sampleRate * format.channels * format.bitsPerSample) / 8

/**
 * Walks a RIFF/WAVE file's chunks for `fmt ` and `data`, wherever they sit — a `JUNK` pad, a `LIST`, a `bext` and a
 * `fmt ` of 16, 18 or 40 bytes are all ordinary, so none of them may be read from a fixed offset. The walk reads on
 * past whatever was read first, because 100 kB of leading metadata is an ordinary broadcast or DAW export; it is
 * bounded by the file's own size and by a chunk count, so a hostile size neither hangs nor reads past the end.
 * Undefined when the chunks do not walk, when `fmt ` or `data` is not among them, or when `fmt ` is not PCM.
 */
export function riffPcmWith(read: ChunkReader, fileSize: number): RiffPcm | undefined {
  const head = read(0, 12)
  if (head === undefined || head.toString("ascii", 0, 4) !== "RIFF" || head.toString("ascii", 8, 12) !== "WAVE") return undefined
  let format: PcmFormat | undefined
  let offset = 12
  for (let walked = 0; walked < MAX_CHUNKS && offset + 8 <= fileSize; walked++) {
    const header = read(offset, 8)
    if (header === undefined) return undefined
    // latin1, not ascii: Node's ascii strips the high bit, so a byte over 0x7f would read as a printable character.
    const id = header.toString("latin1", 0, 4)
    if (!CHUNK_ID.test(id)) return undefined
    const size = header.readUInt32LE(4)
    const body = offset + 8
    if (id === "data") return format === undefined ? undefined : { format, dataOffset: body, statedDataBytes: size }
    if (id === "fmt " && size >= 16) {
      const fields = read(body, Math.min(size, 40))
      format ??= fields === undefined ? undefined : pcmFormatIn(fields)
    }
    // An odd chunk is padded to an even boundary. A size that runs past the end of the file does not walk.
    const next = body + size + (size % 2)
    if (!Number.isSafeInteger(next) || next <= offset || next > fileSize) return undefined
    offset = next
  }
  return undefined
}

/**
 * Chunk ids a real encoder writes after `data`. The test below also takes any printable id whose size fits the file,
 * because the list cannot be complete; these are here so the ordinary ones are recognised whatever else is true.
 */
const KNOWN_CHUNK_IDS = new Set(["LIST", "JUNK", "PAD ", "bext", "fact", "cue ", "smpl", "inst", "plst", "labl", "ltxt", "note", "iXML", "id3 ", "ID3 ", "afsp", "DISP", "acid", "_PMX", "data", "fmt "])

/**
 * Whether a well-formed chunk header begins at `offset`: a known or printable four-character id, and a size that
 * fits inside the file. Raw audio read as a header almost never passes both — a sample run gives a size in the
 * billions — so this is what tells a real trailing chunk from the audio a short `data` size field left out.
 */
function chunkStartsAt(read: ChunkReader, offset: number, fileSize: number): boolean {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + 8 > fileSize) return false
  const header = read(offset, 8)
  if (header === undefined) return false
  // latin1, not ascii: Node's ascii strips the high bit, which turns a sample byte into a printable character.
  const id = header.toString("latin1", 0, 4)
  if (!KNOWN_CHUNK_IDS.has(id) && !CHUNK_ID.test(id)) return false
  const size = header.readUInt32LE(4)
  return offset + 8 + size <= fileSize
}

/**
 * The seconds of audio a decoder reads out of a RIFF/WAVE file: the `data` chunk's bytes at the rate its `fmt `
 * fields imply. The audio is every byte that follows `data`, because a `data` size that understates the audio is
 * ordinary — a truncated file, one still being written, a bad mux — and the server reads to the end of what it is
 * sent. The stated size is believed only when a well-formed chunk begins exactly where it ends, pad byte included,
 * which is what a real trailing `LIST`, cue block or second `data` looks like; then the rest is metadata, not audio.
 * A size that overstates the audio is always clamped to the bytes that really follow. Both directions leave the
 * error on the over-priced side, which is the safe one: a cap must never admit a call it could not afford.
 */
export function riffSecondsWith(read: ChunkReader, fileSize: number): number | undefined {
  const riff = riffPcmWith(read, fileSize)
  if (riff === undefined) return undefined
  const following = Math.max(0, fileSize - riff.dataOffset)
  const stated = riff.statedDataBytes
  const trailing = stated < following && chunkStartsAt(read, riff.dataOffset + stated + (stated % 2), fileSize)
  const bytes = trailing ? stated : following
  const perSecond = bytesPerSecondOf(riff.format)
  return bytes > 0 && perSecond > 0 ? seconds(bytes / perSecond) : undefined
}

/**
 * The duration of a container, in seconds: a PCM RIFF/WAVE file measured against its own bytes. Anything else is
 * undefined. No other container is measured here — a duration taken from one unchecked field of an MP4, an MP3 or an
 * Opus stream is a figure the file chose, not one this plugin read, and a guess from a bitrate under-prices every
 * codec that sits below that floor.
 *
 * `fileSize` is the whole file's size; with only the buffer it is the buffer's length, and a `data` chunk past the
 * buffer is then not reachable. `durationOf` and the spending guard pass a reader that seeks instead.
 */
export function durationIn(chunk: Buffer, fileSize = chunk.length): number | undefined {
  return riffSecondsWith(readerOf(chunk), Math.min(fileSize, chunk.length))
}

/**
 * How much of a file one read pulls in. A walk needs eight bytes at each chunk header and forty at `fmt `, so a
 * window this size answers every header of an ordinary file from one read, and a `data` chunk behind 100 kB of
 * metadata costs a second. The walk never reads the audio itself.
 */
export const WINDOW_BYTES = 64 * 1024

/**
 * A reader over an open file descriptor, bounded by the file's own size, that keeps the windows it has read. A walk
 * reads chunk headers at ascending offsets, so the windows it keeps are a few; past `MAX_WINDOWS` it stops reading
 * and the file is not measured.
 */
export function fileReader(fd: number, size: number): ChunkReader {
  const windows = new Map<number, Buffer>()
  const MAX_WINDOWS = 16
  return (offset, length) => {
    if (offset < 0 || length < 0 || offset + length > size) return undefined
    // A read never spans two windows: a header is eight bytes and a `fmt ` body forty, so one window holds it whole.
    const index = Math.floor(offset / WINDOW_BYTES)
    const at = index * WINDOW_BYTES
    const span = Math.min(WINDOW_BYTES * 2, size - at)
    let window = windows.get(index)
    if (window === undefined) {
      if (windows.size >= MAX_WINDOWS) return undefined
      const buffer = Buffer.alloc(span)
      const read = readSync(fd, buffer, 0, buffer.length, at)
      window = buffer.subarray(0, read)
      windows.set(index, window)
    }
    const start = offset - at
    return start + length <= window.length ? window.subarray(start, start + length) : undefined
  }
}

/**
 * The duration of a finished file, when its container states one. Anything else returns undefined rather than an estimate.
 */
export async function durationOf(file: string): Promise<number | undefined> {
  const handle = await fs.open(file, "r")
  try {
    const size = (await handle.stat()).size
    if (size <= 0) return undefined
    return riffSecondsWith(fileReader(handle.fd, size), size)
  } finally {
    await handle.close()
  }
}
