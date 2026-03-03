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

type QueuePhase = "pending" | "running" | "not_found";

type QueueInfo = {
  phase: QueuePhase;
  position: number | null; // 0-based position in pending queue, null if running/not_found
};

async function waitForImageOutput(
  baseUrl: string,
  promptId: string,
  timeoutMs: number,
  pollIntervalMs: number
): Promise<ComfyImageRef> {
  // Absolute hard cap to avoid infinite waits even if the job stays queued forever.
  const absoluteDeadline = nowMs() + timeoutMs;

  // How long we allow the job to be invisible in BOTH history and queue before
  // giving up. This covers truly lost/errored jobs without penalising slow
  // model loads or deep queues.
  const notFoundGracePeriodMs = Math.min(120_000, timeoutMs);
  let notFoundSince: number | null = null;

  let lastHistory: Record<string, unknown> | undefined;
  let lastQueueInfo: QueueInfo = { phase: "not_found", position: null };
  let lastLoggedPhase: string | null = null;
  let lastLoggedPosition: number | null = -1;

  while (nowMs() < absoluteDeadline) {
    // --- Check history (fast path: job already completed) ---
    const historyById = await fetchJson<Record<string, unknown>>(`${baseUrl}/history/${promptId}`).catch(
      () => ({}) as Record<string, unknown>
    );
    lastHistory = historyById;
    const imageRef =
      extractImageFromHistory(historyById, promptId) ??
      extractImageFromHistoryDirect(historyById);
    if (imageRef) return imageRef;

    // --- Check queue ---
    const queueInfo = await checkQueueStatus(baseUrl, promptId);
    lastQueueInfo = queueInfo;

    if (queueInfo.phase !== "not_found") {
      // Job is visible — reset the not-found grace timer and log status changes.
      notFoundSince = null;
      const positionChanged = queueInfo.position !== lastLoggedPosition;
      const phaseChanged = queueInfo.phase !== lastLoggedPhase;
      if (phaseChanged || positionChanged) {
        if (queueInfo.phase === "pending") {
          console.error(
            `[ai-image-mcp] prompt_id=${promptId} queued at position ${queueInfo.position} — waiting for earlier jobs to finish...`
          );
        } else {
          console.error(`[ai-image-mcp] prompt_id=${promptId} running — generating image (model load may take a while on first run)...`);
        }
        lastLoggedPhase = queueInfo.phase;
        lastLoggedPosition = queueInfo.position;
      }
    } else {
      // Job not visible anywhere yet — start / maintain grace timer.
      if (notFoundSince === null) notFoundSince = nowMs();
      const notFoundMs = nowMs() - notFoundSince;
      if (notFoundMs >= notFoundGracePeriodMs) {
        const diag = summarizeHistoryForTimeout(lastHistory, promptId);
        throw new Error(
          `ComfyUI job prompt_id=${promptId} disappeared from both queue and history after ${Math.round(notFoundMs / 1000)}s. ${diag}`
        );
      }
    }

    await sleep(pollIntervalMs);
  }

  const elapsed = Math.round((nowMs() - (absoluteDeadline - timeoutMs)) / 1000);
  const diag = summarizeHistoryForTimeout(lastHistory, promptId);
  const queueDiag =
    lastQueueInfo.phase !== "not_found"
      ? ` Job was still ${lastQueueInfo.phase}${lastQueueInfo.position !== null ? ` at position ${lastQueueInfo.position}` : ""} when timeout fired — consider increasing AI_IMAGE_TIMEOUT_MS.`
      : "";
  throw new Error(
    `Timed out after ${elapsed}s waiting for ComfyUI output for prompt_id=${promptId}.${queueDiag} ${diag}`
  );
}

async function checkQueueStatus(baseUrl: string, promptId: string): Promise<QueueInfo> {
  type QueueResponse = {
    queue_running: unknown[][];
    queue_pending: unknown[][];
  };

  let queue: QueueResponse;
  try {
    queue = await fetchJson<QueueResponse>(`${baseUrl}/queue`);
  } catch {
    return { phase: "not_found", position: null };
  }

  // queue_running entries: [number, promptId, ...]
  for (const entry of queue.queue_running ?? []) {
    if (Array.isArray(entry) && entry[1] === promptId) {
      return { phase: "running", position: null };
    }
  }

  // queue_pending entries: [number, promptId, ...] ordered front-to-back
  const pending = queue.queue_pending ?? [];
  for (let i = 0; i < pending.length; i++) {
    const entry = pending[i];
    if (Array.isArray(entry) && entry[1] === promptId) {
      return { phase: "pending", position: i };
    }
  }

  return { phase: "not_found", position: null };
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
