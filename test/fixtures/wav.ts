/**
 * WAV fixtures for the spending guard. Every one is a valid RIFF/WAVE file, 8 kHz mono 8-bit, so one second of audio
 * is exactly 8,000 bytes and a 60-second file is worth 330 credits at ElevenLabs' 330-per-minute Speech to Text rate.
 *
 * The layouts here are the ordinary ones a real encoder writes: a canonical 44-byte header, a `JUNK` pad before
 * `fmt ` (BWF and alignment padding, zero-filled or not), a `fmt ` chunk of 18 bytes with `cbSize`, one of 40 bytes
 * for WAVE_FORMAT_EXTENSIBLE, and a `data` size field that does not match the bytes written (a truncated, a
 * still-being-written or a badly-muxed file). None of them may change the price of the audio that is really there.
 */

/** 8 kHz, mono, 8-bit: 8,000 bytes of audio per second. */
export const BYTE_RATE = 8_000

/** The credits ElevenLabs charges for a minute of Speech to Text, repeated here so a fixture states its own truth. */
export const STT_PER_MINUTE = 330

const chunk = (id: string, body: Buffer) => {
  const header = Buffer.alloc(8)
  header.write(id.padEnd(4, " ").slice(0, 4), 0, "ascii")
  header.writeUInt32LE(body.length, 4)
  return Buffer.concat([header, body, body.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0)])
}

/** A `fmt ` body of 16, 18 or 40 bytes. All three state the same 8 kHz mono 8-bit PCM stream. */
const fmtBody = (size: 16 | 18 | 40, byteRate = BYTE_RATE, tag?: number) => {
  const body = Buffer.alloc(size)
  body.writeUInt16LE(tag ?? (size === 40 ? 0xfffe : 1), 0) // PCM, or WAVE_FORMAT_EXTENSIBLE
  body.writeUInt16LE(1, 2) // channels
  body.writeUInt32LE(BYTE_RATE, 4) // sample rate
  body.writeUInt32LE(byteRate, 8) // byte rate, which a decoder does not need and a file may lie in
  body.writeUInt16LE(1, 12) // block align
  body.writeUInt16LE(8, 14) // bits per sample
  if (size >= 18) body.writeUInt16LE(size - 18, 16) // cbSize
  if (size === 40) {
    body.writeUInt16LE(8, 18) // valid bits per sample
    body.writeUInt32LE(0x4, 20) // channel mask: front centre
    body.writeUInt16LE(1, 24) // the PCM sub-format GUID's first field
  }
  return body
}

/** Audio bytes that are not silence, so nothing can mistake a fixture for an empty file. */
const audio = (bytes: number) => Buffer.from(Array.from({ length: bytes }, (_, index) => (index * 37) % 251))

/** A padding chunk's body: zeros, which is what real alignment padding holds, or bytes that could be read as numbers. */
const padBody = (bytes: number, fill: "zero" | "numbers") => (fill === "zero" ? Buffer.alloc(bytes) : audio(bytes))

export interface WavOptions {
  /** Seconds of audio actually written into the `data` chunk. */
  readonly seconds: number
  /** Chunks written before `fmt `, as a real `JUNK` pad or `bext` block would be. */
  readonly before?: readonly { readonly id: string; readonly bytes: number; readonly fill: "zero" | "numbers" }[]
  /** The `fmt ` chunk's size. 16 is canonical; 18 and 40 are just as ordinary. */
  readonly fmtSize?: 16 | 18 | 40
  /** What the `data` chunk's size field says, when it should not match the bytes written. */
  readonly statedDataBytes?: number
  /** What the `fmt ` chunk's byte-rate field says. A decoder computes the rate itself, so this may be a lie. */
  readonly byteRate?: number
  /** The `fmt ` chunk's format tag, for a file that is not PCM. */
  readonly formatTag?: number
  /** Chunks written after the audio, as artwork, a cue list or a second `data` chunk would be. */
  readonly after?: readonly { readonly id: string; readonly bytes: number; readonly fill: "zero" | "numbers" }[]
}

