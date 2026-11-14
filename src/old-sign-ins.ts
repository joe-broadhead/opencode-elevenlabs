import { createHash } from "node:crypto"
import type { Plugin } from "@opencode/plugin"
import { oldSignInName, REGIONS, REGION_VALUES, SERVER_NAME, type Region } from "./constants.js"

/**
 * A sign-in stored for a region this plugin no longer uses. OpenCode keys a remote MCP server's credential by the
 * server's name and URL, so after `region` changes the old region's sign-in stays in OpenCode's store, unused, under
 * an integration nothing registers any more: `/connect` does not list it and `opencode auth logout` cannot find it.
 *
 * A plugin cannot delete a stored credential (the host gives plugins `credential.activate` only), so the plugin does
 * the rest: it finds each one, registers its integration under a name that says what it is, so `/connect` and
 * `opencode auth logout` list it and can remove it, and status names it with the command that removes it.
 */
export interface OldSignIn {
  readonly region: Region
  /** OpenCode's integration id for this server name at that region's URL. */
  readonly integrationID: string
}

/**
 * OpenCode's integration id for a remote MCP server: `mcp_` and the first 16 hex digits of sha1(name, NUL, url). The
 * host computes it the same way when it registers the server; a host test holds the two together.
 */
export const serverIntegrationID = (name: string, url: string) =>
  `mcp_${createHash("sha1").update(`${name}\u0000${url}`).digest("hex").slice(0, 16)}`

/** Every other region whose sign-in is still stored. A lookup that fails counts as none: this is advice. */
export async function findOldSignIns(
  integration: { readonly connection: Pick<Plugin.Context["integration"]["connection"], "active"> },
  region: Region,
): Promise<OldSignIn[]> {
  const others = REGION_VALUES.filter((other) => other !== region)
  const found = await Promise.all(
    others.map(async (other) => {
      const integrationID = serverIntegrationID(SERVER_NAME, REGIONS[other])
      const connection = await integration.connection.active(integrationID).catch(() => undefined)
      return connection?.type === "credential" ? [{ region: other, integrationID }] : []
    }),
  )
  return found.flat()
}

/**
 * Lists each old sign-in in `/connect` under `oldSignInName`, so it can be signed out of there or with
 * `opencode auth logout`. Only the ones found at setup are registered; once removed, the next start registers nothing.
 */
export function registerOldSignIns(integration: Pick<Plugin.Context["integration"], "transform">, signIns: readonly OldSignIn[]) {
  return integration.transform((editor) => {
    for (const signIn of signIns) editor.update(signIn.integrationID, (draft) => void (draft.name = oldSignInName(signIn.region)))
  })
}
