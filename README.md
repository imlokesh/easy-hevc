# Easy HEVC

Easy HEVC is a command-line tool that batch-converts videos to HEVC (H.265) using FFmpeg.

It scans files recursively, writes conversion metadata into MKV output, and only replaces originals when the new file is actually smaller.

## Why use it?

- **Save storage space** across large video folders.
- **Process folders recursively** without writing scripts.
- **Keep control of cleanup** with separate `convert` and `finalize` steps.
- **Avoid accidental data loss** with prompts and a `--dry-run` mode.

## Prerequisites

Install FFmpeg (includes `ffmpeg` and `ffprobe`) and ensure both are available in your `PATH`.

- **macOS:** `brew install ffmpeg`
- **Linux (Debian/Ubuntu):** `sudo apt install ffmpeg`
- **Windows:** `winget install ffmpeg`

## Installation

Install globally with [Bun](https://bun.sh/):

```bash
bun add -g easy-hevc
```

## Quick start

### 1) Convert videos

Convert all videos in the current directory (and subdirectories):

```bash
easy-hevc -i .
```

A more explicit example:

```bash
easy-hevc -i . --crf 23 --resolution 720
```

To process larger files first:

```bash
easy-hevc -i . --sort-by-size
```

### 2) Review results

Converted files are written with a suffix (default: `_converted`) so originals are kept for review.

### 3) Finalize (optional)

When you are happy with the converted files, replace originals:

```bash
easy-hevc finalize -i .
```

Preview finalize actions without changing files:

```bash
easy-hevc finalize -i . --dry-run
```

## Command reference

```text
$ easy-hevc --help

easy-hevc - A CLI tool to batch convert video files to HEVC (H.265) format.

Global Options
  -h, --help                              Show help information

Default Command Options (convert)
  -i, --input                             Input file or folder <string>, required
  -s, --suffix, HEVC_SUFFIX               Output suffix <string>, default: _converted
      --resolution, HEVC_RES              Output file resolution(height).  <string>, default: 1080
                                          choices: 2160|1440|1080|720|540|480|360
      --crf, HEVC_CRF                     <number>, default: 24
      --preset, HEVC_PRESET               <string>, default: medium
                                          choices: fast|medium|slow|veryslow
      --delete-original                   Delete source if smaller default: false
      --preserve-dates                    Keep original file modification timestamps default: true
      --no-preserve-dates
      --sort-by-size                      Sort files by size before converting (largest first) default: false
  -h, --help                              Show help information

COMMANDS
  convert (default)    Convert videos to HEVC/H.265
  finalize             Delete originals and rename converted files to replace them.
```

### Finalize help

```text
$ easy-hevc finalize --help

Delete originals and rename converted files to replace them.

Command Options (finalize)
  -i, --input                             Input folder to clean <string>, required
  -f, --force                             Skip confirmation prompts default: false
  -d, --dry-run                           Simulate actions without deleting files default: false
  -h, --help                              Show help information

Global Options
  -h, --help                              Show help information
```
