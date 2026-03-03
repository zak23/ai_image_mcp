import fs from "node:fs/promises";
import path from "node:path";
import { GenerationResult, WorkflowJson, ComfyImageRef } from "./types.js";
import { nowMs, randomSeed, sleep } from "./util.js";

type GenerateParams = {
  baseUrl: string;
  workflowPath: string;
  prompt: string;
  width: number;
  height: number;
  seed?: number;
  timeoutMs: number;
  pollIntervalMs: number;
  filenamePrefix: string;
};

type PromptResponse = {
  prompt_id: string;
  node_errors?: Record<string, unknown>;
};

export async function generateWithComfy(params: GenerateParams): Promise<GenerationResult> {
  const start = nowMs();
  const seed = params.seed ?? randomSeed();
  const workflow = await loadAndPatchWorkflow(params.workflowPath, {
    prompt: params.prompt,
    width: params.width,
    height: params.height,
    seed,
    filenamePrefix: params.filenamePrefix
  });

  const promptRes = await fetchJson<PromptResponse>(`${params.baseUrl}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: workflow })
  });

  if (!promptRes?.prompt_id) {
    throw new Error("ComfyUI did not return a prompt_id");
  }

  if (promptRes.node_errors && Object.keys(promptRes.node_errors).length > 0) {
    throw new Error(`ComfyUI node_errors: ${JSON.stringify(promptRes.node_errors)}`);
  }

  const imageRef = await waitForImageOutput(params.baseUrl, promptRes.prompt_id, params.timeoutMs, params.pollIntervalMs);
  const buffer = await fetchImage(params.baseUrl, imageRef);

  return {
    filename: imageRef.filename,
    mimeType: detectMimeType(imageRef.filename),
    buffer,
    seed,
    width: params.width,
    height: params.height,
    durationMs: nowMs() - start,
    comfyPromptId: promptRes.prompt_id
  };
}

async function loadAndPatchWorkflow(
  workflowPath: string,
  values: { prompt: string; width: number; height: number; seed: number; filenamePrefix: string }
): Promise<WorkflowJson> {
  const raw = await fs.readFile(workflowPath, "utf8");
  const workflow = JSON.parse(raw) as WorkflowJson;

  setNodeInput(workflow, "45", "text", values.prompt);
  setNodeInput(workflow, "41", "width", values.width);
  setNodeInput(workflow, "41", "height", values.height);
  setNodeInput(workflow, "44", "seed", values.seed);
  setNodeInput(workflow, "9", "filename_prefix", values.filenamePrefix);

  return workflow;
}

function setNodeInput(workflow: WorkflowJson, nodeId: string, key: string, value: unknown): void {
  const node = workflow[nodeId];
  if (!node || typeof node !== "object") {
    throw new Error(`Workflow node ${nodeId} not found`);
  }
  if (!node.inputs || typeof node.inputs !== "object") {
    throw new Error(`Workflow node ${nodeId} has no inputs`);
  }
  node.inputs[key] = value;
}

async function waitForImageOutput(
  baseUrl: string,
  promptId: string,
  timeoutMs: number,
  pollIntervalMs: number
): Promise<ComfyImageRef> {
  const deadline = nowMs() + timeoutMs;
  let lastHistory: Record<string, unknown> | undefined;

  while (nowMs() < deadline) {
    const historyById = await fetchJson<Record<string, unknown>>(`${baseUrl}/history/${promptId}`);
    lastHistory = historyById;
    const imageRef =
      extractImageFromHistory(historyById, promptId) ??
      extractImageFromHistoryDirect(historyById);
    if (imageRef) {
      return imageRef;
    }
    await sleep(pollIntervalMs);
  }

  const diag = summarizeHistoryForTimeout(lastHistory, promptId);
  throw new Error(`Timed out waiting for ComfyUI output for prompt_id=${promptId}. ${diag}`);
}

function extractImageFromHistory(history: Record<string, unknown>, promptId: string): ComfyImageRef | null {
  const root = (history as Record<string, unknown>)[promptId] as Record<string, unknown> | undefined;
  if (!root) {
    return null;
  }
  return extractImageFromHistoryDirect(root);
}

function extractImageFromHistoryDirect(root: Record<string, unknown>): ComfyImageRef | null {
  const outputs = root.outputs as Record<string, unknown> | undefined;
  if (!outputs) return null;

  for (const nodeOut of Object.values(outputs)) {
    if (!nodeOut || typeof nodeOut !== "object") continue;
    const images = (nodeOut as Record<string, unknown>).images as unknown[] | undefined;
    if (!Array.isArray(images) || images.length === 0) continue;
    const first = images[0] as Record<string, unknown>;
    if (typeof first?.filename !== "string") continue;
    return {
      filename: first.filename,
      subfolder: typeof first.subfolder === "string" ? first.subfolder : "",
      type: typeof first.type === "string" ? first.type : "output"
    };
  }

  return null;
}

function summarizeHistoryForTimeout(history: Record<string, unknown> | undefined, promptId: string): string {
  if (!history) {
    return "No /history response was captured.";
  }

  const root =
    ((history as Record<string, unknown>)[promptId] as Record<string, unknown> | undefined) ??
    history;

  const status = root?.status as Record<string, unknown> | undefined;
  const statusStr = safeJson(status);
  const outputs = root?.outputs as Record<string, unknown> | undefined;
  const outputNodes = outputs ? Object.keys(outputs).length : 0;
  const promptMeta = root?.prompt as unknown;

  return [
    `history_keys=${Object.keys(history).slice(0, 8).join(",") || "(none)"}`,
    `output_nodes=${outputNodes}`,
    `status=${statusStr}`,
    `has_prompt=${promptMeta ? "yes" : "no"}`
  ].join(" ");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

async function fetchImage(baseUrl: string, image: ComfyImageRef): Promise<Buffer> {
  const url = new URL(`${baseUrl}/view`);
  url.searchParams.set("filename", image.filename);
  url.searchParams.set("subfolder", image.subfolder ?? "");
  url.searchParams.set("type", image.type ?? "output");

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`ComfyUI image fetch failed: ${res.status} ${res.statusText}`);
  }
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

function detectMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ComfyUI request failed (${res.status} ${res.statusText}) ${text}`.trim());
  }
  return (await res.json()) as T;
}
