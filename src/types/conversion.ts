export type OutputFormat = "png" | "jpeg" | "webp" | "bmp" | "gif" | "tiff" | "ico";
export type ResizeMode = "none" | "fit" | "exact";
export type ConvertFileStatus = "success" | "failed" | "skipped";
export type ConversionViewState = "idle" | "dragging" | "processing" | "completed" | "error";

export interface ResizeOptions {
  mode: ResizeMode;
  width: number | null;
  height: number | null;
  allowUpscale: boolean;
}

export interface ConvertBatchRequest {
  sources: string[];
  targetFormat: OutputFormat;
  outputDir: string | null;
  quality: number | null;
  resize: ResizeOptions;
  icoSize: number | null;
}

export interface ConvertFileResult {
  sourcePath: string;
  outputPath: string | null;
  status: ConvertFileStatus;
  errorCode: string | null;
  errorMessage: string | null;
  warnings: string[];
}

export interface ConvertBatchResponse {
  jobId: string;
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  results: ConvertFileResult[];
}

export interface ConversionProgressEvent {
  jobId: string;
  index: number;
  total: number;
  sourcePath: string | null;
  outputPath: string | null;
  status: "processing" | "success" | "failed" | "completed";
  message: string | null;
  succeeded: number;
  failed: number;
}

export interface ConversionSettings {
  targetFormat: OutputFormat;
  quality: number;
  resize: ResizeOptions;
  icoSize: number;
}
