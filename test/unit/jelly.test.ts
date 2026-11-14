import { describe, expect, test } from "bun:test"
import { BALANCE_NAME } from "../../src/balance.js"
import { DISPLAY_NAME, REGION_VALUES, SERVER_NAME } from "../../src/constants.js"
import { ALL_TOOLS, EXPORT_TOOLS, OWN_TOOLS, READ_TOOLS, SPEND_TOOLS, WRITE_TOOLS, DESTRUCTIVE_TOOLS } from "../../src/elevenlabs-tools.js"
import { DEFAULT_MEDIA_BYTES, parseOptions } from "../../src/options.js"
import { defaultRules, evaluate, type Rule } from "../../src/permissions.js"
import { type Declaration, type DeclaredTool, declarationProblems, docProblems, readPackage } from "../support/jelly-kit.js"
import { ACCESS_CHOICES, settingChoices, type PluginSetting, settingsProblems, settingValueIssue } from "../support/jelly-settings.js"

/**
 * The `jelly` section of package.json, which Jelly reads without loading the plugin. Jelly writes each declared effect
 * as that tool's default (its agents have no base allow rule, so this plugin's own rules never reach them), so each
 * declared effect must be what the default rules give the tool in OpenCode. The shared kit checks the declaration
 * against Jelly's plugin authors' standard; the tests below add what only ElevenLabs declares.
 */

const ROOT = new URL("../../", import.meta.url)
const pkg = readPackage(ROOT)
const jelly = pkg.jelly as Declaration & { title: string; tools: DeclaredTool[]; rpc: unknown[]; views: unknown[]; contributes: { homeFeeds: unknown[]; homeWidgets: unknown[]; workKinds: unknown[]; settings: PluginSetting[] } }
const { settings } = jelly.contributes
const byPermission = new Map(jelly.tools.map((tool) => [tool.permission, tool]))
const BASE_ALLOW: Rule = { action: "*", resource: "*", effect: "allow" }

describe("the jelly declaration", () => {
  test("follows the plugin authors' standard, with the effects the plugin's own default rules give", () => {
    expect(declarationProblems(ROOT, { effectOf: (permission) => evaluate([BASE_ALLOW, ...defaultRules()], permission) })).toEqual([])
  })

  test("declares every tool as allowed, reads first, then the rest in the table's order", () => {
    for (const tool of READ_TOOLS) expect(byPermission.get(`elevenlabs_${tool}`)).toMatchObject({ effect: "allow", readOnly: true })
    // Every tool is allowed by default, so Jelly's declaration allows the billed and destructive tools too.
    for (const tool of [...EXPORT_TOOLS, ...WRITE_TOOLS, ...SPEND_TOOLS, ...DESTRUCTIVE_TOOLS]) expect(byPermission.get(`elevenlabs_${tool}`)).toMatchObject({ effect: "allow", readOnly: false })
    for (const tool of OWN_TOOLS) expect(byPermission.get(`elevenlabs_${tool}`)).toMatchObject({ effect: "allow", readOnly: false })
    expect(jelly.tools.map((tool) => tool.permission)).toEqual([...READ_TOOLS, ...ALL_TOOLS.filter((tool) => !READ_TOOLS.includes(tool)), ...OWN_TOOLS].map((tool) => `elevenlabs_${tool}`))
  })

  test("has no views, RPC or Home contributions, and two sign-ins: the elevenlabs server, and the optional balance key", () => {
    expect(jelly.title).toBe(DISPLAY_NAME)
    expect(jelly.rpc).toEqual([])
    expect(jelly.views).toEqual([])
    expect(jelly.contributes).toEqual({ homeFeeds: [], homeWidgets: [], workKinds: [], settings: expect.any(Array) })
    expect(jelly.signIns as unknown[]).toEqual([
      // ElevenLabs registers no clients and takes a client metadata document as the client id, so a browser tab can
      // finish the sign-in through Jelly's relay.
      { id: SERVER_NAME, label: DISPLAY_NAME, server: SERVER_NAME, relay: {} },
      {
        id: "balance",
        label: BALANCE_NAME,
        integration: "elevenlabs-balance",
        required: false,
        help: { url: "https://elevenlabs.io/app/developers/api-keys", label: "Create an ElevenLabs API key" },
      },
    ])
    expect(jelly.skills).toEqual(["elevenlabs", "elevenlabs-creative", "elevenlabs-calls"])
  })
})

