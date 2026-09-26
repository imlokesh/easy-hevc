import { spawn } from "node:child_process";

export type Encoder = "cpu" | "nvidia";
export type Preset = "fast" | "medium" | "slow" | "veryslow";

export interface EncoderOptions {
  encoder: Encoder;
  crf: number;
  cq?: number;
  preset: Preset;
}

const nvidiaPresets = { fast: "p3", medium: "p4", slow: "p6", veryslow: "p7" };

export function encoderSettings(opts: EncoderOptions) {
  if (opts.encoder === "cpu" && opts.cq !== undefined) {
    throw new Error("--cq requires --encoder nvidia. Use --crf for CPU encoding.");
  }
  if (opts.cq !== undefined && (!Number.isInteger(opts.cq) || opts.cq < 1 || opts.cq > 50)) {
    throw new Error("CQ must be an integer from 1 to 50.");
  }
  const gpu = opts.encoder === "nvidia";
  const codec = gpu ? "hevc_nvenc" : "libx265";
  const quality = gpu ? (opts.cq ?? 24) : opts.crf;
  const qualityName = gpu ? "cq" : "crf";
  const preset = gpu ? nvidiaPresets[opts.preset] : opts.preset;
  return {
    codec,
    quality,
    qualityName,
    preset,
    args: gpu
      ? ["-c:v", codec, "-rc", "vbr", "-cq", String(quality), "-b:v", "0", "-preset", preset]
      : ["-c:v", codec, "-crf", String(quality), "-preset", preset],
  };
}

/** Keep diagnostics bounded even during long encodes. */
export function runFFmpeg(
  args: string[],
  onStderr?: (chunk: string) => void,
  timeoutMs?: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", ["-nostdin", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          proc.kill();
        }, timeoutMs)
      : undefined;
    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr = (stderr + text).slice(-8192);
      onStderr?.(text);
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) resolve();
      else
        reject(
          new Error(
            `${timedOut ? "FFmpeg timed out" : `FFmpeg exited with code ${code}`}\n${stderr.trim()}`,
          ),
        );
    });
  });
}

export async function checkNvidia(opts: EncoderOptions): Promise<void> {
  try {
    await runFFmpeg(
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=128x128:r=1,format=yuv420p",
        "-frames:v",
        "1",
        ...encoderSettings(opts).args,
        "-f",
        "null",
        "-",
      ],
      undefined,
      30000,
    );
  } catch (err) {
    throw new Error(
      `NVIDIA encoding is unavailable. Check that FFmpeg includes hevc_nvenc, your GPU supports HEVC encoding, and NVIDIA drivers are installed and compatible. Use --encoder cpu to encode without NVIDIA.\n${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
