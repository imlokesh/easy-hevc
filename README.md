# Easy HEVC

Easy HEVC is a command-line tool that helps you convert videos to HEVC (H.265) in bulk. 

It scans folders recursively, converts supported video files with FFmpeg, and keeps your originals safe until you decide to finalize. It automatically detects already converted files and warns you if the output video is larger that input. 

Use this tool to instantly cleanup massive storage space by converting large video files to a more effecient format. As the conversion is lossy, it is only recommended for archived videos (files you may only rarely need in future), unless you know what you're doing. 

## Why use it?

- Convert many videos in one run (including nested folders).
- Reduce storage usage with configurable quality settings.
- Review converted files before deleting originals.
- Preserve useful metadata so converted files can still be traced back to their source.

## Prerequisites

Install **FFmpeg** (includes `ffprobe`) and make sure it is available in your `PATH`.

- **macOS:** `brew install ffmpeg`
- **Ubuntu / Debian:** `sudo apt install ffmpeg`
- **Windows:** `winget install ffmpeg`

## Installation

Install with Bun:

```bash
bun add -g easy-hevc
```

## Quick start

### 1) Convert videos

Run conversion on a file or directory:

```bash
easy-hevc -i /path/to/videos
```

Example with custom quality and resolution:

```bash
easy-hevc -i . --crf 23 --resolution 720
```

Process larger files first:

```bash
easy-hevc -i . --sort-by-size
```

### 2) Review output

Check converted files and verify quality/size savings.

### 3) Finalize

Once you're happy, replace originals with converted files:

```bash
easy-hevc finalize -i /path/to/videos
```

Preview finalize actions without making changes:

```bash
easy-hevc finalize -i /path/to/videos --dry-run
```

## Commands

### `convert` (default)

Converts videos to HEVC/H.265.

```text
-i, --input                 Input file or folder (required)
-s, --suffix                Output suffix (default: _converted)
    --resolution            Output height (default: 1080)
                            choices: 2160|1440|1080|720|540|480|360
    --crf                   Constant Rate Factor (default: 24)
    --preset                Encoder preset (default: medium)
                            choices: fast|medium|slow|veryslow
    --delete-original       Delete source if converted file is smaller
    --preserve-dates        Preserve modification timestamps (default: true)
    --no-preserve-dates
    --sort-by-size          Convert largest files first
-h, --help                  Show help
```

### `finalize`

Deletes originals and renames converted files to replace them.

```text
-i, --input                 Input folder (required)
-f, --force                 Skip confirmation prompts
-d, --dry-run               Simulate actions only
-h, --help                  Show help
```

## Typical workflow

1. Run `easy-hevc -i <folder>`.
2. Inspect results and spot-check playback quality.
3. Run `easy-hevc finalize -i <folder> --dry-run`.
4. Run `easy-hevc finalize -i <folder>` when ready.

This two-step workflow helps avoid accidental data loss.
