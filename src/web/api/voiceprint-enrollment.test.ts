import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import pino from "pino";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, type BotDatabase } from "../../data/database.js";
import { getDefaultConfig } from "../../data/config.js";
import { createAvatarStore } from "../../data/avatars.js";
import type { BotManager } from "../../bot/manager.js";
import { createVoiceprintFromBrowserAudio } from "../../bot/voiceprint.js";
import { createBotRouter } from "./bot.js";

vi.mock("../../bot/voice-models.js", () => ({ missingVoiceModels: () => [] }));
vi.mock("../../bot/voiceprint.js", () => ({ createVoiceprintFromBrowserAudio: vi.fn() }));

describe("multi-sample browser voiceprint enrollment", () => {
  let app: express.Express;
  let database: BotDatabase;
  let directory: string;
  const refresh = vi.fn();
  const audio = Buffer.from("sample audio").toString("base64");
  const analyze = vi.mocked(createVoiceprintFromBrowserAudio);

  beforeEach(() => {
    vi.clearAllMocks();
    analyze.mockReset();
    analyze.mockResolvedValue({ embedding: [1, 0], transcript: "布鲁斯布鲁斯。", duration: 2, rms: 0.02 });
    database = createDatabase(":memory:");
    directory = mkdtempSync(join(tmpdir(), "voiceprint-api-"));
    const bot = { getVoiceprintScope: () => "server", refreshVoiceprintProfiles: refresh };
    const manager = { getBot: (id: string) => id === "bot" ? bot : undefined } as unknown as BotManager;
    app = express();
    app.use(express.json({ limit: "4mb" }));
    app.use((req, _res, next) => {
      Object.assign(req, { user: { id: "alice", role: "admin" } });
      next();
    });
    app.use("/api/bot", createBotRouter(manager, getDefaultConfig(), join(directory, "config.json"), pino({ level: "silent" }), database, createAvatarStore(directory)));
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
    expect(analyze).toHaveBeenCalledWith(Buffer.from("sample audio"), true);
  });
});
