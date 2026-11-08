import { describe, expect, test } from "bun:test"
import { DISPLAY_NAME, SERVER_NAME } from "../../src/constants.js"
import { ALL_TOOLS, EXPORT_TOOLS, OWN_TOOLS, READ_TOOLS, SPEND_TOOLS, WRITE_TOOLS, DESTRUCTIVE_TOOLS } from "../../src/elevenlabs-tools.js"
import { defaultRules, evaluate, type Rule } from "../../src/permissions.js"
import { type Declaration, type DeclaredTool, declarationProblems, docProblems, readPackage } from "../support/jelly-kit.js"

/**
 * The `jelly` section of package.json, which Jelly reads without loading the plugin. Jelly writes each declared effect
 * as that tool's default (its agents have no base allow rule, so this plugin's own rules never reach them), so each
 * declared effect must be what the default rules give the tool in OpenCode. The shared kit checks the declaration
 * against Jelly's plugin authors' standard; the tests below add what only ElevenLabs declares.
 */

const ROOT = new URL("../../", import.meta.url)
const pkg = readPackage(ROOT)
const jelly = pkg.jelly as Declaration & { title: string; tools: DeclaredTool[]; rpc: unknown[]; views: unknown[]; contributes: unknown }
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

  test("has no views, RPC or Home contributions, and one sign-in: the elevenlabs server", () => {
    expect(jelly.title).toBe(DISPLAY_NAME)
    expect(jelly.rpc).toEqual([])
    expect(jelly.views).toEqual([])
    expect(jelly.contributes).toEqual({ homeFeeds: [], homeWidgets: [], workKinds: [], settings: [] })
    expect(jelly.signIns).toEqual([{ id: SERVER_NAME, label: DISPLAY_NAME, server: SERVER_NAME }])
    expect(jelly.skills).toEqual(["elevenlabs", "elevenlabs-creative", "elevenlabs-calls"])
  })
})

describe("docs/jelly.md", () => {
  test("follows the plugin authors' standard", () => {
    expect(docProblems(ROOT)).toEqual([])
  })
})
