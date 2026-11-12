import { describe, expect, test } from "bun:test"
import { DEFAULT_MEDIA_BYTES, DEFAULT_MEDIA_ROOT, parseOptions, type ParsedOptions } from "../../src/options.js"

/** The options as a user writes none of them: every default, in one place, so a change shows in one line. */
const DEFAULTS: ParsedOptions = {
  allowUntestedHost: false,
  access: "all",
  region: "global",
  sessionCreditCap: 2000,
  dailyCreditCap: 10000,
  mediaRoot: "~/Downloads/elevenlabs",
  maxMediaBytes: 200 * 1024 * 1024,
  conversations: "full",
}

describe("parseOptions", () => {
  test("defaults to a supported host, every tool allowed, the global region and both caps on", () => {
    expect(parseOptions(undefined)).toEqual(DEFAULTS)
    expect(parseOptions(null)).toEqual(DEFAULTS)
    expect(parseOptions({})).toEqual(DEFAULTS)
    expect(DEFAULTS.mediaRoot).toBe(DEFAULT_MEDIA_ROOT)
    expect(DEFAULTS.maxMediaBytes).toBe(DEFAULT_MEDIA_BYTES)
  })

  test("accepts every documented value", () => {
    expect(parseOptions({ allowUntestedHost: true })).toEqual({ ...DEFAULTS, allowUntestedHost: true })
    for (const access of ["all", "ask-changes", "read-only"] as const) expect(parseOptions({ access })).toEqual({ ...DEFAULTS, access })
    for (const region of ["global", "us", "eu", "in", "sg"] as const) expect(parseOptions({ region })).toEqual({ ...DEFAULTS, region })
    for (const conversations of ["full", "summary", "off"] as const) expect(parseOptions({ conversations })).toEqual({ ...DEFAULTS, conversations })
    expect(parseOptions({ sessionCreditCap: null, dailyCreditCap: null })).toEqual({ ...DEFAULTS, sessionCreditCap: null, dailyCreditCap: null })
    expect(parseOptions({ sessionCreditCap: 5, dailyCreditCap: 10 })).toEqual({ ...DEFAULTS, sessionCreditCap: 5, dailyCreditCap: 10 })
    expect(parseOptions({ sessionCreditCap: undefined })).toEqual(DEFAULTS)
    expect(parseOptions({ mediaRoot: "/srv/media" })).toEqual({ ...DEFAULTS, mediaRoot: "/srv/media" })
    expect(parseOptions({ maxMediaBytes: 1024 })).toEqual({ ...DEFAULTS, maxMediaBytes: 1024 })
  })

  test.each([
    [{ account: "work" }, 'Unknown option "account". Accepted options: "allowUntestedHost", "access", "region", "sessionCreditCap", "dailyCreditCap", "mediaRoot", "maxMediaBytes", "conversations"'],
    [{ access: "write" }, 'The option "access" must be "all" (the default), "ask-changes" or "read-only", found "write"'],
    [{ access: 1 }, 'The option "access" must be "all" (the default), "ask-changes" or "read-only", found 1'],
    [{ region: "uk" }, 'The option "region" must be "global", "us", "eu", "in", "sg"; "global" is the default, found "uk"'],
    [{ allowUntestedHost: "yes" }, 'The option "allowUntestedHost" must be true or false (the default), found "yes"'],
    [{ allowUntestedHost: null }, 'The option "allowUntestedHost" must be true or false (the default), found null'],
    [{ conversations: "some" }, 'The option "conversations" must be "full" (the default), "summary" or "off", found "some"'],
    [{ mediaRoot: "" }, 'The option "mediaRoot" must be a path, with ~ for your home folder (the default is "~/Downloads/elevenlabs"), found ""'],
    [{ maxMediaBytes: 10 }, 'The option "maxMediaBytes" must be a whole number of bytes of at least 1024, found 10'],
    [{ sessionCreditCap: 0 }, 'The option "sessionCreditCap" must be a whole number of credits, or null for no cap (the default is 2000), found 0'],
    [{ dailyCreditCap: -1 }, 'The option "dailyCreditCap" must be a whole number of credits, or null for no cap (the default is 10000), found -1'],
    [{ dailyCreditCap: 20000000 }, 'The option "dailyCreditCap" must be at most 10000000 credits, found 20000000'],
    [{ dailyCreditCap: 1.5 }, 'The option "dailyCreditCap" must be a whole number of credits, or null for no cap (the default is 10000), found 1.5'],
    ["true", 'The plugin options must be an object, found "true"'],
    [[], "The plugin options must be an object, found an array"],
  ])("rejects %j with the key, the accepted values and an example", (input, problem) => {
    expect(() => parseOptions(input)).toThrow(problem)
    try {
      parseOptions(input)
    } catch (error) {
      const { message, code, nextStep } = error as Error & { code: string; nextStep: string }
      expect(code).toBe("OPTIONS_INVALID")
      expect(message.startsWith("OPTIONS_INVALID: ")).toBe(true)
      expect(nextStep).toContain(`"package": "github:joe-broadhead/opencode-elevenlabs#v0.0.1", "options": {`)
      expect(message.endsWith(`. Next step: ${nextStep}`)).toBe(true)
      expect(nextStep.endsWith(".")).toBe(true)
    }
  })
})
