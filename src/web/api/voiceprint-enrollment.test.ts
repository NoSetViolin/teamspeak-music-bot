import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import pino from "pino";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, type BotDatabase } from "../../data/database.js";
import { getDefaultConfig, loadConfig, type BotConfig } from "../../data/config.js";
import { createAvatarStore } from "../../data/avatars.js";
import type { BotManager } from "../../bot/manager.js";
import { createVoiceprintFromBrowserAudio } from "../../bot/voiceprint.js";
import { WAKE_PHRASE } from "../../bot/voice-models.js";
import { createBotRouter } from "./bot.js";

vi.mock("../../bot/voice-models.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../bot/voice-models.js")>(),
  missingVoiceModels: () => [],
  buildVoiceKeyword: () => "valid",
}));
vi.mock("../../bot/voiceprint.js", () => ({ createVoiceprintFromBrowserAudio: vi.fn() }));

describe("multi-sample browser voiceprint enrollment", () => {
  let app: express.Express;
  let database: BotDatabase;
  let directory: string;
  let config: BotConfig;
  const refresh = vi.fn();
  const updateVoiceRequest = vi.fn();
  const audio = Buffer.from("sample audio").toString("base64");
  const analyze = vi.mocked(createVoiceprintFromBrowserAudio);

  beforeEach(() => {
    vi.clearAllMocks();
    analyze.mockReset();
    analyze.mockResolvedValue({ embedding: [1, 0], transcript: "布鲁斯布鲁斯。", duration: 2, rms: 0.02 });
    database = createDatabase(":memory:");
    directory = mkdtempSync(join(tmpdir(), "voiceprint-api-"));
    config = getDefaultConfig();
    const bot = { getVoiceprintScope: () => "server", refreshVoiceprintProfiles: refresh, updateVoiceRequest };
    const manager = { getBot: (id: string) => id === "bot" ? bot : undefined, getAllBots: () => [bot] } as unknown as BotManager;
    app = express();
    app.use(express.json({ limit: "4mb" }));
    app.use((req, _res, next) => {
      Object.assign(req, { user: { id: "alice", role: "admin" } });
      next();
    });
    app.use("/api/bot", createBotRouter(manager, config, join(directory, "config.json"), pino({ level: "silent" }), database, createAvatarStore(directory)));
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("checks a sample without persisting a partial enrollment or returning embeddings", async () => {
    const result = await request(app).post("/api/bot/bot/voiceprints/analyze").send({ audioBase64: audio });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ transcript: "布鲁斯布鲁斯。", duration: 2, rms: 0.02 });
    expect(analyze).toHaveBeenCalledWith(Buffer.from("sample audio"), false);
    expect(database.listVoiceprints("server")).toEqual([]);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("stores all six samples together and reports their count", async () => {
    const result = await request(app).post("/api/bot/bot/voiceprints").send({ name: "Alice", audioSamplesBase64: Array(6).fill(audio) });
    expect(result.status).toBe(200);
    expect(result.body.voiceprint.sampleCount).toBe(6);
    expect(database.listVoiceprints("server")[0].embeddings).toHaveLength(6);
    expect(refresh).toHaveBeenCalledTimes(1);
    const list = await request(app).get("/api/bot/bot/voiceprints");
    expect(list.body.voiceprints[0]).toMatchObject({ name: "Alice", sampleCount: 6, ownedByCurrentUser: true });
  });

  it("keeps the previous enrollment if any recording fails", async () => {
    database.saveVoiceprint({ scope: "server", name: "Alice", clientUid: "web:alice:Alice", embedding: [0, 1] });
    analyze.mockResolvedValueOnce({ embedding: [1, 0], transcript: "布鲁斯布鲁斯", duration: 2, rms: 0.02 });
    analyze.mockRejectedValueOnce(new Error("录音不清晰"));
    const result = await request(app).post("/api/bot/bot/voiceprints").send({ name: "Alice", audioSamplesBase64: [audio, audio, audio] });
    expect(result.status).toBe(400);
    expect(result.body.error).toContain("第 2 段");
    expect(database.listVoiceprints("server")[0].embedding).toEqual([0, 1]);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("rejects an incomplete multi-sample request before running the models", async () => {
    const result = await request(app).post("/api/bot/bot/voiceprints").send({ name: "Alice", audioSamplesBase64: [audio] });
    expect(result.status).toBe(400);
    expect(analyze).not.toHaveBeenCalled();
  });

  it("continues to accept the original single-recording API", async () => {
    const result = await request(app).post("/api/bot/bot/voiceprints").send({ name: "Alice", audioBase64: audio });
    expect(result.status).toBe(200);
    expect(result.body.voiceprint.sampleCount).toBe(1);
    expect(analyze).toHaveBeenCalledWith(Buffer.from("sample audio"), WAKE_PHRASE);
  });

  it("accepts the default voiceprint name for a 32-character username", async () => {
    const name = `${"a".repeat(32)}的声音`;
    const result = await request(app).post("/api/bot/bot/voiceprints").send({ name, audioBase64: audio });
    expect(result.status).toBe(200);
    expect(result.body.voiceprint.name).toBe(name);
  });

  it("persists a custom phrase, hot-applies it in voiceprint mode, and resets it when cleared", async () => {
    config.voiceRequest.enabled = true;
    database.saveVoiceprint({ scope: "server", name: "Alice", clientUid: "web:alice:Alice", embedding: [0, 1] });
    const custom = await request(app).post("/api/bot/settings").send({ voiceRequest: { wakePhrase: " 音乐助手 " } });
    expect(custom.status).toBe(200);
    expect(custom.body.voiceRequest).toMatchObject({ enabled: true, mode: "voiceprint", wakePhrase: "音乐助手" });
    expect(loadConfig(join(directory, "config.json")).voiceRequest.wakePhrase).toBe("音乐助手");
    expect(updateVoiceRequest).toHaveBeenCalledWith(true, "voiceprint", "音乐助手");

    const invalid = await request(app).post("/api/bot/settings").send({ voiceRequest: { wakePhrase: "hi" } });
    expect(invalid.status).toBe(400);
    expect(config.voiceRequest.wakePhrase).toBe("音乐助手");
    expect(updateVoiceRequest).toHaveBeenCalledTimes(1);
    const reset = await request(app).post("/api/bot/settings").send({ voiceRequest: { wakePhrase: "" } });
    expect(reset.body.voiceRequest.wakePhrase).toBe(WAKE_PHRASE);
    expect(updateVoiceRequest).toHaveBeenLastCalledWith(true, "voiceprint", WAKE_PHRASE);
    expect(database.listVoiceprints("server")[0].embedding).toEqual([0, 1]);
  });

  it("validates the active custom phrase during analysis and when saving guided samples", async () => {
    config.voiceRequest.wakePhrase = "音乐助手";
    const analyzed = await request(app).post("/api/bot/bot/voiceprints/analyze").send({ audioBase64: audio, wakePhrase: "音乐助手" });
    expect(analyzed.status).toBe(200);
    expect(analyze).toHaveBeenCalledWith(Buffer.from("sample audio"), "音乐助手");

    analyze.mockClear();
    const samples = Array(6).fill(audio);
    const stale = await request(app).post("/api/bot/bot/voiceprints").send({ name: "Alice", audioSamplesBase64: samples, wakePhrase: WAKE_PHRASE });
    expect(stale.status).toBe(409);
    expect(analyze).not.toHaveBeenCalled();
    const saved = await request(app).post("/api/bot/bot/voiceprints").send({ name: "Alice", audioSamplesBase64: samples, wakePhrase: "音乐助手" });
    expect(saved.status).toBe(200);
    expect(analyze.mock.calls.map(([, wakePhrase]) => wakePhrase)).toEqual(Array(6).fill("音乐助手"));
  });

  it("does not store guided samples if the phrase changes during processing", async () => {
    const analysis = { embedding: [1, 0], transcript: WAKE_PHRASE, duration: 2, rms: 0.02 };
    analyze.mockImplementationOnce(async () => {
      config.voiceRequest.wakePhrase = "音乐助手";
      return analysis;
    });
    const result = await request(app).post("/api/bot/bot/voiceprints").send({
      name: "Alice", audioSamplesBase64: Array(3).fill(audio), wakePhrase: WAKE_PHRASE,
    });
    expect(result.status).toBe(409);
    expect(database.listVoiceprints("server")).toEqual([]);
  });
});
