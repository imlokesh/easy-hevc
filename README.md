# Easy HEVC

**Shrink your video library with a simple HEVC conversion workflow.**

Batch-convert a file or folder to HEVC (H.265) using FFmpeg. Review the results before replacing your originals, with optional NVIDIA GPU encoding for faster conversions. Folders are scanned recursively, so one command can process a whole library.

Savings depend on the source and settings; already-efficient videos may not shrink. Conversion is lossy, so keep backups of irreplaceable footage.

## Prerequisites

Install **FFmpeg** (which includes `ffprobe`) and make sure it's on your `PATH`.

- **macOS:** `brew install ffmpeg`
- **Ubuntu / Debian:** `sudo apt install ffmpeg`
- **Windows:** `winget install ffmpeg`

## Installation

```bash
bun add -g easy-hevc
```

## The safe way (recommended)

Start with a folder of videos you want to make smaller. By default, Easy HEVC uses CPU encoding and **downscales videos taller than 1080p to 1080p**. Shorter videos keep their original resolution.

**1. Convert.** Scan a folder and re-encode every video, writing new files *alongside* the originals. Nothing is deleted.

```bash
easy-hevc -i /path/to/videos
```

**2. Review.** Spot-check the converted files for quality and confirm the space savings printed in the summary.

**3. Finalize.** Once you're happy, delete the originals and rename the converted files to take their place.

```bash
easy-hevc finalize -i /path/to/videos
```

Both steps support `--dry-run` so you can preview exactly what will happen before committing.

## Optional NVIDIA GPU encoding

Have an NVIDIA GPU with HEVC encoding support? Select it explicitly:

```bash
easy-hevc -i ./videos --encoder nvidia
```

You need an FFmpeg build containing `hevc_nvenc` and a compatible NVIDIA GPU and driver. Easy HEVC performs a short encoding check before processing the folder and reports setup errors. It does not silently switch to CPU if the check fails. `--dry-run` skips this check, so it does not verify hardware availability.

GPU encoding can reduce encoding time, but quality and file size differ from CPU encoding. Decoding and resizing still use the CPU. Try a representative video and compare the results before processing your library.

Use **`--cq`** for NVIDIA quality (default `24`, integer `1–50`; lower means higher quality and generally larger files):

```bash
easy-hevc -i ./videos --encoder nvidia --cq 22 --preset slow
```

`--crf` and `HEVC_CRF` apply only to CPU encoding; `--cq` applies only to NVIDIA. Matching CRF and CQ numbers do **not** guarantee matching quality. CPU encoding remains the default and needs no NVIDIA hardware.

The same preset names are available for both encoders. NVIDIA maps `fast`, `medium`, `slow`, and `veryslow` to NVENC `p3`, `p4`, `p6`, and `p7`, respectively. The startup output shows the effective encoder, quality, and preset.

## Tuning the conversion

A few options control the quality/size trade-off:

- **`--crf`** (CPU, default `24`, range `1-50`) — the CPU quality dial. **Lower = higher quality and bigger files; higher = smaller files.** Try `21-24` as a starting point and review the results. For NVIDIA, use `--cq` instead.
- **`--resolution`** (default `1080`) — downscales taller videos to this height (e.g. `720`). Videos already at or below the target are left at their native resolution.
- **`--preset`** (default `medium`) — how hard the encoder works. Slower presets (`slow`, `veryslow`) favor compression efficiency but take longer; results depend on the encoder and source.
- **`--sort-by-size`** — converts the largest files first, so you reclaim the most space soonest.

Example, higher CPU quality, keep original resolution for videos up to 2160p:

```bash
easy-hevc -i . --crf 22 --resolution 2160 --preset slow
```

## Advanced: convert and finalize in one command

Once you've reviewed sample conversions and trust your settings, this converts the largest files first and replaces each original when its validated output is smaller:

```bash
easy-hevc -i . --resolution 720 --finalize --crf 21 --sort-by-size
```

> [!WARNING]
> `--finalize` **deletes your original files** as it goes, with no review step. Conversion is lossy and downscaling to 720p is irreversible. Preview the actions with `--dry-run` first and keep backups of irreplaceable footage.

## Safety checks

Easy HEVC tries hard not to waste your time or destroy data. It automatically:

- **Skips already-converted files** by reading metadata it embeds during encoding (and prompts before re-converting).
- **Skips its own output files** so runs are safe to repeat.
- **Warns when a converted file is larger** than the original and lets you keep whichever you prefer.
- **Rejects invalid output durations or differences greater than two seconds during conversion**, keeping the original and removing the temporary output. The separate `finalize` command checks durations again and prompts before accepting a converted file that is more than two seconds shorter.
- **Shows FFmpeg error details** when an encode fails, including hardware or driver errors. Failed encodes and duration validation failures return a nonzero exit status.

These checks do not replace reviewing the picture, sound, and subtitles before finalizing.

## Commands

### `convert` (default)

Converts videos to HEVC/H.265.

```text
-i, --input                 Input file or folder (required)
-s, --suffix                Output suffix (default: _converted)
    --resolution            Output height (default: 1080)
                            choices: 2160|1440|1080|720|540|480|360
    --crf                   Constant Rate Factor, 1-50 (default: 24)
                            CPU only
    --encoder               cpu|nvidia (default: cpu)
    --cq                    NVIDIA quality, integer 1-50 (default: 24)
    --preset                Encoder preset (default: medium)
                            choices: fast|medium|slow|veryslow
    --finalize              Delete the original and rename the converted
                            file in one step (only if it's smaller)
    --preserve-dates        Preserve modification timestamps (default: true)
    --no-preserve-dates
    --sort-by-size          Convert largest files first
-d, --dry-run               Simulate conversions without writing files
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

## Environment variables

Defaults for `convert` can be set via environment variables:

| Variable       | Option         |
| -------------- | -------------- |
| `HEVC_SUFFIX`  | `--suffix`     |
| `HEVC_RES`     | `--resolution` |
| `HEVC_CRF`     | `--crf`        |
| `HEVC_PRESET`  | `--preset`     |

## Supported formats

`.mp4` `.mkv` `.avi` `.mov` `.flv` `.wmv` `.webm` `.m4v` `.mpg` `.mpeg` `.ts`

Converted files are always written as `.mkv`.

## License

MIT