/** One WAV fixture. */
export function buildWav(options: WavOptions): Buffer {
  const bytes = Math.round(options.seconds * BYTE_RATE)
  const body = audio(bytes)
  const data = Buffer.alloc(8)
  data.write("data", 0, "ascii")
  data.writeUInt32LE(options.statedDataBytes ?? bytes, 4)
  const parts = [
    ...(options.before ?? []).map((pad) => chunk(pad.id, padBody(pad.bytes, pad.fill))),
    chunk("fmt ", fmtBody(options.fmtSize ?? 16, options.byteRate, options.formatTag)),
    data,
    body,
    ...(options.after ?? []).map((trailing) => chunk(trailing.id, padBody(trailing.bytes, trailing.fill))),
  ]
  const rest = Buffer.concat(parts)
  const riff = Buffer.alloc(12)
  riff.write("RIFF", 0, "ascii")
  riff.writeUInt32LE(rest.length + 4, 4)
  riff.write("WAVE", 8, "ascii")
  return Buffer.concat([riff, rest])
}

/** The layouts the re-reviews name, each holding sixty seconds of audio unless its name says otherwise. */
export const WAV_FIXTURES = {
  /** The 44-byte header every fixed-offset reader assumes. */
  canonical: () => buildWav({ seconds: 60 }),
  /** A `JUNK` pad before `fmt `, holding bytes a fixed-offset reader would take for a byte rate and a data size. */
  junkNumbers: () => buildWav({ seconds: 60, before: [{ id: "JUNK", bytes: 28, fill: "numbers" }] }),
  /** The same pad, zero-filled, which is what alignment padding really holds. */
  junkZeros: () => buildWav({ seconds: 60, before: [{ id: "JUNK", bytes: 28, fill: "zero" }] }),
  /** `fmt ` of 18 bytes, with `cbSize`, which many encoders write. */
  fmt18: () => buildWav({ seconds: 60, fmtSize: 18 }),
  /** `fmt ` of 40 bytes, WAVE_FORMAT_EXTENSIBLE. */
  fmt40: () => buildWav({ seconds: 60, fmtSize: 40 }),
  /** Sixty seconds of audio under a `data` size field that claims one eighth of a second. */
  understated: () => buildWav({ seconds: 60, statedDataBytes: 1_000 }),
  /** Sixty seconds of audio under a `data` size field that claims ten minutes. */
  overstated: () => buildWav({ seconds: 60, statedDataBytes: 4_800_000 }),
  /** Thirty seconds of audio under a header that still claims sixty: a file cut off while it was written. */
  truncated: () => buildWav({ seconds: 30, statedDataBytes: 480_000 }),
  /** Sixty seconds of audio under a byte-rate field claiming ten times the real rate: a decoder never reads it. */
  inflatedByteRate: () => buildWav({ seconds: 60, byteRate: BYTE_RATE * 10 }),
  /** Sixty seconds of audio behind 100 kB of metadata, so `data` sits well past any one read of the head. */
  bigMeta: () => buildWav({ seconds: 60, before: [{ id: "LIST", bytes: 100_000, fill: "numbers" }] }),
  /** One second of audio with 100 kB of artwork after it: trailing chunks are metadata and are not billed. */
  trailing: () => buildWav({ seconds: 1, after: [{ id: "LIST", bytes: 100_000, fill: "numbers" }] }),
  /** One second of audio followed by a second `data` chunk of sixty: only the first `data` chunk is the audio. */
  twoData: () => buildWav({ seconds: 1, after: [{ id: "data", bytes: 480_000, fill: "numbers" }] }),
} as const

/**
 * Sixty seconds of audio under a `data` size field claiming one second, with nothing that reads as a chunk header
 * where that size ends. A decoder reads on to the end of the file, so all sixty seconds are the audio and are billed.
 */
