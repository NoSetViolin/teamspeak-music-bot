import { describe, expect, it } from "vitest";
import { analyzeVoiceCommand, parseVoiceCommand } from "./voice-command.js";
import { buildVoiceKeyword, normalizeVoiceWakePhrase, WAKE_PHRASE } from "./voice-models.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("parseVoiceCommand", () => {
  it("extracts one immediate song request with an optional artist", () => {
    for (const phrase of ["我要听", "放一首", "播放", "点歌"]) {
      expect(parseVoiceCommand(`${phrase}晴天。 `)).toEqual({ name: "play", query: "晴天" });
    }
    expect(parseVoiceCommand("帮我点歌周杰伦的晴天！")).toEqual({
      name: "play", query: "晴天", artist: "周杰伦", literalTitle: "周杰伦的晴天",
    });
    expect(parseVoiceCommand("布鲁斯 布鲁斯，播放晴天")).toEqual({ name: "play", query: "晴天" });
    expect(parseVoiceCommand("布鲁斯，布鲁斯，播放晴天")).toEqual({ name: "play", query: "晴天" });
  });

  it("parses pause and resume without a song query", () => {
    expect(parseVoiceCommand("暂停。")).toEqual({ name: "pause" });
    expect(parseVoiceCommand("继续！")).toEqual({ name: "resume" });
    expect(parseVoiceCommand("布鲁斯布鲁斯，暂停")).toEqual({ name: "pause" });
  });

  it("recognizes a separate custom wake prefix and preserves a command that starts with the same words", () => {
    expect(analyzeVoiceCommand("你好小蓝，暂停", "你好小蓝")).toEqual({ name: "pause" });
    expect(analyzeVoiceCommand("放一首晴天", "放一首")).toEqual({ name: "play", query: "晴天" });
  });

  it("parses previous and next track commands", () => {
    expect(parseVoiceCommand("上一首。")).toEqual({ name: "prev" });
    expect(parseVoiceCommand("下一首！")).toEqual({ name: "next" });
    expect(parseVoiceCommand("布鲁斯布鲁斯，上一首")).toEqual({ name: "prev" });
    expect(parseVoiceCommand("布鲁斯 布鲁斯，下一首")).toEqual({ name: "next" });
  });

  it.each([
    ["<|zh|>先停一下吧。", { name: "pause" }],
    ["能不能暂停一下音乐", { name: "pause" }],
    ["接着播放吧", { name: "resume" }],
    ["继续放这首歌", { name: "resume" }],
    ["帮我切回上一首", { name: "prev" }],
    ["这首跳过吧", { name: "next" }],
    ["换首吧", { name: "next" }],
    ["现在这首叫什么？", { name: "now" }],
    ["把音量调到百分之三十", { name: "vol", kind: "absolute", value: 30 }],
    ["把声音调到 ３０％", { name: "vol", kind: "absolute", value: 30 }],
    ["音量设为九十九", { name: "vol", kind: "absolute", value: 99 }],
    ["音量开到一百", { name: "vol", kind: "absolute", value: 100 }],
    ["别切歌，声音小一点", { name: "vol", kind: "relative", value: -10 }],
    ["别再切歌但是声音小一点", { name: "vol", kind: "relative", value: -10 }],
    ["不要暂停，帮我把音量调高点", { name: "vol", kind: "relative", value: 10 }],
    ["现在放首晴天吧", { name: "play", query: "晴天" }],
    ["嗯，帮我，放首晴天", { name: "play", query: "晴天" }],
    ["我想听一下晴天", { name: "play", query: "晴天" }],
    ["把晴天加到队尾", { name: "add", query: "晴天" }],
    ["把晴天排队吧", { name: "add", query: "晴天" }],
    ["下一首放晴天", { name: "playnext", query: "晴天" }],
    ["把晴天排到下一首", { name: "playnext", query: "晴天" }],
    ["在 QQ 音乐上放晴天", { name: "play", platform: "qq", query: "晴天" }],
    ["在QQ音乐上放周杰伦演唱的《晴天》", { name: "play", platform: "qq", query: "晴天", artist: "周杰伦" }],
    ["播放网易云上的晴天", { name: "play", platform: "netease", query: "晴天" }],
    ["播放歌名叫时间的歌", { name: "play", query: "时间的歌" }],
    ["播放我的歌声里", { name: "play", query: "我的歌声里" }],
    ["播放《Hello, Goodbye》", { name: "play", query: "Hello, Goodbye" }],
    ["播放 https://music.163.com/song?id=123", { name: "play", query: "https://music.163.com/song?id=123" }],
  ])("understands %s", (spoken, expected) => {
    expect(parseVoiceCommand(spoken)).toEqual(expected);
  });

  it.each([
    "播放",
    "来一首",
    "放首歌",
    "今天吃什么",
    "来聊聊",
    "我昨天听了晴天",
    "声音小一点之前那首叫什么",
    "我说的是暂停",
    "先别暂停",
    "别切歌，下一首",
    "暂停，下一首",
    "播放晴天然后再暂停",
    "播放晴天再放首稻香",
    "播放《晴天》并调低一点",
    "音量调到101",
    "音量调到负三十",
    `放${"啊".repeat(121)}`,
  ])("leaves %s without an action", spoken => {
    expect(parseVoiceCommand(spoken)).toBeNull();
  });
});

it("encodes the custom wake phrase using the model vocabulary and retains the original default", () => {
  const root = mkdtempSync(path.join(tmpdir(), "voice-keyword-"));
  try {
    const file = path.join(root, "tokens.txt");
    writeFileSync(file, "y 1\r\nīn 2\r\nuè 3\r\nzh 4\r\nù 5\r\nsh 6\r\nǒu 7\r\n", "utf8");
    expect(buildVoiceKeyword("音乐助手", file)).toBe("y īn y uè zh ù sh ǒu :1.8 #0.15 @音乐助手\n");
    expect(buildVoiceKeyword(WAKE_PHRASE, file)).toBe("b ù l ǔ s ī b ù l ǔ s ī :1.8 #0.15 @布鲁斯布鲁斯\n");
    expect(() => buildVoiceKeyword("小布小布", file)).toThrow("当前语音模型不支持");
    expect(normalizeVoiceWakePhrase("  音乐助手 ")).toBe("音乐助手");
    expect(normalizeVoiceWakePhrase(" ")).toBe(WAKE_PHRASE);
    expect(normalizeVoiceWakePhrase("音乐\n助手")).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
