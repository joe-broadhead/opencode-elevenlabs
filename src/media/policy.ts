// Writing a downloaded file under the media root. The policy is the family's: every directory on the way is a real
// directory and not a symlink, the canonical path stays inside the canonical root, the bytes go to a private staging
// file opened with O_NOFOLLOW and published with one link or rename, and the publication re-checks the directories and
// the target first. Node has no dirfd-relative openat, so this detects a changed directory; it is not a sandbox against
// someone who owns the root.
import { createHash } from "node:crypto"
import { constants, promises as fs } from "node:fs"
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

/** `~` is the user's home folder; every other path is taken as written, and a relative one is resolved against home. */
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
 * The duration of a finished file, when its container states one: a RIFF/WAVE header, or an MP4/M4A `mvhd`. Anything
 * else returns undefined rather than an estimate.
 */
export async function durationOf(file: string): Promise<number | undefined> {
  const handle = await fs.open(file, "r")
  try {
    const head = Buffer.alloc(64)
    const { bytesRead } = await handle.read(head, 0, head.length, 0)
    if (bytesRead >= 44 && head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WAVE") {
      const byteRate = head.readUInt32LE(28)
      const dataBytes = head.readUInt32LE(40)
      if (byteRate > 0 && dataBytes > 0) return Math.round((dataBytes / byteRate) * 1000) / 1000
      return undefined
    }
    // MP4/M4A: find `mvhd` in the first 64 KiB and read its timescale and duration. 32-bit and version-1 forms only.
    const chunk = Buffer.alloc(64 * 1024)
    const read = await handle.read(chunk, 0, chunk.length, 0)
    const box = chunk.subarray(0, read.bytesRead).indexOf(Buffer.from("mvhd", "ascii"))
    if (box < 0) return undefined
    const version = chunk[box + 4]
    if (version === 0) {
      const timescale = chunk.readUInt32BE(box + 16)
      const duration = chunk.readUInt32BE(box + 20)
      return timescale > 0 ? Math.round((duration / timescale) * 1000) / 1000 : undefined
    }
    if (version === 1) {
      const timescale = chunk.readUInt32BE(box + 24)
      const duration = Number(chunk.readBigUInt64BE(box + 28))
      return timescale > 0 ? Math.round((duration / timescale) * 1000) / 1000 : undefined
    }
    return undefined
  } finally {
    await handle.close()
  }
}