describe("the jelly settings", () => {
  const byKey = new Map(settings.map((setting) => [setting.key, setting]))
  const bare = (setting: PluginSetting) => ({ ...setting, description: undefined })

  test("follow Jelly's rules for a declared setting", () => {
    expect(settingsProblems(settings)).toEqual([])
  })

  // Each is a top-level option of the plugin, with the parser's own closed set, bounds and default.
  test("declare access, region and conversations as choices, and the caps and the file size as bounded numbers", () => {
    expect(settings.map(bare)).toEqual([
      { key: "access", label: "Access", type: "string", description: undefined, choices: ACCESS_CHOICES, default: "all" },
      {
        key: "region",
        label: "Region",
        type: "string",
        description: undefined,
        choices: [
          { value: "global", label: "Global", description: "api.elevenlabs.io, ElevenLabs' default." },
          { value: "us", label: "United States", description: "api.us.elevenlabs.io" },
          { value: "eu", label: "European Union", description: "api.eu.residency.elevenlabs.io" },
          { value: "in", label: "India", description: "api.in.residency.elevenlabs.io" },
          { value: "sg", label: "Singapore", description: "api.sg.residency.elevenlabs.io" },
        ],
        default: "global",
      },
      {
        key: "conversations",
        label: "Call transcripts",
        type: "string",
        description: undefined,
        choices: [
          { value: "full", label: "Full", description: "The conversation tools return calls, their summaries and their transcripts." },
          { value: "summary", label: "Metadata only", description: "Calls can be listed and counted. Their transcripts, summaries, messages and recordings are denied." },
          { value: "off", label: "Off", description: "Every conversation tool is denied, listing and counting included." },
        ],
        default: "full",
      },
      { key: "sessionCreditCap", label: "Credit cap per session", type: "number", description: undefined, integer: true, min: 1, max: 10_000_000 },
      { key: "dailyCreditCap", label: "Daily credit cap", type: "number", description: undefined, integer: true, min: 1, max: 10_000_000 },
      { key: "maxMediaBytes", label: "Largest saved file (bytes)", type: "number", description: undefined, integer: true, min: 1024, default: DEFAULT_MEDIA_BYTES },
    ])
    for (const setting of settings) expect(setting.description.length).toBeGreaterThan(0)
    expect((settingChoices(byKey.get("region")!) ?? []).map((choice) => choice.value)).toEqual([...REGION_VALUES])
  })

  test("each declared choice is one the options parser takes, the default its own, and a value outside them is refused", () => {
    for (const key of ["access", "region", "conversations"] as const) {
      const setting = byKey.get(key)!
      for (const { value } of settingChoices(setting) ?? []) expect<unknown>(parseOptions({ [key]: value })[key]).toBe(value)
      expect<unknown>(parseOptions({})[key]).toBe(setting.default)
      expect(settingValueIssue(setting, "other")).not.toBeNull()
      expect(() => parseOptions({ [key]: "other" })).toThrow("OPTIONS_INVALID")
    }
  })

  test("each number's bounds are the options parser's, and a cap left unset is no cap", () => {
    for (const key of ["sessionCreditCap", "dailyCreditCap", "maxMediaBytes"] as const) {
      const setting = byKey.get(key)!
      const { min } = setting as { min: number }
      expect(parseOptions({ [key]: min })[key]).toBe(min)
      expect(settingValueIssue(setting, min - 1)).not.toBeNull()
      expect(() => parseOptions({ [key]: min - 1 })).toThrow("OPTIONS_INVALID")
      expect(settingValueIssue(setting, min + 0.5)).not.toBeNull()
      expect(() => parseOptions({ [key]: min + 0.5 })).toThrow("OPTIONS_INVALID")
      if (setting.max === undefined) {
        // The parser has a floor and no ceiling, so the declaration has none either.
        expect(parseOptions({ [key]: Number.MAX_SAFE_INTEGER })[key]).toBe(Number.MAX_SAFE_INTEGER)
      } else {
        expect(parseOptions({ [key]: setting.max })[key]).toBe(setting.max)
        expect(settingValueIssue(setting, setting.max + 1)).not.toBeNull()
        expect(() => parseOptions({ [key]: setting.max! + 1 })).toThrow("OPTIONS_INVALID")
      }
      // Jelly saves no null: a cap means no cap by being unsaved, so it declares no default.
      expect<unknown>(parseOptions({})[key]).toBe(setting.default ?? null)
    }
  })
})

describe("docs/jelly.md", () => {
  test("follows the plugin authors' standard", () => {
    expect(docProblems(ROOT)).toEqual([])
  })
})
