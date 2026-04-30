import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { LoaderCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import type {
  ConversionProgressEvent,
  ConversionSettings,
  ConversionViewState,
  ConvertBatchRequest,
  ConvertBatchResponse,
  ConvertFileResult,
  OutputFormat,
  ResizeMode,
} from "./types/conversion";
import "./App.css";
import dropzoneImage from "./assets/img.png";
import appIcon from "../src-tauri/icons/32x32.png";

const SUPPORTED_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff", "ico"];
const FORMAT_OPTIONS: Array<{ value: OutputFormat; label: string }> = [
  { value: "png", label: "PNG" },
  { value: "jpeg", label: "JPG / JPEG" },
  { value: "webp", label: "WebP" },
  { value: "bmp", label: "BMP" },
  { value: "gif", label: "GIF" },
  { value: "tiff", label: "TIFF" },
  { value: "ico", label: "ICO" },
];
const RESIZE_MODE_OPTIONS: Array<{ value: ResizeMode; label: string }> = [
  { value: "none", label: "不缩放" },
  { value: "fit", label: "等比适配" },
  { value: "exact", label: "精确尺寸" },
];
const ICO_SIZES = [16, 32, 48, 64, 128, 256] as const;

const STATUS_BADGE_VARIANTS: Record<ConversionViewState, "secondary" | "default" | "success" | "destructive"> = {
  idle: "secondary",
  dragging: "default",
  processing: "default",
  completed: "success",
  error: "destructive",
};

const STATUS_BADGE_LABELS: Record<ConversionViewState, string> = {
  idle: "等待输入",
  dragging: "准备拖放",
  processing: "转换中",
  completed: "已完成",
  error: "异常",
};

const DROPZONE_BADGE_LABELS: Record<ConversionViewState, string> = {
  idle: "拖拽 / 批量 / 自动开始",
  dragging: "松开即可开始转换",
  processing: "正在锁定批量转换",
  completed: "可继续拖入下一批",
  error: "检查结果后可重试",
};

const DROPZONE_BADGE_VARIANTS: Record<ConversionViewState, "default" | "secondary" | "success" | "destructive"> = {
  idle: "default",
  dragging: "default",
  processing: "secondary",
  completed: "success",
  error: "destructive",
};

const RESULT_BADGE_VARIANTS: Record<ConvertFileResult["status"], "success" | "destructive" | "warning"> = {
  success: "success",
  failed: "destructive",
  skipped: "warning",
};

const RESULT_LABELS: Record<ConvertFileResult["status"], string> = {
  success: "成功",
  failed: "失败",
  skipped: "跳过",
};

function isDesktopRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function App() {
  const isTauriRuntime = isDesktopRuntime();
  const desktopWindow = isTauriRuntime ? getCurrentWindow() : null;

  const [settings, setSettings] = useState<ConversionSettings>({
    targetFormat: "png",
    quality: 90,
    resize: {
      mode: "none",
      width: null,
      height: null,
      allowUpscale: false,
    },
    icoSize: 256,
  });
  const [viewState, setViewState] = useState<ConversionViewState>("idle");
  const [results, setResults] = useState<ConvertFileResult[]>([]);
  const [message, setMessage] = useState("拖入图片后会立即开始转换，输出到原文件同目录。");
  const [progress, setProgress] = useState({
    jobId: "",
    total: 0,
    current: 0,
    succeeded: 0,
    failed: 0,
    currentFile: "",
  });
  const [isWindowMaximized, setIsWindowMaximized] = useState(false);
  const settingsRef = useRef(settings);
  const viewStateRef = useRef(viewState);
  const titleBarPointerRef = useRef<{ pointerId: number; startX: number; startY: number; dragging: boolean } | null>(null);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    viewStateRef.current = viewState;
  }, [viewState]);

  const isProcessing = viewState === "processing";
  const qualityEnabled = settings.targetFormat === "jpeg";

  const completedCount = useMemo(
    () => Math.min(progress.succeeded + progress.failed, progress.total),
    [progress.failed, progress.succeeded, progress.total],
  );

  const progressPercent = useMemo(() => {
    if (progress.total === 0) {
      return 0;
    }

    return Math.round((completedCount / progress.total) * 100);
  }, [completedCount, progress.total]);

  const summary = useMemo(() => {
    if (progress.total === 0) {
      return "等待文件输入";
    }

    return `已处理 ${Math.min(progress.current, progress.total)} / ${progress.total} · 成功 ${progress.succeeded} · 失败 ${progress.failed}`;
  }, [progress]);

  // const activeProgressLabel = progress.currentFile || "正在准备转换";

  const progressRingStyle = {
    background: `conic-gradient(#2f62ff 0deg ${(progressPercent / 100) * 360}deg, rgba(201, 214, 242, 0.5) ${(progressPercent / 100) * 360}deg 360deg)`,
  };

  const startConversion = async (inputPaths: string[], activeSettings: ConversionSettings = settingsRef.current) => {
    const paths = normalizePaths(inputPaths);
    if (paths.length === 0) {
      return;
    }

    if (viewStateRef.current === "processing") {
      setMessage("当前批次仍在处理中，请等待完成后再拖入新文件。");
      return;
    }

    setResults([]);
    setViewState("processing");
    setProgress({
      jobId: "",
      total: paths.length,
      current: 0,
      succeeded: 0,
      failed: 0,
      currentFile: paths[0] ?? "",
    });
    setMessage(`已接收 ${paths.length} 个文件，开始转换。`);

    try {
      const response = await invoke<ConvertBatchResponse>("convert_batch", {
        request: createRequest(paths, activeSettings),
      });

      setResults(response.results);
      setProgress({
        jobId: response.jobId,
        total: response.total,
        current: response.total,
        succeeded: response.succeeded,
        failed: response.failed,
        currentFile: "",
      });
      setViewState(response.failed > 0 ? "error" : "completed");
      setMessage(
        response.failed > 0
          ? `批量转换完成，${response.failed} 个文件失败。`
          : `批量转换完成，${response.succeeded} 个文件已输出到原文件目录。`,
      );
    } catch (error) {
      const reason = extractErrorMessage(error);
      setViewState("error");
      setMessage(reason);
      setProgress((current) => ({
        ...current,
        currentFile: "",
      }));
    }
  };

  useEffect(() => {
    if (!isTauriRuntime || !desktopWindow) {
      setMessage("当前为浏览器预览模式，拖拽和选择文件仅在 Tauri 桌面窗口中可用。");
      return;
    }

    let disposed = false;

    const setupListeners = async () => {
      setIsWindowMaximized(await desktopWindow.isMaximized());
      const unlistenResize = await desktopWindow.onResized(async () => {
        if (disposed) {
          return;
        }

        setIsWindowMaximized(await desktopWindow.isMaximized());
      });
      const unlistenProgress = await listen<ConversionProgressEvent>("conversion://progress", ({ payload }) => {
        if (disposed) {
          return;
        }

        setProgress((current) => ({
          jobId: payload.jobId,
          total: payload.total,
          current:
            payload.status === "processing"
              ? Math.max(current.current, payload.index - 1)
              : Math.max(current.current, payload.index),
          succeeded: payload.succeeded,
          failed: payload.failed,
          currentFile: payload.sourcePath ?? current.currentFile,
        }));

        if (payload.status === "processing") {
          setViewState("processing");
          setMessage(`正在处理：${payload.sourcePath ?? "图片文件"}`);
        }

        if (payload.status === "failed" && payload.message) {
          setMessage(payload.message);
        }
      });

      const unlistenDrop = await desktopWindow.onDragDropEvent((event) => {
        if (disposed) {
          return;
        }

        if (event.payload.type === "enter" || event.payload.type === "over") {
          setViewState((current) => (current === "processing" ? current : "dragging"));
        }

        if (event.payload.type === "leave") {
          setViewState((current) => (current === "processing" ? current : "idle"));
        }

        if (event.payload.type === "drop") {
          setViewState((current) => (current === "processing" ? current : "idle"));
          void startConversion(event.payload.paths, settingsRef.current);
        }
      });

      return () => {
        unlistenProgress();
        unlistenResize();
        unlistenDrop();
      };
    };

    let cleanup: (() => void) | undefined;
    void setupListeners().then((fn) => {
      cleanup = fn;
    });

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [isTauriRuntime]);

  const handleTargetFormatChange = (value: OutputFormat) => {
    setSettings((current) => ({
      ...current,
      targetFormat: value,
      icoSize: value === "ico" ? current.icoSize : 256,
    }));
  };

  const handlePickFiles = async () => {
    if (!isTauriRuntime) {
      setMessage("浏览器预览模式下无法调用原生文件选择，请在 Tauri 窗面中使用此功能。");
      return;
    }

    if (viewState === "processing") {
      return;
    }

    const selected = await open({
      multiple: true,
      directory: false,
      filters: [
        {
          name: "Images",
          extensions: SUPPORTED_EXTENSIONS,
        },
      ],
    });

    if (!selected) {
      return;
    }

    const paths = Array.isArray(selected) ? selected : [selected];
    await startConversion(paths);
  };

  const handleMinimizeWindow = async () => {
    await desktopWindow?.minimize();
  };

  const handleToggleMaximizeWindow = async () => {
    if (!desktopWindow) {
      return;
    }

    await desktopWindow.toggleMaximize();
    setIsWindowMaximized(await desktopWindow.isMaximized());
  };

  const handleCloseWindow = async () => {
    await desktopWindow?.close();
  };

  const handleTitleBarPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) {
      return;
    }

    titleBarPointerRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
    };
  };

  const handleTitleBarPointerMove = async (event: React.PointerEvent<HTMLDivElement>) => {
    const pointerState = titleBarPointerRef.current;
    if (!desktopWindow || !pointerState || pointerState.pointerId !== event.pointerId || pointerState.dragging || (event.buttons & 1) !== 1) {
      return;
    }

    const movedX = Math.abs(event.clientX - pointerState.startX);
    const movedY = Math.abs(event.clientY - pointerState.startY);
    if (movedX < 4 && movedY < 4) {
      return;
    }

    pointerState.dragging = true;
    await desktopWindow.startDragging();
    titleBarPointerRef.current = null;
  };

  const resetTitleBarPointer = () => {
    titleBarPointerRef.current = null;
  };

  const handleTitleBarDoubleClick = async (event: React.MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) {
      return;
    }

    resetTitleBarPointer();
    await handleToggleMaximizeWindow();
  };

  return (
    <main className="app-shell relative h-screen overflow-hidden  text-slate-900 bg-[#f5f8fc]">
      {/* 进度条 */}
      {isProcessing ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-[rgba(232,239,255,0.66)] p-6 backdrop-blur-xl shadow" role="alert" aria-live="assertive" aria-busy="true">
          <div className="w-full max-w-md rounded-[28px] border border-slate-200/80 bg-white/95 p-7 shadow-[0_30px_80px_rgba(36,62,116,0.18)] backdrop-blur-2xl">
            <div className="grid justify-items-center gap-5 text-center">
              <div className="grid size-42.5 place-items-center rounded-full p-3.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.65)]" style={progressRingStyle}>
                <div className="grid size-full content-center place-items-center gap-1 rounded-full bg-linear-to-b from-white to-slate-100 text-slate-800">
                  <strong className="text-[34px] leading-none font-semibold">{progressPercent}%</strong>
                  <span className="text-sm text-slate-500">
                    {completedCount} / {progress.total || 0}
                  </span>
                </div>
              </div>
              <div className="grid gap-2 ">
                <div className="flex items-center justify-center gap-2 text-slate-700">
                  <LoaderCircle className="size-4 animate-spin" />
                  <span className="text-sm font-medium">转换期间不可进行其他操作</span>
                </div>
                <h2 className="text-2xl font-semibold text-slate-900">正在转换图片</h2>
                {/* <p className="text-sm text-slate-500">{activeProgressLabel}</p> */}
                <span className="text-sm text-slate-500">{summary}</span>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* 标题栏 */}
      {isTauriRuntime ? (
        <div className="mx-auto w-full shrink-0 relative z-100">
          <div className="flex w-full min-h-8 items-center px-4 py-0 select-none">
            <div
              data-tauri-drag-region
              onPointerDown={handleTitleBarPointerDown}
              onPointerMove={(event) => void handleTitleBarPointerMove(event)}
              onPointerUp={resetTitleBarPointer}
              onPointerCancel={resetTitleBarPointer}
              onDoubleClick={(event) => void handleTitleBarDoubleClick(event)}
              className="flex min-h-8 min-w-0 flex-1 items-center"
            >
              <div data-tauri-drag-region className="flex min-w-0 items-center gap-2">
                <img
                  src={appIcon}
                  alt=""
                  aria-hidden="true"
                  className="size-5 rounded-sm object-contain"
                />
                <p className="truncate text-sm font-semibold text-slate-900">图片转换器</p>
              </div>
            </div>
            <div className="-mr-4 flex items-center">
              <Button
                type="button"
                variant="ghost"
                className="h-8 w-11 rounded-none px-0 text-slate-700 hover:bg-black/6 hover:text-slate-900"
                onClick={() => void handleMinimizeWindow()}
                aria-label="最小化窗口"
              >
                <svg aria-hidden="true" viewBox="0 0 10 10" className="size-2.5" fill="none">
                  <path d="M1 5h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="square" />
                </svg>
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="h-8 w-11 rounded-none px-0 text-slate-700 hover:bg-black/6 hover:text-slate-900"
                onClick={() => void handleToggleMaximizeWindow()}
                aria-label={isWindowMaximized ? "还原窗口" : "最大化窗口"}
              >
                {isWindowMaximized ? (
                  <svg aria-hidden="true" viewBox="0 0 10 10" className="size-3" fill="none">
                    <path d="M3 1.5h5.5V7" stroke="currentColor" strokeWidth="1" />
                    <path d="M1.5 3H7v5.5H1.5z" stroke="currentColor" strokeWidth="1" />
                  </svg>
                ) : (
                  <svg aria-hidden="true" viewBox="0 0 10 10" className="size-3" fill="none">
                    <rect x="1.5" y="1.5" width="7" height="7" stroke="currentColor" strokeWidth="1" />
                  </svg>
                )}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="h-8 w-11 rounded-none px-0 text-slate-700 hover:bg-[#e81123] hover:text-white"
                onClick={() => void handleCloseWindow()}
                aria-label="关闭窗口"
              >
                <svg aria-hidden="true" viewBox="0 0 10 10" className="size-3" fill="none">
                  <path d="M2 2l6 6M8 2 2 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="square" />
                </svg>
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="app-content-scroll flex-1 overflow-y-auto overflow-x-hidden p-4">
        <section
          className={cn(
            "mx-auto grid w-full max-w-6xl gap-5",
            isProcessing && "pointer-events-none select-none",
          )}
          aria-hidden={isProcessing}
        >
          <section
            className={cn(
              "relative overflow-hidden rounded-[28px] border-2 border-dashed px-5 py-6 text-center shadow",
              "border-slate-200/70 bg-white/85 shadow-[0_20px_60px_rgba(36,62,116,0.10)] backdrop-blur-xl",
              viewState === "dragging" && "-translate-y-0.5 border-blue-400 bg-blue-50/80 shadow-[0_24px_48px_rgba(75,130,255,0.20)]",
              viewState === "processing" && "border-blue-300 bg-slate-50/90",
              viewState !== "dragging" && viewState !== "processing" && "border-blue-300/80 bg-linear-to-b from-white/95 to-slate-50/95",
            )}
          >
            <div className={cn("absolute inset-0 rounded-[28px]", viewState === "dragging" && "bg-blue-100/30", viewState === "processing" && "bg-white/30", viewState !== "dragging" && viewState !== "processing" && "pointer-events-none")} />
            <div className="relative z-10 space-y-5">
              <div className="flex justify-start">
                <Badge variant={DROPZONE_BADGE_VARIANTS[viewState]}>{DROPZONE_BADGE_LABELS[viewState]}</Badge>
              </div>
              <div className="flex flex-col items-center justify-center gap-3">
                <img className="h-23 w-23 object-contain" src={dropzoneImage} alt="" />
                <h1 className="text-3xl font-semibold tracking-tight text-slate-900">图片拖拽到这里</h1>
                <p className="mx-auto max-w-2xl text-sm leading-6 text-slate-500">
                  {viewState === "dragging"
                    ? "松开后会立即按当前设置开始转换"
                    : viewState === "processing"
                      ? "当前批次正在执行，界面已锁定以避免误操作"
                      : viewState === "completed"
                        ? "可继续拖入新图片，仍将按当前设置立即开始转换"
                        : viewState === "error"
                          ? "上一次转换出现异常，修正设置后可重新拖入文件"
                          : "支持 PNG、JPG、WebP、BMP、GIF、TIFF、ICO"}
                </p>
                <Button type="button" size="lg" onClick={() => void handlePickFiles()} disabled={isProcessing}>
                  选择图片
                </Button>
              </div>
            </div>
          </section>

          <Card className="border-slate-200/70 bg-white/85 shadow backdrop-blur-xl">
            <CardHeader className="gap-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="space-y-2">
                  <CardTitle className="text-xl font-semibold text-slate-900">转换设置</CardTitle>
                  <CardDescription className="text-sm text-slate-500">首版默认顺序处理，优先保证稳定和不覆盖原文件。</CardDescription>
                </div>
                <p className="text-sm text-slate-500">JPEG 支持质量调节，ICO 可选择输出尺寸。</p>
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                <Field label="目标格式">
                  <Select value={settings.targetFormat} onValueChange={(value) => handleTargetFormatChange(value as OutputFormat)} disabled={isProcessing}>
                    <SelectTrigger>
                      <SelectValue placeholder="请选择" />
                    </SelectTrigger>
                    <SelectContent>
                      {FORMAT_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>

                <Field label={qualityEnabled ? "质量" : "质量（仅 JPEG）"}>
                  <div className="space-y-3 rounded-2xl border border-slate-200/70 bg-white/70 px-4 py-3">
                    <Slider
                      min={1}
                      max={100}
                      step={1}
                      value={[settings.quality]}
                      disabled={!qualityEnabled || isProcessing}
                      onValueChange={(value) => {
                        const next = value[0];
                        if (typeof next === "number") {
                          setSettings((current) => ({ ...current, quality: next }));
                        }
                      }}
                      aria-label="质量"
                    />
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="text-slate-500">1</span>
                      <strong className="font-semibold text-slate-700">{settings.quality}</strong>
                      <span className="text-slate-500">100</span>
                    </div>
                  </div>
                </Field>

                <Field label="缩放模式">
                  <Select
                    value={settings.resize.mode}
                    onValueChange={(value) => {
                      setSettings((current) => ({
                        ...current,
                        resize: { ...current.resize, mode: value as ResizeMode },
                      }));
                    }}
                    disabled={isProcessing}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="请选择" />
                    </SelectTrigger>
                    <SelectContent>
                      {RESIZE_MODE_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>

                <Field label="宽度">
                  <Input
                    type="number"
                    min="1"
                    inputMode="numeric"
                    placeholder="自动"
                    value={settings.resize.width ?? ""}
                    disabled={isProcessing}
                    onChange={(event) => {
                      const value = toOptionalNumber(event.currentTarget.value);
                      setSettings((current) => ({
                        ...current,
                        resize: {
                          ...current.resize,
                          width: value,
                        },
                      }));
                    }}
                  />
                </Field>

                <Field label="高度">
                  <Input
                    type="number"
                    min="1"
                    inputMode="numeric"
                    placeholder="自动"
                    value={settings.resize.height ?? ""}
                    disabled={isProcessing}
                    onChange={(event) => {
                      const value = toOptionalNumber(event.currentTarget.value);
                      setSettings((current) => ({
                        ...current,
                        resize: {
                          ...current.resize,
                          height: value,
                        },
                      }));
                    }}
                  />
                </Field>

                <Field label="ICO 尺寸">
                  <Select
                    value={String(settings.icoSize)}
                    onValueChange={(value) => {
                      const next = Number(value);
                      setSettings((current) => ({ ...current, icoSize: next }));
                    }}
                    disabled={settings.targetFormat !== "ico" || isProcessing}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="请选择" />
                    </SelectTrigger>
                    <SelectContent>
                      {ICO_SIZES.map((size) => (
                        <SelectItem key={size} value={String(size)}>
                          {size} × {size}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>

              <label className="flex items-center gap-3 text-sm font-medium text-slate-700">
                <Checkbox
                  checked={settings.resize.allowUpscale}
                  disabled={isProcessing}
                  onCheckedChange={(checked) => {
                    setSettings((current) => ({
                      ...current,
                      resize: {
                        ...current.resize,
                        allowUpscale: checked === true,
                      },
                    }));
                  }}
                />
                <span>允许放大</span>
              </label>
            </CardContent>
          </Card>

          <Card className={cn("border-slate-200/70 bg-white/85 shadow backdrop-blur-xl", viewState === "error" && "border-rose-200/80 bg-rose-50/70", viewState === "completed" && "border-emerald-200/80 bg-emerald-50/70")} aria-live="polite">
            <CardContent className="flex flex-col gap-4 px-6 py-6 lg:flex-row lg:items-start lg:justify-between">
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <p className="text-sm font-medium text-slate-600">当前状态</p>
                  <Badge variant={STATUS_BADGE_VARIANTS[viewState]}>{STATUS_BADGE_LABELS[viewState]}</Badge>
                </div>
                <h2 className={cn("text-lg font-semibold sm:text-xl", viewState === "error" ? "text-rose-700" : "text-slate-900")}>{message}</h2>
              </div>
              <div className="grid gap-2 text-sm text-slate-500 lg:justify-items-end lg:text-right">
                <span>{summary}</span>
                {progress.currentFile ? (
                  <div className="space-y-1">
                    <p className="text-xs font-medium uppercase tracking-[0.16em] text-slate-400">当前文件</p>
                    <p className="font-[Cascadia_Code,SFMono-Regular,Consolas,monospace] text-xs break-all text-slate-500">{progress.currentFile}</p>
                  </div>
                ) : null}
              </div>
            </CardContent>
          </Card>

          <Card className="min-h-55 border-slate-200/70 bg-white/85 shadow backdrop-blur-xl">
            <CardHeader className="gap-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="space-y-2">
                  <CardTitle className="text-xl font-semibold text-slate-900">批量结果</CardTitle>
                  <CardDescription className="text-sm text-slate-500">失败不会中断整批，成功文件会继续输出。</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {results.length === 0 ? (
                <div className="rounded-2xl bg-slate-50/90 px-5 py-8 text-sm text-slate-500">等待第一次转换。</div>
              ) : (
                <ScrollArea className="max-h-112 overflow-hidden rounded-2xl" aria-busy={isProcessing || undefined}>
                  <ul className="grid gap-3 pr-3">
                    {results.map((result) => (
                      <li
                        key={`${result.sourcePath}-${result.outputPath ?? result.status}`}
                        className={cn(
                          "space-y-2 rounded-2xl border px-4 py-4",
                          result.status === "success" && "border-emerald-200/80 bg-emerald-50/80",
                          result.status === "failed" && "border-rose-200/80 bg-rose-50/85",
                          result.status === "skipped" && "border-amber-200/80 bg-amber-50/85",
                        )}
                      >
                        <div className="flex items-center gap-3">
                          <Badge variant={RESULT_BADGE_VARIANTS[result.status]}>{RESULT_LABELS[result.status]}</Badge>
                        </div>
                        <p className="font-[Cascadia_Code,SFMono-Regular,Consolas,monospace] text-xs break-all text-slate-500">{result.sourcePath}</p>
                        {result.outputPath ? (
                          <p className="font-[Cascadia_Code,SFMono-Regular,Consolas,monospace] text-xs break-all text-slate-500">→ {result.outputPath}</p>
                        ) : null}
                        {result.errorMessage ? <p className="text-sm text-rose-600">{result.errorMessage}</p> : null}
                        {result.warnings.map((warning) => (
                          <p key={warning} className="text-sm text-amber-700">
                            {warning}
                          </p>
                        ))}
                      </li>
                    ))}
                  </ul>
                </ScrollArea>
              )}
            </CardContent>
          </Card>
        </section>
      </div>
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2">
      <label className="text-sm font-medium text-slate-700">{label}</label>
      {children}
    </div>
  );
}

function normalizePaths(paths: string[]) {
  return [...new Set(paths.filter((path) => Boolean(path)))];
}

function createRequest(paths: string[], settings: ConversionSettings): ConvertBatchRequest {
  return {
    sources: paths,
    targetFormat: settings.targetFormat,
    outputDir: null,
    quality: settings.targetFormat === "jpeg" ? settings.quality : settings.targetFormat === "webp" ? settings.quality : null,
    resize: settings.resize,
    icoSize: settings.targetFormat === "ico" ? settings.icoSize : null,
  };
}

function toOptionalNumber(value: string) {
  if (value.trim() === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function extractErrorMessage(error: unknown) {
  if (typeof error === "object" && error && "message" in error && typeof error.message === "string") {
    return error.message;
  }

  return "转换失败，请检查输入文件后重试。";
}

export default App;
