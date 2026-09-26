import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { encoderSettings, runFFmpeg } from "./encoder";
import { type ConversionOptions, FFmpegService, Resolution, runConvert } from "./index";

const defaults: ConversionOptions = {
  input: "",
  encoder: "cpu",
  crf: 24,
  preset: "medium",
  suffix: "_converted",
  resolution: Resolution.R1080,
  finalize: true,
  preserveDates: false,
  sortBySize: false,
  dryRun: false,
};
let directory: string | undefined;
afterEach(async () => {
  mock.restore();
  process.exitCode = 0;
  if (directory) await fs.rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function fixture() {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "easy-hevc-test-"));
  const input = path.join(directory, "video.mp4");
  await fs.writeFile(input, "original contents");
  spyOn(FFmpegService, "checkBinary").mockResolvedValue();
  spyOn(FFmpegService, "getOriginalFilenameTag").mockResolvedValue(null);
  spyOn(FFmpegService, "getDuration").mockResolvedValue(10);
  return { ...defaults, input };
}

describe("encoder settings", () => {
  test("CPU retains its existing encoding arguments", () => {
    expect(encoderSettings(defaults).args).toEqual([
      "-c:v",
      "libx265",
      "-crf",
      "24",
      "-preset",
      "medium",
    ]);
  });
  test.each([
    ["fast", "p3"],
    ["medium", "p4"],
    ["slow", "p6"],
    ["veryslow", "p7"],
  ] as const)("NVIDIA maps %s to %s", (preset, expected) => {
    const settings = encoderSettings({ ...defaults, encoder: "nvidia", cq: 21, preset });
    expect(settings.args).toEqual([
      "-c:v",
      "hevc_nvenc",
      "-rc",
      "vbr",
      "-cq",
      "21",
      "-b:v",
      "0",
      "-preset",
      expected,
    ]);
    expect(settings.qualityName).toBe("cq");
  });
  test("NVIDIA defaults to CQ 24 independently of CRF", () => {
    expect(encoderSettings({ ...defaults, encoder: "nvidia", crf: 18 }).quality).toBe(24);
  });
  test("CPU rejects CQ", () => {
    expect(() => encoderSettings({ ...defaults, cq: 24 })).toThrow("--cq requires");
  });
  test.each([0, 51, 2.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid CQ %s", (cq) => {
    expect(() => encoderSettings({ ...defaults, encoder: "nvidia", cq })).toThrow(
      "integer from 1 to 50",
    );
  });
});

test.each([
  0,
  7,
  13,
  Number.NaN,
])("invalid output duration %s preserves original during finalization", async (duration) => {
  const opts = await fixture();
  spyOn(FFmpegService, "getDuration").mockImplementation(async (file) =>
    file === opts.input ? 10 : duration,
  );
  spyOn(FFmpegService, "convert").mockImplementation(async (_input, output) => {
    await fs.writeFile(output, "small");
    return 1;
  });
  await runConvert(opts);
  expect(await fs.readFile(opts.input, "utf8")).toBe("original contents");
  expect(await fs.readdir(path.dirname(opts.input))).toEqual(["video.mp4"]);
  expect(process.exitCode).toBe(1);
});

test("validated smaller output can finalize", async () => {
  const opts = await fixture();
  spyOn(FFmpegService, "convert").mockImplementation(async (_input, output) => {
    await fs.writeFile(output, "small");
    return 1;
  });
  await runConvert(opts);
  expect(await fs.readdir(path.dirname(opts.input))).toEqual(["video.mkv"]);
  expect(await fs.readFile(path.join(path.dirname(opts.input), "video.mkv"), "utf8")).toBe("small");
});

test("NVIDIA dry run neither encodes nor checks hardware nor writes media", async () => {
  const opts = await fixture();
  const check = spyOn(FFmpegService, "checkNvidia").mockResolvedValue();
  const convert = spyOn(FFmpegService, "convert").mockResolvedValue(1);
  await runConvert({ ...opts, encoder: "nvidia", dryRun: true });
  expect(check).not.toHaveBeenCalled();
  expect(convert).not.toHaveBeenCalled();
  expect(await fs.readdir(path.dirname(opts.input))).toEqual(["video.mp4"]);
});

test("unavailable NVIDIA stops before conversion", async () => {
  const opts = await fixture();
  spyOn(FFmpegService, "checkNvidia").mockRejectedValue(new Error("NVIDIA driver unavailable"));
  const convert = spyOn(FFmpegService, "convert").mockResolvedValue(1);
  await expect(runConvert({ ...opts, encoder: "nvidia" })).rejects.toThrow(
    "NVIDIA driver unavailable",
  );
  expect(convert).not.toHaveBeenCalled();
  expect(await fs.readdir(path.dirname(opts.input))).toEqual(["video.mp4"]);
});

test("failed encode reports diagnostics and removes partial output", async () => {
  const opts = await fixture();
  const errors = spyOn(console, "error").mockImplementation(() => {});
  spyOn(FFmpegService, "convert").mockImplementation(async (_input, output) => {
    await fs.writeFile(output, "partial");
    throw new Error(
      "FFmpeg exited with code 1\nDriver does not support the required NVENC API version",
    );
  });
  await runConvert(opts);
  expect(errors.mock.calls.flat().join("\n")).toContain("required NVENC API version");
  expect(await fs.readdir(path.dirname(opts.input))).toEqual(["video.mp4"]);
});

const hasFFmpeg = Bun.which("ffmpeg") !== null;
test.skipIf(!hasFFmpeg)("FFmpeg runner retains actual stderr", async () => {
  await expect(runFFmpeg(["-easy_hevc_invalid_option"])).rejects.toThrow(
    "easy_hevc_invalid_option",
  );
});
