# AI Image MCP (Cursor + ComfyUI)

MCP server that lets Cursor generate images through a self-hosted ComfyUI workflow.

It:
- accepts a text prompt (+ optional size/seed/path args)
- submits the prompt to ComfyUI via its REST API
- polls both the queue **and** history, waiting through model loads, queued jobs, and cold starts
- saves the image to disk
- returns structured metadata and optional base64/image payloads

## What You Get

- MCP tools: `generate_image`, `create_image`, `make_image`, `quick_image`, `image_from_prompt`
- Self-hosted pipeline (your ComfyUI instance, your workflow)
- Works in Cursor chats once the MCP server is enabled
- CLI smoke-test script for local verification without Cursor

## Requirements

- Node.js 18+
- **ComfyUI** installed and running (locally or on another machine you can reach)
- A **workflow** exported as JSON and saved in this project, with `src/comfy.ts` updated to patch the right node IDs for your workflow (see below)

## ComfyUI and workflow

You need ComfyUI installed and running. The MCP talks to it over HTTP (default `http://127.0.0.1:8188` or the URL in your `.env`).

**Workflow setup:**

1. **Choose or build a workflow** in ComfyUI (e.g. a text-to-image graph with a prompt node, size, seed, and a Save Image node).
2. **Export it as JSON** (in ComfyUI: save/export the workflow in API format) and **save the file into this project directory** (e.g. `image_workflow.json` or `image_z_image_turbo.json`).
3. **Wire it up in code** — everyone’s setup is different (models, node IDs, node types). The server patches specific node IDs to inject prompt, width, height, seed, and filename. **Ask Cursor to implement it:** e.g. “Update `src/comfy.ts` to patch the correct node IDs for my workflow” and point to your JSON. The code currently expects the node IDs listed in [Workflow Node IDs](#workflow-node-ids).

**Included workflow:** This repo includes a basic **Z Image Turbo** workflow (`image_workflow.json`; symlinked as `image_z_image_turbo.json`). It works out of the box with the node IDs already in `src/comfy.ts`. Use it as-is, or replace it with your own JSON and have Cursor update the patch logic to match your nodes.

## Quick Start

```bash
npm install
npm run build
cp .env.example .env
# Edit .env — set COMFYUI_BASE_URL to your ComfyUI machine's IP/port
```

1. Add the ai-image server to your Cursor MCP config (Cursor Settings → MCP → Edit config, or `~/.cursor/mcp.json`). Inside the `"mcpServers"` object, add:

```json
"ai-image": {
  "command": "node",
  "args": [
    "/path/where/you/saved/this/repo/dist/index.js"
  ]
}
```

   Change the path in `args` to where you’ve saved this repo — e.g. `/home/you/projects/ai_image_mcp/dist/index.js`. The server loads `COMFYUI_BASE_URL` and other options from this repo’s `.env`; no `env` block in mcp.json is required. To override for Cursor only, add an `"env": { "COMFYUI_BASE_URL": "http://..." }` block.
2. Fully restart Cursor and open a new chat.
3. Ask the agent to call `generate_image` (or any alias).

> **Important:** `COMFYUI_BASE_URL` must point at the correct IP/host. The default is
> `http://127.0.0.1:8188`. If ComfyUI runs on a different machine set it explicitly in `.env`
> (e.g. `http://your-comfyui-host:8188`). A wrong host/IP causes jobs to silently time out — ComfyUI
> accepts the prompt and returns a `prompt_id`, but the job never appears in history if the
> target machine is resource-starved or unreachable.

## How to Use

**In Cursor:** With the ai-image MCP server enabled, ask in plain language. The agent will call the tool for you.

Examples of what to say:
- *"Generate an image of a cat in a hat"*
- *"Use quick_image to get a photo of a sunset over mountains"*
- *"Create an image: cozy coffee shop interior, warm lighting, 768x768"*

**Tool names** (all do the same thing; pick any):
- `quick_image` — fast default (saves file, no base64 in response unless you ask)
- `generate_image`, `create_image`, `make_image`, `image_from_prompt` — full options, base64 returned by default

**What you get:**
- Image saved under `assets/generated/` (or your `AI_IMAGE_OUTPUT_DIR` / `outputPath`)
- Filename is a slug of the prompt plus a timestamp (e.g. `a-cat-in-a-hat-2026-03-03T00-03-41-671Z.png`)
- In chat you get the saved path, dimensions, seed, and duration; with `returnBase64: true` you also get the image inline

**Optional args** (when the agent uses the tool): `width`, `height`, `seed`, `filename`, `outputPath`, `copyToPath`, `returnBase64`. See [Tool Schema](#tool-schema) for details.

**Without Cursor / MCP:** Use the smoke script — see [Smoke Test](#smoke-test-no-cursor-required) below.

### Global Cursor rule (optional)

So the agent uses this MCP whenever it needs to generate an image (in any project), add a **global** rule: **Cursor Settings → General → Rules for AI**, then add something like:

```text
When you need to generate or create an image, use the ai-image MCP first if it's available: call generate_image, quick_image, create_image, make_image, or image_from_prompt with the user's prompt. Don't suggest external services or placeholder images when the ai-image server is enabled.
```

That way Cursor will prefer your ComfyUI pipeline over other options when the MCP is enabled.

## Smoke Test (No Cursor Required)

```bash
npm run smoke -- --prompt "minimal product photo of matte black headphones on a wooden desk" --width 768 --height 768 --outputPath assets/generated
```

`--outputPath` must resolve inside this repo when `AI_IMAGE_ALLOW_EXTERNAL_OUTPUT` is not set.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `COMFYUI_BASE_URL` | `http://127.0.0.1:8188` | ComfyUI REST API base URL |
| `COMFYUI_WORKFLOW_PATH` | `./image_z_image_turbo.json` | Path to workflow JSON (relative to repo root or absolute) |
| `AI_IMAGE_OUTPUT_DIR` | `./assets/generated` | Where generated images are saved (relative to repo root or absolute) |
| `AI_IMAGE_TIMEOUT_MS` | `600000` | Absolute hard cap (ms) for a single generation. The server also applies a 120 s "not-found grace period" — if the job disappears from both queue and history for 120 s it fails early. Raise this value if you have a very deep queue. |
| `AI_IMAGE_POLL_INTERVAL_MS` | `800` | How often to poll `/queue` and `/history` |
| `AI_IMAGE_AUTO_COPY_TO_WORKSPACE` | `1` | Set `0` to disable auto-copy into caller workspace |
| `AI_IMAGE_ALLOW_EXTERNAL_OUTPUT` | `1` | Set `0` to force `outputPath` inside repo only |

## Tool Schema

All aliases share the same input schema:

| Argument | Type | Description |
|---|---|---|
| `prompt` | string (required) | Text prompt |
| `width` | integer | Output width (default 1024, max 1024, rounded to multiple of 64) |
| `height` | integer | Output height (same rules as width) |
| `seed` | integer | Optional fixed seed |
| `filename` | string | Output filename (`.png` appended if no extension) |
| `outputPath` | string | Directory or file path override for saved image |
| `copyToPath` | string | Additional copy target (absolute or workspace-relative) |
| `workingDirectory` / `cwd` | string | Base for resolving relative `copyToPath` |
| `returnBase64` | boolean | Include base64 in response (default `true`; `quick_image` defaults `false`) |

Return shape includes: `success`, `prompt`, `filename`, `savedPath`, `mimeType`, `seed`, `width`,
`height`, `durationMs`, `comfyPromptId`, `copiedToPath`, `workspaceCwdUsedForCopy`, and optionally
`base64` + MCP `image` content block.

## Workflow Node IDs

The following node IDs are hardcoded in `src/comfy.ts` for the **included Z Image Turbo workflow**. If you use a different workflow JSON, ask Cursor to update `src/comfy.ts` so the patched node IDs and field names match your graph:

| Node ID | Field patched | Purpose |
|---|---|---|
| `45` | `text` | CLIP text prompt |
| `41` | `width`, `height` | Latent image dimensions |
| `44` | `seed` | KSampler seed |
| `9` | `filename_prefix` | SaveImage output prefix |

## Troubleshooting

**`MCP server does not exist: ai-image`**
Cursor isn't loading your MCP config. Fully restart Cursor (not just reload window).

**Tools don't appear in chat**
Run `npm run build` and verify the `dist/index.js` path in your MCP config is correct.

**Generation timed out**
The server will log queue position and running state as it polls, e.g.:
```
[ai-image-mcp] prompt_id=… queued at position 2 — waiting for earlier jobs to finish...
[ai-image-mcp] prompt_id=… running — generating image (model load may take a while on first run)...
```
If it times out anyway, check:
- `COMFYUI_BASE_URL` points to the right machine
- That machine has sufficient free VRAM/RAM to load the model
- ComfyUI logs on the server side for errors
- Raise `AI_IMAGE_TIMEOUT_MS` (default `600000` = 10 min) if you have an unusually deep queue or a very large model

The server uses a two-phase wait: it keeps polling as long as the job is visible in the ComfyUI queue (pending or running), and only applies the hard timeout. This means cold-start model loads and queued jobs behind other requests are handled automatically.

**Unexpected output dimensions**
Width/height are rounded to the nearest multiple of 64 and clamped to 1024 max.

## Content Policy

This MCP server does not enforce content filtering. Prompt policy is determined entirely by your local ComfyUI setup.

## Tests

```bash
npm test
```

Validates utility functions (`slugify`, `makeFilename`, `isPathInside`) and input schema parsing. No ComfyUI integration tests.

## Notes

- `assets/` is gitignored — generated images are not committed.
- `package.json` is marked `"private": true`.

---
