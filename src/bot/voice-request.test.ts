import { describe, expect, it } from "vitest";
import { parseVoiceCommand } from "./voice-request.js";
import { ensureVoiceKeyword, voiceModelPaths, WAKE_PHRASE } from "./voice-models.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("parseVoiceCommand", () => {
  it("extracts one immediate song request with an optional artist", () => {
    for (const phrase of ["我要听", "放一首", "播放", "点歌"]) {
      expect(parseVoiceCommand(`${phrase}晴天。 `)).toEqual({ name: "play", query: "晴天" });
    }
    expect(parseVoiceCommand("帮我点歌周杰伦的晴天！")).toEqual({ name: "play", query: "周杰伦的晴天" });
    expect(parseVoiceCommand("布鲁斯 布鲁斯，播放晴天")).toEqual({ name: "play", query: "晴天" });
    expect(parseVoiceCommand("布鲁斯，布鲁斯，播放晴天")).toEqual({ name: "play", query: "晴天" });
  });

  it("parses pause and resume without a song query", () => {
    expect(parseVoiceCommand("暂停。")).toEqual({ name: "pause" });
    expect(parseVoiceCommand("继续！")).toEqual({ name: "resume" });
    expect(parseVoiceCommand("布鲁斯布鲁斯，暂停")).toEqual({ name: "pause" });
  });

  it("does not turn an unrelated voice command into a song search", () => {
    expect(parseVoiceCommand("跳过这首歌")).toBeNull();
    expect(parseVoiceCommand("暂停播放")).toBeNull();
    expect(parseVoiceCommand("播放")).toBeNull();
  });
});

it("refreshes an installed keyword file with the new wake phrase", () => {
  const root = mkdtempSync(path.join(tmpdir(), "voice-keyword-"));
  try {
    const file = voiceModelPaths(root).keywords;
    writeFileSync(file, "old keyword\n", "utf8");
    ensureVoiceKeyword(root);
    expect(WAKE_PHRASE).toBe("布鲁斯布鲁斯");
    expect(readFileSync(file, "utf8")).toBe("b ù l ǔ s ī b ù l ǔ s ī :2.0 #0.5 @布鲁斯布鲁斯\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
