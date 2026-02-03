import { spawn } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import * as readline from "node:readline";
import clide from "@imlokesh/clide";

// ==========================================
// 1. Types & Interfaces
// ==========================================

enum Resolution {
  R4K = "2160",
  R2K = "1440",
  R1080 = "1080",
  R720 = "720",
  R540 = "540",
  R480 = "480",
  R360 = "360",
}

interface ConversionOptions {
  input: string;
  suffix: string;
  resolution: Resolution;
  crf: number;
  preset: string;
  deleteOriginal: boolean;
  preserveDates: boolean;
}

interface FinalizeOptions {
  input: string;
  suffix: string;
  force: boolean;
}

// ==========================================
// 2. Logger & UI Service
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
    return `${parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`;
  },

  confirm: (query: string): Promise<boolean> => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise((resolve) => {
      const ask = () => {
        rl.question(`\n❓ ${query} [y/n]: `, (answer) => {
          const a = answer.toLowerCase().trim();
          if (a === "y" || a === "yes") {
            rl.close();
            resolve(true);
          } else if (a === "n" || a === "no") {
            rl.close();
            resolve(false);
          } else {
            console.log("   ❌ Invalid input. Please type 'y' or 'n'.");
            ask(); // Recursively ask again
          }
        });
      };
      ask();
    });
  },

  askConflict: (filename: string): Promise<"yes" | "yes_all" | "no" | "no_all"> => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise((resolve) => {
      console.log(
        `\n⚠️  File "${filename}" was encoded using @imlokesh/easy-hevc. Do you want to re-convert it?`,
      );
      console.log("   [y] Yes (re-convert)");
      console.log("   [n] No (skip)");
      console.log("   [A] Yes to All");
      console.log("   [N] No to All");

      const ask = () => {
        rl.question(`   Select option: `, (ans) => {
          const a = ans.trim();

          if (a === "A") {
            rl.close();
            resolve("yes_all");
          } else if (a === "N") {
            rl.close();
            resolve("no_all");
          } else if (a.toLowerCase() === "y" || a.toLowerCase() === "yes") {
            rl.close();
            resolve("yes");
          } else if (a.toLowerCase() === "n" || a.toLowerCase() === "no") {
            rl.close();
            resolve("no");
          } else {
            console.log("   ❌ Invalid option. Please try again.");
            ask(); // Recursively ask again
          }
        });
      };
      ask();
    });
  },
};

// ==========================================
// 3. FFmpeg Service
// ==========================================

