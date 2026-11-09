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
const fmtBody = (size: 16 | 18 | 40) => {
  const body = Buffer.alloc(size)
  body.writeUInt16LE(size === 40 ? 0xfffe : 1, 0) // PCM, or WAVE_FORMAT_EXTENSIBLE
  body.writeUInt16LE(1, 2) // channels
  body.writeUInt32LE(BYTE_RATE, 4) // sample rate
  body.writeUInt32LE(BYTE_RATE, 8) // byte rate
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
    chunk("fmt ", fmtBody(options.fmtSize ?? 16)),
    data,
    body,
  ]
  const rest = Buffer.concat(parts)
  const riff = Buffer.alloc(12)
  riff.write("RIFF", 0, "ascii")
  riff.writeUInt32LE(rest.length + 4, 4)
  riff.write("WAVE", 8, "ascii")
  return Buffer.concat([riff, rest])
}

/** The six layouts RR2-1 names, each holding sixty seconds of audio unless its name says otherwise. */
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
} as const

/** A RIFF file whose chunk sizes do not walk: it is not measured, so it is not priced. */
export function brokenRiff(): Buffer {
  const wav = buildWav({ seconds: 1 })
  // The `fmt ` chunk claims a size that runs past the end of the file, so the walk cannot reach `data`.
  wav.writeUInt32LE(0xffff_fff0, 16)
  return wav
}
