#!/usr/bin/env node

/**
 * Easy HEVC - Modern Video Compressor
 *
 * A CLI tool to batch convert video files to HEVC (H.265) aiming for high efficiency
 * and reduced disk usage. Includes features for recursive scanning, conflict resolution,
 * and safe replacement of original files.
 */

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import * as readline from "node:readline";
import clide from "@imlokesh/clide";

// ==========================================
// 1. Types & Interfaces
// ==========================================

/** Supported output resolutions for video scaling */
enum Resolution {
  R4K = "2160",
  R2K = "1440",
  R1080 = "1080",
  R720 = "720",
  R540 = "540",
  R480 = "480",
  R360 = "360",
}

/** Configuration options for the conversion process */
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

/** Configuration options for the cleanup process */
interface FinalizeOptions {
  /** Input directory to scan for converted/original pairs */
  input: string;
  /** Suffix used to identify converted files */
  suffix: string;
  /** If true, skips confirmation prompts */
  force: boolean;
  /** If true, simulates actions without modifying the disk */
  dryRun: boolean;
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

  /** Formats bytes into human-readable string (KB, MB, GB) */
  formatBytes: (bytes: number): string => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));
    return `${parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`;
  },

  /** Prompts the user with a Yes/No question */
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

  /** Prompts the user when a file has already been converted */
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

  /** Prompts the user when the converted file is larger than the original */
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
      console.log("   [S] Skip to All"); // <--- ADDED

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
            // <--- ADDED
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

// ==========================================
// 3. FFmpeg Service
// ==========================================

