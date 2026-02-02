import clide from "@imlokesh/clide";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

// ==========================================
// 1. Types & Interfaces
// ==========================================

enum Resolution {
  R1080 = "1080",
  R720 = "720",
  R480 = "480",
}

interface ConversionOptions {
  input: string;
  suffix: string;
  resolution: Resolution;
  crf: number;
  preset: string;
  deleteOriginal: boolean;
}

interface FileResult {
  file: string;
  savedBytes: number;
  status: "success" | "skipped" | "failed" | "grew";
}

// ==========================================
// 2. Logger Service
// ==========================================

const Logger = {
  info: (msg: string) => console.log(msg),
  success: (msg: string) => console.log(`  ✅ ${msg}`),
  warn: (msg: string) => console.log(`  ⚠️  ${msg}`),
  error: (msg: string) => console.error(`  ❌ ${msg}`),
  skip: (msg: string) => console.log(`  ⏭️  ${msg}`),
  progress: (msg: string) => process.stdout.write(`  ⏳ ${msg}\r`),
  clearLine: () => process.stdout.write("\n"),
  header: (msg: string) => console.log(`\n=== ${msg} ===\n`),
  divider: () => console.log("-".repeat(50)),

  formatBytes: (bytes: number): string => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  },
};

// ==========================================
// 3. FFmpeg Service
// ==========================================

