# UX Report: generate_image Flow (MCP vs Fallback)

**Date:** 2026-02-26  
**Reporter:** User session (AI assistant relay)  
**Summary:** Request to use the MCP tool `generate_image` did not work as expected; fallback to CLI script succeeded but the flow did not feel smooth.

---

## What the user asked for

- Use **the MCP tool** `generate_image` to create a 768×768 product photo (matte pink headphones on wooden desk) and save to `assets/generated`.

---

## What actually happened

1. **Tool lookup**  
   The assistant looked for the `generate_image` tool in the MCP tool descriptors. The project’s MCP server (`ai-image`) is **not** present in the workspace MCP cache (only `cursor-ide-browser` and `user-puppeteer` are). The tool schema was inferred from the project source (`src/index.ts`) instead of an MCP descriptor.

2. **MCP call failed**  
   `call_mcp_tool(server: "ai-image", toolName: "generate_image", …)` was attempted.  
   **Error:** `MCP server does not exist: ai-image. Available servers: user-puppeteer, cursor-ide-browser`

3. **Fallback**  
   The assistant ran the project’s script instead:
   - `npm run build`
   - `node scripts/run-generate.mjs --prompt "..." --width 768 --height 768 --outputPath assets/generated`
   Generation succeeded and the image was saved under `assets/generated`.

---

## Why it didn’t feel smooth

| Issue | Impact |
|-------|--------|
| **MCP server not available** | User asked to use “the MCP tool”; the tool was not callable in that session, so the request could not be fulfilled as stated. |
| **No upfront visibility** | There was no clear indication that `ai-image` was missing until the MCP call failed. |
| **Different code path** | Fallback used the CLI script, not the MCP tool—same backend, but different entry point and no MCP response (e.g. inline image in chat). |
| **Setup ambiguity** | It’s unclear whether the user is expected to enable `ai-image` in Cursor MCP settings; only an example config (`.cursor/mcp.json.example`) exists. |

---

## Recommendations for the developer

1. **Document MCP setup**  
   In README (and optionally in `.cursorrules`), state that the **MCP tool** `generate_image` requires the `ai-image` server to be added to Cursor’s MCP config (e.g. from `.cursor/mcp.json.example`) and Cursor restarted. Clarify that without this, only the CLI script path is available.

2. **Expose tool schema for discovery**  
   If Cursor or other clients discover tools from the workspace `mcps/` folder, consider adding a descriptor for `generate_image` (e.g. under an `ai-image` server folder) so the tool is discoverable and the assistant doesn’t have to infer the schema from source.

3. **Graceful degradation**  
   If the codebase can detect “MCP not configured” (e.g. when the server is never registered), consider a clear error or doc link so the assistant can suggest the CLI fallback and setup steps instead of a generic “server does not exist” outcome.

4. **Unify experience**  
   Ensure the script and MCP tool share the same defaults (e.g. both use `http://127.0.0.1:8188` by default, or both require explicit `.env` values) so behavior is consistent regardless of entry point.

---

## Technical details (for debugging)

- **Successful run:** `node scripts/run-generate.mjs --prompt "product photo of matte pink headphones on a wooden desk" --width 768 --height 768 --outputPath assets/generated`
- **Output file:** `assets/generated/product-photo-of-matte-pink-headphones-on-a-wood-2026-02-26T01-38-42-928Z.png`
- **MCP config example:** `.cursor/mcp.json.example` references `ai-image` with `node dist/index.js` and env vars.