export const understatedThenJunk = () => buildWav({ seconds: 60, statedDataBytes: 8_000 })

/**
 * The same file, with a printable four-character id written where the stated size ends and a size field claiming
 * almost four gigabytes. The id alone does not make a chunk: the size has to fit inside the file, and this one
 * cannot, so the bytes are audio and are billed.
 */
export function understatedThenFakeHeader(): Buffer {
  const wav = understatedThenJunk()
  // A canonical header is 44 bytes, so the stated 8,000 bytes of `data` end at 8,044.
  wav.write("LIST", 8_044, "ascii")
  wav.writeUInt32LE(0xffff_fff0, 8_048)
  return wav
}

/**
 * A chunk before `fmt ` whose size field claims almost four gigabytes. The walk is bounded by the file's own size, so
 * it refuses rather than reading past the end, allocating the size it was told, or walking forever.
 */
export function hostileChunkSize(): Buffer {
  const wav = buildWav({ seconds: 1, before: [{ id: "JUNK", bytes: 16, fill: "zero" }] })
  // The `JUNK` chunk's size field, at offset 16: the first chunk header sits at 12.
  wav.writeUInt32LE(0xffff_fff0, 16)
  return wav
}

/** A chunk whose size field is zero, repeated: the walk steps eight bytes at a time and must still terminate. */
export function zeroSizeChunks(count: number): Buffer {
  const pads = Buffer.concat(Array.from({ length: count }, () => chunk("JUNK", Buffer.alloc(0))))
  const wav = buildWav({ seconds: 1 })
  const head = wav.subarray(0, 12)
  const rest = Buffer.concat([pads, wav.subarray(12)])
  const riff = Buffer.from(head)
  riff.writeUInt32LE(rest.length + 4, 4)
  return Buffer.concat([riff, rest])
}

/**
 * An MP4 whose `mvhd` box states a duration, as a real M4A does, with an `mdat` of compressed audio in front of it at
 * `bytesPerSecond` — the walk to `moov` therefore seeks over a real payload, as it does in a finished file.
 *
 * The plugin never prices one: an MP4 is not a PCM stream it can measure, so a priced call is refused rather than
 * billed from a field it cannot check. The save tool shows the stated duration, which is display only.
 */
export function buildMp4(seconds: number, bytesPerSecond = 2_000): Buffer {
  const mvhd = Buffer.alloc(108)
  mvhd.writeUInt32LE(0, 0)
  mvhd.write("mvhd", 4, "ascii")
  mvhd.writeUInt32BE(0, 8) // version 0 and flags
  mvhd.writeUInt32BE(1_000, 20) // timescale
  mvhd.writeUInt32BE(Math.round(seconds * 1_000), 24) // duration
  mvhd.writeUInt32BE(mvhd.length, 0)
  const moov = Buffer.alloc(8)
  moov.writeUInt32BE(8 + mvhd.length, 0)
  moov.write("moov", 4, "ascii")
  const ftyp = Buffer.alloc(20)
  ftyp.writeUInt32BE(20, 0)
  ftyp.write("ftyp", 4, "ascii")
  ftyp.write("isom", 8, "ascii")
  ftyp.write("isomM4A ", 12, "ascii")
  const audio = Buffer.alloc(Math.max(0, Math.round(seconds * bytesPerSecond)))
  const mdat = Buffer.alloc(8)
  mdat.writeUInt32BE(8 + audio.length, 0)
  mdat.write("mdat", 4, "ascii")
  return Buffer.concat([ftyp, mdat, audio, moov, mvhd])
}

/** A RIFF file whose chunk sizes do not walk: it is not measured, so it is not priced. */
export function brokenRiff(): Buffer {
  const wav = buildWav({ seconds: 1 })
  // The `fmt ` chunk claims a size that runs past the end of the file, so the walk cannot reach `data`.
  wav.writeUInt32LE(0xffff_fff0, 16)
  return wav
}