const FFmpegService = {
  /** Check if binary exists in PATH */
  checkBinary: (binary: string): Promise<void> => {
    return new Promise((resolve, reject) => {
      const proc = spawn(binary, ["-version"]);
      proc.on("error", () => reject(new Error(`${binary} not found`)));
      proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${binary} error`))));
    });
  },

  /** Get video height */
  getHeight: (filePath: string): Promise<number> => {
    return new Promise((resolve) => {
      const args = [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=height",
        "-of",
        "csv=p=0",
        filePath,
      ];
      const proc = spawn("ffprobe", args);
      let data = "";
      proc.stdout.on("data", (chunk) => (data += chunk));
      proc.on("close", () => {
        const height = parseInt(data.trim());
        resolve(isNaN(height) ? 0 : height);
      });
    });
  },

  /** Run the conversion process */
  convert: (
    input: string,
    output: string,
    opts: ConversionOptions,
    targetHeight: number,
  ): Promise<void> => {
    return new Promise(async (resolve, reject) => {
      const inputHeight = await FFmpegService.getHeight(input);

      // Determine filters
      const args = [
        "-i",
        input,
        "-map",
        "0",
        "-c:v",
        "libx265",
        "-crf",
        String(opts.crf),
        "-preset",
        opts.preset,
        "-c:a",
        "copy",
        "-c:s",
        "copy",
      ];

      if (inputHeight > targetHeight) {
        Logger.info(`Downscaling: ${inputHeight}p -> ${targetHeight}p`);
        args.push("-vf", `scale=-2:${targetHeight}`);
      } else {
        Logger.info(`Keeping resolution: ${inputHeight || "unknown"}p`);
      }

      args.push("-y", output);

      const proc = spawn("ffmpeg", args);

      // Progress monitoring
      proc.stderr.on("data", (chunk) => {
        const line = chunk.toString();
        const timeMatch = line.match(/time=(\S+)/);
        if (timeMatch) Logger.progress(`Encoding... ${timeMatch[1]}`);
      });

      proc.on("close", (code) => {
        Logger.clearLine();
        if (code === 0) resolve();
        else reject(new Error(`FFmpeg exited with code ${code}`));
      });

      proc.on("error", (err) => reject(err));
    });
  },
};

// ==========================================
// 4. File System Service
// ==========================================

const FileService = {
  VALID_EXTS: new Set([
    ".mp4",
    ".mkv",
    ".avi",
    ".mov",
    ".flv",
    ".wmv",
    ".webm",
    ".m4v",
    ".mpg",
    ".mpeg",
  ]),

  /** Recursively find all video files */
  scan: async (dir: string): Promise<string[]> => {
    let results: string[] = [];
    try {
      const stat = await fs.stat(dir);
      if (stat.isFile()) {
        if (FileService.VALID_EXTS.has(path.extname(dir).toLowerCase())) return [dir];
        return [];
      }

      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results = results.concat(await FileService.scan(fullPath));
        } else if (FileService.VALID_EXTS.has(path.extname(entry.name).toLowerCase())) {
          results.push(fullPath);
        }
      }
    } catch (e) {
      Logger.error(`Could not access path: ${dir}`);
    }
    return results;
  },

  exists: async (filePath: string): Promise<boolean> => {
    try {
      await fs.access(filePath, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  },

  getSize: async (filePath: string) => (await fs.stat(filePath)).size,
};

// ==========================================
// 5. Core Logic
// ==========================================

const processFile = async (
  file: string,
  opts: ConversionOptions,
  idx: number,
  total: number,
): Promise<FileResult> => {
  const fileInfo = path.parse(file);
  const baseName = fileInfo.name;

  Logger.divider();
  Logger.info(`[${idx}/${total}] Processing: ${fileInfo.base}`);

  // Check 1: Is this already a converted file?
  if (baseName.endsWith(opts.suffix)) {
    Logger.skip("Skipping: File appears to be an output file.");
    return { file, savedBytes: 0, status: "skipped" };
  }

  // Check 2: Does the output file already exist?
  const outputName = `${baseName}${opts.suffix}.mkv`;
  const tempName = `${baseName}${opts.suffix}.temp.mkv`;
  const outputPath = path.join(fileInfo.dir, outputName);
  const tempPath = path.join(fileInfo.dir, tempName);

  if (await FileService.exists(outputPath)) {
    Logger.skip("Skipping: Converted file already exists.");
    return { file, savedBytes: 0, status: "skipped" };
  }

  try {
    // Convert
    await FFmpegService.convert(file, tempPath, opts, parseInt(opts.resolution));

    // Verify Sizes
    const originalSize = await FileService.getSize(file);
    const newSize = await FileService.getSize(tempPath);
    const savedBytes = originalSize - newSize;
    const savedPercent = ((savedBytes / originalSize) * 100).toFixed(1);

    if (savedBytes > 0) {
      Logger.success(`Done! ${Logger.formatBytes(originalSize)} -> ${Logger.formatBytes(newSize)}`);
      Logger.success(`Saved: ${Logger.formatBytes(savedBytes)} (${savedPercent}%)`);

      await fs.rename(tempPath, outputPath);

      if (opts.deleteOriginal) {
        await fs.unlink(file);
        Logger.info("🗑️  Original file deleted.");
      }
      return { file, savedBytes, status: "success" };
    } else {
      Logger.warn(`File grew by ${Logger.formatBytes(Math.abs(savedBytes))}. keeping original.`);
      // We still rename it to mark it as processed, but we DO NOT delete original
      await fs.rename(tempPath, outputPath);
      return { file, savedBytes: 0, status: "grew" };
    }
  } catch (err: any) {
    Logger.error(`Conversion Failed: ${err.message}`);
    // Cleanup temp
    if (await FileService.exists(tempPath)) await fs.unlink(tempPath);
    return { file, savedBytes: 0, status: "failed" };
  }
};

// ==========================================
// 6. Main Entry Point
// ==========================================

const main = async () => {
  const { command, commandOptions } = await clide({
    description: "Modern Video Compressor (HEVC)",
    defaultCommand: "convert",
    commands: {
      convert: {
        description: "Convert videos to HEVC/H.265",
        options: {
          input: {
            type: "string",
            short: "i",
            required: true,
            description: "Input file or folder",
          },
          suffix: {
            type: "string",
            short: "s",
            default: "_converted",
            env: "HEVC_SUFFIX",
            description: "Output suffix",
          },
          resolution: {
            type: "string",
            choices: ["1080", "720", "480"],
            default: "720",
            env: "HEVC_RES",
            description: "Max height",
          },
          crf: {
            type: "number",
            default: 24,
            env: "HEVC_CRF",
            validate: (n: number) => (n > 0 && n < 51) || "CRF 0-51",
          },
          preset: {
            type: "string",
            default: "medium",
            env: "HEVC_PRESET",
            choices: ["fast", "medium", "slow", "veryslow"],
          },
          "delete-original": {
            type: "boolean",
            default: false,
            description: "Delete source if smaller",
          },
        },
      },
    },
  });

  if (command !== "convert") return;

  const opts: ConversionOptions = {
    input: commandOptions.input as string,
    suffix: commandOptions.suffix as string,
    resolution: commandOptions.resolution as Resolution,
    crf: commandOptions.crf as number,
    preset: commandOptions.preset as string,
    deleteOriginal: commandOptions["delete-original"] as boolean,
  };

  Logger.header("Starting Video Compression");

  try {
    await FFmpegService.checkBinary("ffmpeg");
    await FFmpegService.checkBinary("ffprobe");
  } catch (e: any) {
    Logger.error(e.message);
    process.exit(1);
  }

  const files = await FileService.scan(opts.input);
  if (files.length === 0) {
    Logger.warn("No video files found.");
    process.exit(0);
  }

  Logger.info(`Found ${files.length} files. Target: ${opts.resolution}p, CRF: ${opts.crf}`);

  let totalSaved = 0;
  let successCount = 0;

  for (let i = 0; i < files.length; i++) {
    const result = await processFile(files[i], opts, i + 1, files.length);
    if (result.status === "success") {
      totalSaved += result.savedBytes;
      successCount++;
    }
  }

  Logger.header("Summary");
  Logger.info(`Processed: ${files.length}`);
  Logger.success(`Successful: ${successCount}`);
  Logger.info(`Total Space Saved: ${Logger.formatBytes(totalSaved)}`);
};

main();