const FFmpegService = {
  checkBinary: (binary: string): Promise<void> => {
    return new Promise((resolve, reject) => {
      const proc = spawn(binary, ["-version"]);
      proc.on("error", () => reject(new Error(`${binary} not found`)));
      proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${binary} error`))));
    });
  },

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
      proc.stdout.on("data", (chunk) => {
        data += chunk;
      });
      proc.on("close", () => {
        const height = parseInt(data.trim(), 10);
        resolve(Number.isNaN(height) ? 0 : height);
      });
    });
  },

  getEncodingTag: (filePath: string): Promise<string | null> => {
    return new Promise((resolve) => {
      const args = [
        "-v",
        "error",
        "-show_entries",
        "format_tags=comment",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        filePath,
      ];
      const proc = spawn("ffprobe", args);
      let data = "";
      proc.stdout.on("data", (chunk) => {
        data += chunk;
      });
      proc.on("close", () => {
        resolve(data.trim());
      });
    });
  },

  convert: async (
    input: string,
    output: string,
    opts: ConversionOptions,
    targetHeight: number,
  ): Promise<void> => {
    const inputHeight = await FFmpegService.getHeight(input);

    return new Promise((resolve, reject) => {
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
        "-metadata",
        "comment=Encoded using @imlokesh/easy-hevc",
      ];

      if (inputHeight > targetHeight) {
        Logger.info(`Downscaling: ${inputHeight}p -> ${targetHeight}p`);
        args.push("-vf", `scale=-2:${targetHeight}`);
      } else {
        Logger.info(`Keeping resolution: ${inputHeight || "unknown"}p`);
      }

      args.push("-y", output);

      const proc = spawn("ffmpeg", args);

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
    } catch {
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

  copyStats: async (source: string, dest: string) => {
    try {
      const stats = await fs.stat(source);
      await fs.utimes(dest, stats.atime, stats.mtime);
    } catch {
      Logger.warn("Could not copy file timestamps.");
    }
  },
};

// ==========================================
// 5. Command Logic: CONVERT
// ==========================================

const runConvert = async (opts: ConversionOptions) => {
  Logger.header("Starting Video Compression");

  try {
    await FFmpegService.checkBinary("ffmpeg");
    await FFmpegService.checkBinary("ffprobe");
  } catch (e: unknown) {
    if (e instanceof Error) Logger.error(e.message);
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
  let conflictPolicy: "ask" | "always" | "never" = "ask";

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const fileInfo = path.parse(file);
    const baseName = fileInfo.name;

    Logger.divider();
    Logger.info(`[${i + 1}/${files.length}] Processing: ${fileInfo.base}`);

    if (baseName.endsWith(opts.suffix)) {
      Logger.skip("Skipping: File appears to be an output file.");
      continue;
    }

    // --- METADATA CHECK START ---
    const tag = await FFmpegService.getEncodingTag(file);
    const isAlreadyConverted = tag === "Encoded using @imlokesh/easy-hevc";

    if (isAlreadyConverted) {
      if (conflictPolicy === "never") {
        Logger.skip("Skipping previously converted file.");
        continue;
      }

      if (conflictPolicy === "ask") {
        const answer = await Logger.askConflict(fileInfo.base);

        if (answer === "no") {
          Logger.skip("Skipped by user.");
          continue;
        }
        if (answer === "no_all") {
          conflictPolicy = "never";
          Logger.skip("Skipping all future conflicts.");
          continue;
        }
        if (answer === "yes_all") {
          conflictPolicy = "always";
        }
        // If 'yes', proceed.
      }
      // If 'always', proceed.
    }
    // --- METADATA CHECK END ---

    const outputName = `${baseName}${opts.suffix}.mkv`;
    const tempName = `${baseName}${opts.suffix}.temp.mkv`;
    const outputPath = path.join(fileInfo.dir, outputName);
    const tempPath = path.join(fileInfo.dir, tempName);

    if (await FileService.exists(outputPath)) {
      Logger.skip("Skipping: Converted file already exists.");
      continue;
    }

    try {
      await FFmpegService.convert(file, tempPath, opts, parseInt(opts.resolution, 10));

      if (opts.preserveDates) {
        await FileService.copyStats(file, tempPath);
        Logger.info("📅 Timestamps preserved.");
      }

      const originalSize = await FileService.getSize(file);
      const newSize = await FileService.getSize(tempPath);
      const savedBytes = originalSize - newSize;
      const savedPercent = ((savedBytes / originalSize) * 100).toFixed(1);

      if (savedBytes > 0) {
        Logger.success(
          `Done! ${Logger.formatBytes(originalSize)} -> ${Logger.formatBytes(newSize)}`,
        );
        Logger.success(`Saved: ${Logger.formatBytes(savedBytes)} (${savedPercent}%)`);

        await fs.rename(tempPath, outputPath);

        if (opts.deleteOriginal) {
          await fs.unlink(file);
          Logger.info("🗑️  Original file deleted.");
        }
        totalSaved += savedBytes;
        successCount++;
      } else {
        Logger.warn(`File grew by ${Logger.formatBytes(Math.abs(savedBytes))}. keeping original.`);
        await fs.rename(tempPath, outputPath);
      }
    } catch (err: unknown) {
      if (err instanceof Error) {
        Logger.error(`Conversion Failed: ${err.message}`);
      }
      if (await FileService.exists(tempPath)) await fs.unlink(tempPath);
    }
  }

  Logger.header("Summary");
  Logger.info(`Processed: ${files.length}`);
  Logger.success(`Successful: ${successCount}`);
  Logger.info(`Total Space Saved: ${Logger.formatBytes(totalSaved)}`);
};

// ==========================================
// 6. Command Logic: FINALIZE
// ==========================================

const runFinalize = async (opts: FinalizeOptions) => {
  Logger.header("Finalize / Cleanup Mode");
  Logger.info(`Scanning: ${opts.input}`);
  Logger.info(`Looking for files with suffix: "${opts.suffix}"`);

  const allFiles = await FileService.scan(opts.input);

  // Categorize files
  const convertedFiles: string[] = [];
  const unconvertedFiles: string[] = [];

  for (const file of allFiles) {
    const { name } = path.parse(file);
    if (name.endsWith(opts.suffix)) {
      convertedFiles.push(file);
    } else {
      unconvertedFiles.push(file);
    }
  }

  // Analyze Pairs
  const toProcess: Array<{
    original?: string;
    converted: string;
    cleanName: string;
  }> = [];
  const notConvertedYet: string[] = [];

  // Check processed files
  for (const converted of convertedFiles) {
    const dir = path.dirname(converted);
    const name = path.basename(converted, path.extname(converted)); // name without ext
    const baseParams = name.substring(0, name.length - opts.suffix.length); // remove suffix

    // We want the final file to be baseParams.mkv (since we converted to mkv)
    const finalCleanPath = path.join(dir, `${baseParams}.mkv`);

    // Find if original exists.
    const original = unconvertedFiles.find((u) => {
      const uParams = path.parse(u);
      return uParams.dir === dir && uParams.name === baseParams;
    });

    toProcess.push({
      original: original,
      converted: converted,
      cleanName: finalCleanPath,
    });
  }

  // Check for completely untouched files
  for (const original of unconvertedFiles) {
    const { name } = path.parse(original);
    // Is this file represented in our "toProcess" list?
    const isAccountedFor = toProcess.some((p) => p.original === original);

    // Also check if it looks like a temp file
    if (!isAccountedFor && !name.includes(".temp")) {
      notConvertedYet.push(original);
    }
  }

  // --- Reporting ---
  Logger.divider();
  Logger.info(`Found ${convertedFiles.length} converted files.`);
  Logger.info(`Found ${notConvertedYet.length} unprocessed (original) files.`);

  if (notConvertedYet.length > 0) {
    Logger.warn("WARNING: The following files have NOT been converted yet:");
    notConvertedYet.slice(0, 5).forEach((f) => {
      console.log(`   - ${path.basename(f)}`);
    });
    if (notConvertedYet.length > 5) console.log(`   ... and ${notConvertedYet.length - 5} more.`);

    if (!opts.force) {
      const proceed = await Logger.confirm(
        "Do you want to continue cleaning up the converted files anyway?",
      );
      if (!proceed) {
        console.log("Exiting.");
        process.exit(0);
      }
    }
  } else if (convertedFiles.length === 0) {
    Logger.warn("No converted files found to finalize.");
    process.exit(0);
  } else {
    if (!opts.force) {
      const proceed = await Logger.confirm(
        `Ready to replace ${toProcess.length} original files with converted versions? This cannot be undone.`,
      );
      if (!proceed) {
        console.log("Exiting.");
        process.exit(0);
      }
    }
  }

  // --- Execution ---
  Logger.header("Executing Cleanup");

  let deletedCount = 0;
  let renamedCount = 0;

  for (const item of toProcess) {
    try {
      // 1. If original exists, delete it
      if (item.original) {
        await fs.unlink(item.original);
        deletedCount++;
        Logger.info(`🗑️  Deleted Original: ${path.basename(item.original)}`);
      }

      // 2. Rename converted to clean name
      // Check if we are renaming 'video_converted.mkv' -> 'video.mkv'
      if (item.converted !== item.cleanName) {
        await fs.rename(item.converted, item.cleanName);
        renamedCount++;
        Logger.success(
          `RENAME: ${path.basename(item.converted)} -> ${path.basename(item.cleanName)}`,
        );
      }
    } catch (e: unknown) {
      if (e instanceof Error) {
        Logger.error(`Failed on ${path.basename(item.converted)}: ${e.message}`);
      }
    }
  }

  Logger.divider();
  Logger.success(`Cleanup Complete.`);
  Logger.info(`Originals Deleted: ${deletedCount}`);
  Logger.info(`Files Renamed: ${renamedCount}`);
};

// ==========================================
// 7. Main Entry Point
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
            choices: ["2160", "1440", "1080", "720", "540", "480", "360"],
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
          "preserve-dates": {
            type: "boolean",
            default: true,
            negatable: true,
            description: "Keep original file modification timestamps",
          },
        },
      },
      finalize: {
        description: "Delete originals and rename converted files to replace them.",
        options: {
          input: {
            type: "string",
            short: "i",
            required: true,
            description: "Input folder to clean",
          },
          suffix: {
            type: "string",
            short: "s",
            default: "_converted",
            env: "HEVC_SUFFIX",
            description: "Suffix to look for",
          },
          force: {
            type: "boolean",
            short: "f",
            default: false,
            description: "Skip confirmation prompts",
          },
        },
      },
    },
  });

  if (command === "convert") {
    await runConvert({
      input: commandOptions.input as string,
      suffix: commandOptions.suffix as string,
      resolution: commandOptions.resolution as Resolution,
      crf: commandOptions.crf as number,
      preset: commandOptions.preset as string,
      deleteOriginal: commandOptions["delete-original"] as boolean,
      preserveDates: commandOptions["preserve-dates"] as boolean,
    });
  } else if (command === "finalize") {
    await runFinalize({
      input: commandOptions.input as string,
      suffix: commandOptions.suffix as string,
      force: commandOptions.force as boolean,
    });
  }
};

main();
