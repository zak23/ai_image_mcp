export type WorkflowJson = Record<string, {
  inputs?: Record<string, unknown>;
  class_type?: string;
  _meta?: Record<string, unknown>;
}>;

export type ComfyImageRef = {
  filename: string;
  subfolder?: string;
  type?: string;
};

export type GenerationResult = {
  filename: string;
  mimeType: string;
  buffer: Buffer;
  seed: number;
  width: number;
  height: number;
  durationMs: number;
  comfyPromptId: string;
};