const FFmpegService = {
  /** Verifies that a binary (ffmpeg/ffprobe) exists and is executable */
  checkBinary: (binary: string): Promise<void> => {
    return new Promise((resolve, reject) => {
      const proc = spawn(binary, ["-version"]);
      proc.on("error", () => reject(new Error(`${binary} not found`)));
      proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${binary} error`))));
    });
  },

  /** Extracts video height using ffprobe */
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

  /** Reads the 'comment' metadata tag to check if we processed this file */
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

  /** Executes the FFmpeg conversion process */
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
        "comment=Encoded using @imlokesh/easy-hevc", // Tag for future detection
      ];

      // Smart Resolution Scaling
      if (inputHeight > targetHeight) {
        Logger.info(`Downscaling: ${inputHeight}p -> ${targetHeight}p`);
        args.push("-vf", `scale=-2:${targetHeight}`);
      } else {
        Logger.info(`Keeping resolution: ${inputHeight || "unknown"}p`);
      }

      args.push("-y", output); // Overwrite temp file if exists

      const proc = spawn("ffmpeg", args);

      // Parse stderr for progress (ffmpeg sends updates to stderr)
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

  /** Recursively scans a directory for video files */
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

  /** Safely checks if a file exists */
  exists: async (filePath: string): Promise<boolean> => {
    try {
      await fs.access(filePath, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  },

  /** Gets file size in bytes */
  getSize: async (filePath: string) => (await fs.stat(filePath)).size,

  /** Copies access and modification time from source to dest */
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

  // Step 1: Dependencies Check
  try {
    await FFmpegService.checkBinary("ffmpeg");
    await FFmpegService.checkBinary("ffprobe");
  } catch (e: unknown) {
    if (e instanceof Error) Logger.error(e.message);
    process.exit(1);
  }

  // Step 2: Scan for Files
  const files = await FileService.scan(opts.input);
  if (files.length === 0) {
    Logger.warn("No video files found.");
    process.exit(0);
  }

  Logger.info(`Found ${files.length} files. Target: ${opts.resolution}p, CRF: ${opts.crf}`);

  let totalSaved = 0;
  let successCount = 0;
  let conflictPolicy: "ask" | "always" | "never" = "ask";

  // Step 3: Iterate through files
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const fileInfo = path.parse(file);
    const baseName = fileInfo.name;

    Logger.divider();
    Logger.info(`[${i + 1}/${files.length}] Processing: ${fileInfo.base}`);

    // Check if this is likely an output file to avoid infinite loops
    if (baseName.endsWith(opts.suffix)) {
      Logger.skip("Skipping: File appears to be an output file.");
      continue;
    }

    // Step 4: Check if already converted (by metadata)
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

    // Step 5: Prepare Paths
    const outputName = `${baseName}${opts.suffix}.mkv`;
    const tempName = `${baseName}${opts.suffix}.temp.mkv`;
    const outputPath = path.join(fileInfo.dir, outputName);
    const tempPath = path.join(fileInfo.dir, tempName);

    if (await FileService.exists(outputPath)) {
      Logger.skip("Skipping: Converted file already exists.");
      continue;
    }

    // Step 6: Convert
    try {
      await FFmpegService.convert(file, tempPath, opts, parseInt(opts.resolution, 10));

      if (opts.preserveDates) {
        await FileService.copyStats(file, tempPath);
        Logger.info("📅 Timestamps preserved.");
      }

      // Step 7: Size Comparison & Finalizing
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
  Logger.header(opts.dryRun ? "Finalize (DRY RUN MODE)" : "Finalize / Cleanup Mode");
  Logger.info(`Scanning: ${opts.input}`);
  Logger.info(`Looking for files with suffix: "${opts.suffix}"`);

  // Step 1: Scan all files
  const allFiles = await FileService.scan(opts.input);

  // Step 2: Categorize files (Converted vs Others)
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

  // Step 3: Match Pairs (Original <-> Converted)
  const toProcess: Array<{
    original?: string;
    converted: string;
    cleanName: string;
  }> = [];
  const notConvertedYet: string[] = [];

  for (const converted of convertedFiles) {
    const dir = path.dirname(converted);
    const name = path.basename(converted, path.extname(converted));
    const baseParams = name.substring(0, name.length - opts.suffix.length);
    const finalCleanPath = path.join(dir, `${baseParams}.mkv`);

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

  // Step 4: Identify Unprocessed Files
  for (const original of unconvertedFiles) {
    const { name } = path.parse(original);
    const isAccountedFor = toProcess.some((p) => p.original === original);
    if (!isAccountedFor && !name.includes(".temp")) {
      notConvertedYet.push(original);
    }
  }

  // Step 5: Report Findings
  Logger.divider();
  Logger.info(`Found ${convertedFiles.length} converted files.`);
  Logger.info(`Found ${notConvertedYet.length} unprocessed (original) files.`);

  if (notConvertedYet.length > 0) {
    Logger.warn("WARNING: The following files have NOT been converted yet:");
    notConvertedYet.slice(0, 5).forEach((f) => {
      console.log(`   - ${path.basename(f)}`);
    });
    if (notConvertedYet.length > 5) console.log(`   ... and ${notConvertedYet.length - 5} more.`);

    // Skip confirmation in Dry Run
    if (!opts.force && !opts.dryRun) {
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
    // Skip confirmation in Dry Run
    if (!opts.force && !opts.dryRun) {
      const proceed = await Logger.confirm(
        `Ready to replace ${toProcess.length} original files with converted versions? This cannot be undone.`,
      );
      if (!proceed) {
        console.log("Exiting.");
        process.exit(0);
      }
    }
  }

  // Step 6: Execution Loop
  Logger.header(opts.dryRun ? "Simulating Cleanup..." : "Executing Cleanup");

  let deletedCount = 0;
  let renamedCount = 0;
  let largerFilePolicy: "ask" | "delete_converted" | "keep_converted" | "skip_all" = "ask";

  for (const item of toProcess) {
    try {
      let skipReplacement = false;

      // Sub-step: Check if converted file is unexpectedly larger
      if (item.original) {
        const oSize = await FileService.getSize(item.original);
        const cSize = await FileService.getSize(item.converted);

        if (cSize > oSize) {
          if (opts.dryRun) {
            Logger.warn(
              `[DRY RUN] ⚠️  ${path.basename(item.converted)} is larger than original. User would be prompted.`,
            );
            // In dry run, we assume we don't proceed with this specific file to be safe
            skipReplacement = true;
          } else {
            let action = "ask";

            if (largerFilePolicy === "delete_converted") action = "yes";
            else if (largerFilePolicy === "keep_converted") action = "no";
            else if (largerFilePolicy === "skip_all") action = "skip";

            if (action === "ask") {
              const answer = await Logger.askLargerFile(
                path.basename(item.converted),
                oSize,
                cSize,
              );
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
              await fs.unlink(item.converted);
              Logger.info(`🗑️  Deleted Larger Converted File: ${path.basename(item.converted)}`);
              skipReplacement = true;
            } else if (action === "skip") {
              Logger.skip(`Skipping cleanup for: ${path.basename(item.original)}`);
              skipReplacement = true;
            }
          }
        }
      }

      if (skipReplacement) continue;

      // Sub-step: Delete Original
      if (item.original) {
        if (opts.dryRun) {
          Logger.info(`[DRY RUN] Would delete original: ${path.basename(item.original)}`);
          deletedCount++;
        } else {
          await fs.unlink(item.original);
          deletedCount++;
          Logger.info(`🗑️  Deleted Original: ${path.basename(item.original)}`);
        }
      }

      // Sub-step: Rename Converted -> Clean Name
      if (item.converted !== item.cleanName) {
        if (opts.dryRun) {
          Logger.success(
            `[DRY RUN] Would rename: ${path.basename(item.converted)} -> ${path.basename(item.cleanName)}`,
          );
          renamedCount++;
        } else {
          await fs.rename(item.converted, item.cleanName);
          renamedCount++;
          Logger.success(
            `RENAME: ${path.basename(item.converted)} -> ${path.basename(item.cleanName)}`,
          );
        }
      }
    } catch (e: unknown) {
      if (e instanceof Error) {
        Logger.error(`Failed on ${path.basename(item.converted)}: ${e.message}`);
      }
    }
  }

  Logger.divider();
  Logger.success(opts.dryRun ? "Dry Run Complete." : "Cleanup Complete.");
  Logger.info(`Originals Deleted: ${deletedCount}`);
  Logger.info(`Files Renamed: ${renamedCount}`);
};

// ==========================================
// 7. Main Entry Point
// ==========================================

const main = async () => {
  // Initialize CLI with @imlokesh/clide
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
      suffix: commandOptions.suffix as string,
      force: commandOptions.force as boolean,
      dryRun: commandOptions["dry-run"] as boolean,
    });
  }
};

main();
