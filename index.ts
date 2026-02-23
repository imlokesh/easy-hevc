#!/usr/bin/env node

/**
 * Easy HEVC
 * Batch converts videos to HEVC (H.265) to save disk space.
 * Features: recursive directory scanning, conflict resolution, and in-place replacement.
 */

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import * as readline from "node:readline";
import clide from "@imlokesh/clide";

// --- Types & Interfaces ---

/** Supported resolutions for video downscaling */
enum Resolution {
  R4K = "2160",
  R2K = "1440",
  R1080 = "1080",
  R720 = "720",
  R540 = "540",
  R480 = "480",
  R360 = "360",
}

/** CLI options for the `convert` command */
interface ConversionOptions {
  /** Input directory or file path */
  input: string;
  /** Suffix to append to converted files (e.g., "_hevc") */
  suffix: string;
  /** Target resolution height (e.g., "1080") */
  resolution: Resolution;
  /** Constant Rate Factor (0-51). Lower is better quality. */
  crf: number;
  /** FFmpeg preset (e.g., "fast", "medium", "slow") */
  preset: string;
  /** If true, deletes the original file immediately if conversion saves space */
  deleteOriginal: boolean;
  /** If true, copies file modification times to the new file */
  preserveDates: boolean;
}

/** CLI options for the `finalize` command */
interface FinalizeOptions {
  /** Input directory to scan for converted/original pairs */
  input: string;
  /** If true, skips confirmation prompts */
  force: boolean;
  /** If true, simulates actions without modifying the disk */
  dryRun: boolean;
}

// --- Logger & UI Prompts ---

const Logger = {
  info: (msg: string) => console.log(msg),
  success: (msg: string) => console.log(`  ✅ ${msg}`),
  warn: (msg: string) => console.log(`  ⚠️  ${msg}`),
  error: (msg: string) => console.error(`  ❌ ${msg}`),
  skip: (msg: string) => console.log(`  ⏭️  ${msg}`),
  progress: (msg: string) => process.stdout.write(`  ⏳ ${msg.padEnd(60, " ")}\r`),

  clearLine: () => {
    if (process.stdout.isTTY) {
      process.stdout.clearLine(0);
      process.stdout.cursorTo(0);
    } else {
      process.stdout.write("\n");
    }
  },

  header: (msg: string) => console.log(`\n=== ${msg} ===\n`),
  divider: () => console.log("-".repeat(50)),

  /** Formats bytes into a human-readable string */
  formatBytes: (bytes: number): string => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));
    return `${parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`;
  },

  /** Formats milliseconds into a human-readable duration */
  formatDuration: (ms: number): string => {
    const seconds = Math.floor((ms / 1000) % 60);
    const minutes = Math.floor((ms / (1000 * 60)) % 60);
    const hours = Math.floor((ms / (1000 * 60 * 60)) % 24);
    const parts = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
    return parts.join(" ");
  },

  /** CLI Yes/No prompt */
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

  /** Conflict resolution prompt for already-encoded files */
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
            ask();
          }
        });
      };
      ask();
    });
  },

  /** Conflict resolution for oversized converted files */
  askLargerFile: (
    filename: string,
    origSize: number,
    convSize: number,
  ): Promise<"yes" | "yes_all" | "no" | "no_all" | "skip" | "skip_all"> => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise((resolve) => {
      console.log(`\n⚠️  Converted file "${filename}" is larger than original!`);
      console.log(`   Original:  ${Logger.formatBytes(origSize)}`);
      console.log(`   Converted: ${Logger.formatBytes(convSize)}`);
      console.log("\n   Do you want to delete the converted file instead?");
      console.log("   [y] Yes (delete converted, keep original)");
      console.log("   [n] No (delete original, keep converted)");
      console.log("   [s] Skip (keep both, do nothing)");
      console.log("   [A] Yes to All");
      console.log("   [N] No to All");
      console.log("   [S] Skip to All");

      const ask = () => {
        rl.question(`   Select option: `, (ans) => {
          const a = ans.trim();

          if (a === "A") {
            rl.close();
            resolve("yes_all");
          } else if (a === "N") {
            rl.close();
            resolve("no_all");
          } else if (a === "S") {
            rl.close();
            resolve("skip_all");
          } else if (a.toLowerCase() === "y" || a.toLowerCase() === "yes") {
            rl.close();
            resolve("yes");
          } else if (a.toLowerCase() === "n" || a.toLowerCase() === "no") {
            rl.close();
            resolve("no");
          } else if (a.toLowerCase() === "s" || a.toLowerCase() === "skip") {
            rl.close();
            resolve("skip");
          } else {
            console.log("   ❌ Invalid option. Please try again.");
            ask();
          }
        });
      };
      ask();
    });
  },
};

