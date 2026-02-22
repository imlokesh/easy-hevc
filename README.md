# 🎬 Easy HEVC

A smart, interactive CLI tool to batch convert your video library to HEVC (H.265) and save massive amounts of disk space. 

**Easy HEVC** recursively scans your folders, encodes videos using FFmpeg, tracks original filenames via MKV metadata, and safely replaces the original files only when space is actually saved.

## ✨ Features

* **Batch & Recursive Scanning:** Point it at a folder, and it finds all the videos.
* **Smart Storage Checks:** Automatically keeps the original file if the "compressed" version ends up being larger.
* **Conflict Resolution:** Pauses to ask what you want to do if it finds previously converted files or encounters size conflicts.
* **Metadata Tagging:** Embeds original filename, resolution, CRF, and preset data directly into the newly converted MKV files for easy tracking.
* **Safe Cleanup:** Separate `convert` and `finalize` commands mean you can verify your encoded videos before deleting the originals. Includes a `--dry-run` mode!



## ⚙️ Prerequisites

You must have **FFmpeg** and **FFprobe** installed and available in your system's PATH.

* **macOS:** `brew install ffmpeg`
* **Linux (Debian/Ubuntu):** `sudo apt install ffmpeg`
* **Windows:** `winget install ffmpeg`



## 🚀 Installation

We recommend [Bun](https://bun.sh/), a blazing-fast JavaScript runtime. Make sure you have Bun installed, then install Easy HEVC globally:

```bash
bun add -g easy-hevc
```


## 🛠️ Usage

```
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
  -h, --help                              Show help information

COMMANDS
  convert (default)    Convert videos to HEVC/H.265
  finalize             Delete originals and rename converted files to replace them.
```

The following command will convert all videos in the current directory to HEVC/H.265:

```
$ easy-hevc -i . --crf 23 --resolution 720
```

### Finalize command

The `finalize` command will delete the original files and rename the converted files to replace them.

```
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