import type { Plugin } from "@opencode/plugin"
import { elevenlabsError } from "../constants.js"
import { expandRoot } from "./policy.js"
import { saveMedia, savedText, type SaveDeps } from "./save.js"

/** The tool's id is `<namespace>_<name>`, the same shape as the MCP tools beside it. */
export const SAVE_NAME = "save_media"
export const SAVE_ACTION = "elevenlabs_save_media"

/** Everything the tool needs that setup knows: where to write, how much, and which hosts a link may name. */
export interface SaveToolInput extends SaveDeps {
  readonly root: string
  readonly assert: Plugin.Context["permission"]["assert"]
}

export const SAVE_SCHEMA = {
  type: "object",
  properties: {
    url: {
      type: "string",
      description: "The signed link a generation returned, on elevenlabsusercontent.com. It expires about two hours after the generation.",
    },
    name: { type: "string", description: "The file name to write. The extension is taken from the file's type when the name has none." },
    overwrite: { type: "boolean", description: "Replace a file of that name that is already there. Off by default." },
  },
  required: ["url"],
  additionalProperties: false,
} as const

export const SAVE_OUTPUT = {
  type: "object",
  required: ["path", "bytes", "sha256", "mime"],
  properties: {
    path: { type: "string" },
    bytes: { type: "integer", minimum: 0 },
    sha256: { type: "string" },
    mime: { type: "string" },
    durationSeconds: { type: "number" },
  },
} as const

export function saveDescription(root: string) {
  return `Save a generated ElevenLabs file to disk from the signed link a generation returned, and report its path, size, sha256 and, when the file states one, its duration. Files are written under ${root}. The link expires in about two hours; this is how a result is kept. The file never enters the conversation: no bytes are returned, only the path. The first save writes outside the project, so OpenCode asks once for the "external_directory" rule as well as the plugin's own permission.`
}

/** A call's source, exactly as the host gives it to `execute`. */
export interface CallSource {
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
  readonly id: string
}

export interface ToolResult {
  readonly output: Record<string, unknown>
  readonly text: string
}

/**
 * Runs the tool. It writes a file, so it asserts its own permission before it fetches anything: the host's declaration
 * only hides a denied action, and a decline here must reach no network and touch no disk. It then asserts the host's
 * `external_directory` rule for the media folder, because the folder is outside the project (R19, DR-8).
 */
export async function runSaveMedia(input: SaveToolInput, raw: unknown, call: CallSource): Promise<ToolResult> {
  const source = { type: "tool" as const, messageID: call.messageID, id: call.id }
  await input.assert({ sessionID: call.sessionID, agent: call.agent, action: SAVE_ACTION, resources: ["*"], source })
  const folder = expandRoot(input.root)
  try {
    await input.assert({ sessionID: call.sessionID, agent: call.agent, action: "external_directory", resources: [`${folder}/*`], source })
  } catch (error) {
    // The host asks for two rules; this one is the path confinement, and its next step names the exact rule to add.
    if (error instanceof Error && error.name === "Permission.DeclinedError") throw error
    throw elevenlabsError(
      "EXTERNAL_DIRECTORY_DENIED",
      `Writing under ${folder} needs OpenCode's external_directory rule, which this session does not allow.`,
      `Allow { "action": "external_directory", "resource": "${folder}/*", "effect": "allow" } in this agent's permissions or in permissions, then save again.`,
    )
  }
  const args = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>
  const url = args.url
  if (typeof url !== "string" || url.trim() === "") {
    throw elevenlabsError("MEDIA_URL_INVALID", "No link was given to save.", "Pass the link a generation returned, such as one on elevenlabsusercontent.com.")
  }
  const name = typeof args.name === "string" && args.name.trim() !== "" ? args.name : undefined
  const saved = await saveMedia(
    { url, ...(name === undefined ? {} : { name }) },
    { ...input, ...(args.overwrite === true ? { overwrite: true } : {}) },
  )
  return { output: { ...saved }, text: savedText(saved) }
}

/**
 * Adds the tool to the `elevenlabs` namespace, beside the server's own. The namespace description is set by the caller,
 * once, so a server that is someone else's does not get this plugin's text.
 */
export function addSaveTool(input: SaveToolInput) {
  return (editor: Parameters<Parameters<Plugin.Context["tool"]["transform"]>[0]>[0]) => {
    editor.add({
      name: SAVE_NAME,
      description: saveDescription(input.root),
      input: SAVE_SCHEMA,
      output: SAVE_OUTPUT,
      options: { namespace: "elevenlabs", permission: SAVE_ACTION },
      execute: async (value: unknown, context) => {
        const result = await runSaveMedia(input, value, {
          sessionID: context.sessionID,
          agent: context.agent,
          messageID: context.messageID,
          id: context.id,
        })
        return { output: result.output, content: result.text }
      },
    })
  }
}