// --- FFmpeg Utilities ---

const FFmpegService = {
  /** Checks if a required binary exists in PATH */
  checkBinary: (binary: string): Promise<void> => {
    return new Promise((resolve, reject) => {
      const proc = spawn(binary, ["-version"]);
      proc.on("error", () => reject(new Error(`${binary} not found`)));
      proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${binary} error`))));
    });
  },

  /** Extracts video duration in seconds using ffprobe */
  getDuration: (filePath: string): Promise<number> => {
    return new Promise((resolve) => {
      const args = [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        filePath,
      ];
      const proc = spawn("ffprobe", args);
      let data = "";
      proc.stdout.on("data", (chunk) => {
        data += chunk.toString();
      });
      proc.on("close", () => {
        const duration = parseFloat(data.trim());
        resolve(Number.isNaN(duration) ? 0 : duration);
      });
    });
  },

  /** Extracts video resolution height using ffprobe */
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

  /** Reads the metadata 'easy_hevc_original_file' tag to detect prior encoding and fetch original filename */
  getOriginalFilenameTag: (filePath: string): Promise<string | null> => {
    return new Promise((resolve) => {
      const args = [
        "-v",
        "error",
        "-show_entries",
        "format_tags=easy_hevc_original_file",
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
        const result = data.trim();
        resolve(result ? result : null);
      });
    });
  },

  /** Executes FFmpeg to encode and optionally downscale the video. Returns elapsed time in ms. */
  convert: async (
    input: string,
    output: string,
    opts: ConversionOptions,
    targetHeight: number,
  ): Promise<number> => {
    const inputHeight = await FFmpegService.getHeight(input);
    const originalFilename = path.basename(input);
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const args = [
        "-i",
        input,
        "-map",
        "0", // Map all streams
        "-c:v",
        "libx265",
        "-crf",
        String(opts.crf),
        "-preset",
        opts.preset,
        "-c:a",
        "copy", // Passthrough audio
        "-c:s",
        "copy", // Passthrough subtitles
        "-metadata",
        `easy_hevc_original_file=${originalFilename}`,
        "-metadata",
        `easy_hevc_original_resolution=${inputHeight}p`,
        "-metadata",
        `easy_hevc_crf=${opts.crf}`,
        "-metadata",
        `easy_hevc_preset=${opts.preset}`,
      ];

      // Evaluate resolution scaling
      if (inputHeight > targetHeight) {
        Logger.info(`Downscaling: ${inputHeight}p -> ${targetHeight}p`);
        args.push("-vf", `scale=-2:${targetHeight}`);
        args.push("-metadata", `easy_hevc_target_resolution=${targetHeight}p`);
      } else {
        Logger.info(`Keeping resolution: ${inputHeight || "unknown"}p`);
        args.push("-metadata", `easy_hevc_target_resolution=${inputHeight}p (original)`);
      }

      args.push("-y", output); // Overwrite target if exists

      const proc = spawn("ffmpeg", args);

      // Parse stderr for progress and speed (ffmpeg sends updates to stderr)
      proc.stderr.on("data", (chunk) => {
        const line = chunk.toString();

        const timeMatch = line.match(/time=([0-9:.]+)/);
        const speedMatch = line.match(/speed=\s*([\d.]+x)/);

        let progressStr = "Encoding...";
        if (timeMatch) progressStr += ` ${timeMatch[1]}`;
        if (speedMatch) progressStr += ` (Speed: ${speedMatch[1]})`;

        if (timeMatch || speedMatch) {
          Logger.progress(progressStr);
        }
      });

      proc.on("close", (code) => {
        Logger.clearLine();
        const endTime = Date.now();
        if (code === 0) resolve(endTime - startTime);
        else reject(new Error(`FFmpeg exited with code ${code}`));
      });

      proc.on("error", (err) => reject(err));
    });
  },
};

// --- File System Operations ---

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
    ".ts",
  ]),

  /** Recursively locates all valid video files in a directory */
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

  /** Checks if a file exists on disk */
  exists: async (filePath: string): Promise<boolean> => {
    try {
      await fs.access(filePath, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  },

  /** Returns the size of a file in bytes */
  getSize: async (filePath: string) => (await fs.stat(filePath)).size,

  /** Preserves file access and modification timestamps */
  copyStats: async (source: string, dest: string) => {
    try {
      const stats = await fs.stat(source);
      await fs.utimes(dest, stats.atime, stats.mtime);
    } catch {
      Logger.warn("Could not copy file timestamps.");
    }
  },
};

// --- Primary Command: Convert ---

const runConvert = async (opts: ConversionOptions) => {
  Logger.header("Starting Video Compression");

  // Verify CLI dependencies
  try {
    await FFmpegService.checkBinary("ffmpeg");
    await FFmpegService.checkBinary("ffprobe");
  } catch (e: unknown) {
    if (e instanceof Error) Logger.error(e.message);
    process.exit(1);
  }

  // Build file collection
  const files = await FileService.scan(opts.input);
  if (files.length === 0) {
    Logger.warn("No video files found.");
    process.exit(0);
  }

  Logger.info(`Found ${files.length} files. Target: ${opts.resolution}p, CRF: ${opts.crf}`);

  let totalSaved = 0;
  let successCount = 0;
  let conflictPolicy: "ask" | "always" | "never" = "ask";

  // Process files sequentially
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const fileInfo = path.parse(file);
    const baseName = fileInfo.name;

    Logger.divider();
    Logger.info(`[${i + 1}/${files.length}] Processing: ${fileInfo.base}`);

    // Pre-validation: Check duration to ensure it's a valid video file
    const originalDuration = await FFmpegService.getDuration(file);
    if (originalDuration <= 0) {
      Logger.skip("Skipping: Invalid video file or unable to read duration.");
      continue;
    }

    // Skip output files to prevent processing loops
    if (baseName.endsWith(opts.suffix)) {
      Logger.skip("Skipping: File appears to be an output file.");
      continue;
    }

    // Skip previously encoded files by checking for our custom tag
    const originalFileTag = await FFmpegService.getOriginalFilenameTag(file);
    const isAlreadyConverted = !!originalFileTag;

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

    // Define target paths
    const outputName = `${baseName}${opts.suffix}.mkv`;
    const tempName = `${baseName}${opts.suffix}.temp.mkv`;
    const outputPath = path.join(fileInfo.dir, outputName);
    const tempPath = path.join(fileInfo.dir, tempName);

    if (await FileService.exists(outputPath)) {
      Logger.skip("Skipping: Converted file already exists.");
      continue;
    }

    // Execute encoding process
    try {
      const elapsedMs = await FFmpegService.convert(
        file,
        tempPath,
        opts,
        parseInt(opts.resolution, 10),
      );

      // Post-conversion validation: Compare durations to ensure completeness
      const convertedDuration = await FFmpegService.getDuration(tempPath);

      if (convertedDuration <= 0 || Math.abs(originalDuration - convertedDuration) > 2) {
        Logger.error(
          `Duration mismatch! Original: ${originalDuration.toFixed(1)}s, Converted: ${convertedDuration.toFixed(1)}s`,
        );
        Logger.error("Conversion likely failed or truncated. Cleaning up temp file.");
        if (await FileService.exists(tempPath)) await fs.unlink(tempPath);
        continue;
      }

      if (opts.preserveDates) {
        await FileService.copyStats(file, tempPath);
      }

      // Evaluate space savings and replace if optimal
      const originalSize = await FileService.getSize(file);
      const newSize = await FileService.getSize(tempPath);
      const savedBytes = originalSize - newSize;
      const savedPercent = ((savedBytes / originalSize) * 100).toFixed(1);
      const formattedTime = Logger.formatDuration(elapsedMs);

      if (savedBytes > 0) {
        Logger.success(
          `Done in ${formattedTime}! ${Logger.formatBytes(originalSize)} -> ${Logger.formatBytes(newSize)}`,
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
        Logger.warn(
          `File grew by ${Logger.formatBytes(Math.abs(savedBytes))} (Took ${formattedTime}). Keeping original.`,
        );
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

// --- Subcommand: Finalize ---

const runFinalize = async (opts: FinalizeOptions) => {
  Logger.header(opts.dryRun ? "Finalize (DRY RUN MODE)" : "Finalize / Cleanup Mode");
  Logger.info(`Scanning: ${opts.input}`);

  // Locate all video files and filter specifically for MKVs
  const allFiles = await FileService.scan(opts.input);
  const mkvFiles = allFiles.filter((f) => f.toLowerCase().endsWith(".mkv"));

  const toProcess: Array<{
    mkvPath: string;
    originalPath: string;
    finalPath: string;
    originalExists: boolean;
    needsRename: boolean;
  }> = [];

  // Inspect each MKV for the converted metadata tag
  for (const mkv of mkvFiles) {
    const originalFilename = await FFmpegService.getOriginalFilenameTag(mkv);

    // Skip if it doesn't have the tag (not a converted file)
    if (!originalFilename) continue;

    const dir = path.dirname(mkv);
    const originalPath = path.join(dir, originalFilename);
    const parsedOrig = path.parse(originalFilename);
    const finalPath = path.join(dir, `${parsedOrig.name}.mkv`);

    // Check if the original file still exists.
    // (We also ensure we don't accidentally flag the current MKV as its own original)
    const originalExists = (await FileService.exists(originalPath)) && originalPath !== mkv;

    // Check if the current name already matches the expected final name
    const needsRename = mkv !== finalPath;

    // Only queue it if there is work to do
    if (originalExists || needsRename) {
      toProcess.push({ mkvPath: mkv, originalPath, finalPath, originalExists, needsRename });
    }
  }

  if (toProcess.length === 0) {
    Logger.warn("No converted files found requiring finalization.");
    process.exit(0);
  }

  Logger.divider();
  Logger.info(`Found ${toProcess.length} converted files to process.`);

  // Confirmation prompt (unless skipped by --force or --dry-run)
  if (!opts.force && !opts.dryRun) {
    const proceed = await Logger.confirm(
      `Ready to finalize ${toProcess.length} files? This will delete originals and rename the converted MKVs.`,
    );
    if (!proceed) {
      console.log("Exiting.");
      process.exit(0);
    }
  }

  // Execute the cleanup tasks
  Logger.header(opts.dryRun ? "Simulating Cleanup..." : "Executing Cleanup");

  let deletedCount = 0;
  let renamedCount = 0;
  let largerFilePolicy: "ask" | "delete_converted" | "keep_converted" | "skip_all" = "ask";

  for (const item of toProcess) {
    try {
      let skipReplacement = false;

      if (item.originalExists) {
        // Pre-validation: Compare durations to ensure the MKV is complete
        const oDuration = await FFmpegService.getDuration(item.originalPath);
        const cDuration = await FFmpegService.getDuration(item.mkvPath);

        if (oDuration <= 0 || cDuration <= 0 || Math.abs(oDuration - cDuration) > 2) {
          Logger.error(
            `Duration mismatch! Original: ${oDuration.toFixed(1)}s, Converted: ${cDuration.toFixed(1)}s`,
          );
          Logger.skip(`Skipping cleanup for: ${path.basename(item.originalPath)}`);
          continue; // Skip processing this file completely
        }

        // Check space savings if the original still exists
        const oSize = await FileService.getSize(item.originalPath);
        const cSize = await FileService.getSize(item.mkvPath);

        if (cSize > oSize) {
          if (opts.dryRun) {
            Logger.warn(
              `[DRY RUN] ⚠️  ${path.basename(item.mkvPath)} is larger than original. User would be prompted.`,
            );
            skipReplacement = true;
          } else {
            let action = "ask";

            if (largerFilePolicy === "delete_converted") action = "yes";
            else if (largerFilePolicy === "keep_converted") action = "no";
            else if (largerFilePolicy === "skip_all") action = "skip";

            if (action === "ask") {
              const answer = await Logger.askLargerFile(path.basename(item.mkvPath), oSize, cSize);
              if (answer === "yes_all") {
                largerFilePolicy = "delete_converted";
                action = "yes";
              } else if (answer === "no_all") {
                largerFilePolicy = "keep_converted";
                action = "no";
              } else if (answer === "skip_all") {
                largerFilePolicy = "skip_all";
                action = "skip";
              } else {
                action = answer;
              }
            }

            if (action === "yes") {
              // Delete converted, keep original
              await fs.unlink(item.mkvPath);
              Logger.info(`🗑️  Deleted Larger Converted File: ${path.basename(item.mkvPath)}`);
              skipReplacement = true;
            } else if (action === "skip") {
              Logger.skip(`Skipping cleanup for: ${path.basename(item.originalPath)}`);
              skipReplacement = true;
            }
            // If "no" (delete original, keep converted), we just continue normally
          }
        }
      }

      if (skipReplacement) continue;

      // Step 1: Delete original file if it exists
      if (item.originalExists) {
        if (opts.dryRun) {
          Logger.info(`[DRY RUN] Would delete original: ${path.basename(item.originalPath)}`);
          deletedCount++;
        } else {
          await fs.unlink(item.originalPath);
          Logger.info(`🗑️  Deleted Original: ${path.basename(item.originalPath)}`);
          deletedCount++;
        }
      }

      // Step 2: Rename converted file to the original base name
      if (item.needsRename) {
        if (opts.dryRun) {
          Logger.success(
            `[DRY RUN] Would rename: ${path.basename(item.mkvPath)} -> ${path.basename(item.finalPath)}`,
          );
          renamedCount++;
        } else {
          await fs.rename(item.mkvPath, item.finalPath);
          Logger.success(
            `RENAME: ${path.basename(item.mkvPath)} -> ${path.basename(item.finalPath)}`,
          );
          renamedCount++;
        }
      }
    } catch (e: unknown) {
      if (e instanceof Error) {
        Logger.error(`Failed on ${path.basename(item.mkvPath)}: ${e.message}`);
      }
    }
  }

  Logger.divider();
  Logger.success(opts.dryRun ? "Dry Run Complete." : "Cleanup Complete.");
  Logger.info(`Originals Deleted: ${deletedCount}`);
  Logger.info(`Files Renamed: ${renamedCount}`);
};

// --- Application Entry Point ---

const main = async () => {
  // Initialize CLI framework
  const { command, commandOptions } = await clide({
    description: "easy-hevc - A CLI tool to batch convert video files to HEVC (H.265) format.",
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
            default: "1080",
            env: "HEVC_RES",
            description: "Output file resolution(height). ",
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
          force: {
            type: "boolean",
            short: "f",
            default: false,
            description: "Skip confirmation prompts",
          },
          "dry-run": {
            type: "boolean",
            short: "d",
            default: false,
            description: "Simulate actions without deleting files",
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
      force: commandOptions.force as boolean,
      dryRun: commandOptions["dry-run"] as boolean,
    });
  }
};

main();
