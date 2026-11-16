import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { getFfmpegCommand } from "../audio/player.js";
import { createOpusEncoder } from "../audio/encoder.js";
import { ensureVoiceKeyword, missingVoiceModels, voiceModelPaths } from "./voice-models.js";
import type { VoiceprintProfile } from "./voice-request.js";

const paths = voiceModelPaths();
const fixture = fileURLToPath(new URL("../../bls.m4a", import.meta.url));
const available = existsSync(fixture) && missingVoiceModels("keyword").length === 0 && missingVoiceModels("voiceprint").length === 0;
const workers: Worker[] = [];
type Message = { type: string; id?: number; stage?: string; packets?: number; profileName?: string; matched?: string; text?: string; elapsedMs?: number; similarity?: number; threshold?: number };
let speech: Buffer;
let embedding: number[];

function decodePackets(input: Buffer, scale: number): Float32Array[] {
  const encoder = createOpusEncoder();
  const decoder = createOpusEncoder();
  const packets: Float32Array[] = [];
  for (let offset = 0; offset < input.length; offset += 3840) {
    const frame = Buffer.alloc(3840);
    const length = Math.min(3840, input.length - offset);
    for (let i = 0; i < length; i += 2) frame.writeInt16LE(Math.round(input.readInt16LE(offset + i) * scale), i);
    const pcm = decoder.decode(encoder.encode(frame));
    const mono = new Float32Array(pcm.length / 4);
    for (let i = 0; i < mono.length; i++) mono[i] = (pcm.readInt16LE(i * 4) + pcm.readInt16LE(i * 4 + 2)) / 65536;
    packets.push(mono);
  }
  return packets;
}

async function runWorker(packets: Float32Array[], profiles: VoiceprintProfile[] = [{ name: "sample", embedding }]): Promise<Message[]> {
  const worker = new Worker(new URL("./voice-worker.ts", import.meta.url), {
    workerData: { paths, mode: "voiceprint", profiles },
    execArgv: ["--import", "tsx"],
  });
  workers.push(worker);
  const messages: Message[] = [];
  // Keep sending packets after the fixture so a diagnostic acknowledges that
  // the worker consumed every packet, without a wall-clock sleep in the test.
  const total = Math.ceil((packets.length + 50) / 100) * 100;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Voice worker did not finish the audio fixture")), 15_000);
    worker.on("error", reject);
    worker.on("message", (message: Message) => {
      messages.push(message);
      if (message.type === "error") reject(new Error(JSON.stringify(message)));
      if (message.type === "ready") {
        for (let i = 0; i < total; i++) {
          worker.postMessage({ type: "audio", id: 123, pcm: packets[i] ?? new Float32Array(960) });
        }
      }
      if (message.stage === "audioProgress" && message.packets === total) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  return messages;
}

describe.skipIf(!available)("streaming wake with installed native models and Opus audio", { timeout: 30_000 }, () => {
  beforeAll(() => {
    ensureVoiceKeyword();
    speech = execFileSync(getFfmpegCommand(), ["-v", "error", "-i", fixture, "-ar", "48000", "-ac", "2", "-f", "s16le", "pipe:1"]);
    const sherpa = createRequire(import.meta.url)("sherpa-onnx-node");
    const mono = new Float32Array(speech.length / 4);
    for (let i = 0; i < mono.length; i++) mono[i] = (speech.readInt16LE(i * 4) + speech.readInt16LE(i * 4 + 2)) / 65536;
    const samples = new sherpa.LinearResampler(48_000, 16_000).resample(mono);
    const extractor = new sherpa.SpeakerEmbeddingExtractor({ model: paths.speakerModel, numThreads: 1, provider: "cpu", debug: 0 });
    const stream = extractor.createStream();
    stream.acceptWaveform({ sampleRate: 16_000, samples });
    stream.inputFinished();
    embedding = Array.from(extractor.compute(stream));
  });

  afterEach(async () => {
    await Promise.all(workers.splice(0).map(worker => worker.terminate()));
  });

  it.each([1, 0.1, 0.01])("recognizes a registered voice at %s amplitude without wake ASR", async (scale) => {
    const messages = await runWorker(decodePackets(speech, scale), [
      { name: "other", embedding: embedding.map(value => -value) },
      { name: "sample", embedding },
    ]);
    expect(messages.filter(message => message.type === "wake")).toEqual([{ type: "wake", id: 123, profileName: "sample" }]);
    expect(messages.some(message => message.stage === "wakeTranscript")).toBe(false);
    expect(messages.some(message => message.stage === "commandAsr")).toBe(false);
    const match = messages.find(message => message.stage === "streamingWake");
    expect(match).toMatchObject({ matched: "sample", threshold: 0.38 });
    expect(match?.similarity).toBeGreaterThanOrEqual(0.38);
  });

  it("accepts a voiceprint match between the relaxed threshold and the old threshold", async () => {
    const norm = Math.sqrt(embedding.reduce((energy, value) => energy + value * value, 0));
    const unit = embedding.map(value => value / norm);
    // Mix the fixture's enrolled vector with an orthogonal vector to exercise
    // a lower cosine score reproducibly, independently of microphone hardware.
    const orthogonal = unit.map((value, i) => (i === 0 ? 1 : 0) - unit[0] * value);
    const orthogonalNorm = Math.sqrt(orthogonal.reduce((energy, value) => energy + value * value, 0));
    const relaxedEmbedding = unit.map((value, i) => value * 0.43 + orthogonal[i] / orthogonalNorm * Math.sqrt(1 - 0.43 ** 2));
    const messages = await runWorker(decodePackets(speech, 1), [{ name: "relaxed", embedding: relaxedEmbedding }]);
    const match = messages.find(message => message.stage === "streamingWake");
    expect(match).toMatchObject({ matched: "relaxed", threshold: 0.38 });
    expect(match?.similarity).toBeGreaterThanOrEqual(0.38);
    expect(match?.similarity).toBeLessThan(0.48);
    expect(messages.some(message => message.type === "wake")).toBe(true);
  });

  it("requires a matching enrolled voice even with the correct wake phrase", async () => {
    const messages = await runWorker(decodePackets(speech, 1), [{ name: "other", embedding: embedding.map(value => -value) }]);
    expect(messages.some(message => message.stage === "streamingWake")).toBe(true);
    expect(messages.find(message => message.stage === "streamingWake")?.similarity).toBeLessThan(0.38);
    expect(messages.some(message => message.type === "wake")).toBe(false);
  });

  it("matches an additional sample even when the primary sample does not match", async () => {
    const primary = embedding.map(value => -value);
    const messages = await runWorker(decodePackets(speech, 0.1), [{ name: "multi", embedding: primary, embeddings: [primary, embedding] }]);
    expect(messages.find(message => message.type === "wake")).toMatchObject({ id: 123, profileName: "multi" });
    expect(messages.find(message => message.stage === "streamingWake")).toMatchObject({ matched: "multi", threshold: 0.38 });
  });

  it("does not wake for silence or a single repetition of the wake name", async () => {
    const messages = await runWorker(decodePackets(speech.subarray(0, Math.floor(speech.length / 8) * 4), 1));
    expect(messages.some(message => message.type === "wake")).toBe(false);
    const silent = await runWorker(Array.from({ length: 100 }, () => new Float32Array(960)));
    expect(silent.some(message => message.type === "wake")).toBe(false);
  });

  it("does not wake for amplified background noise", async () => {
    let seed = 42;
    const packets = Array.from({ length: 150 }, () => Float32Array.from({ length: 960 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return (seed / 2 ** 32 - 0.5) * 0.004;
    }));
    const messages = await runWorker(packets);
    expect(messages.some(message => message.type === "wake")).toBe(false);
    expect(messages.some(message => message.stage === "commandAsr")).toBe(false);
  });

  it("transcribes the next utterance from the awakened client and ignores other clients", async () => {
    const messages = await runWorker(decodePackets(speech, 1));
    expect(messages.some(message => message.type === "wake")).toBe(true);
    expect(messages.some(message => message.stage === "commandAsr")).toBe(false);
    const worker = workers.at(-1)!;
    await new Promise(resolve => setTimeout(resolve, 300));
    const result = new Promise<Message>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("No command transcription after wake")), 8000);
      worker.on("message", (message: Message) => {
        if (message.type === "result") {
          clearTimeout(timeout);
          resolve(message);
        }
      });
    });
    for (const pcm of decodePackets(speech, 1)) {
      worker.postMessage({ type: "audio", id: 456, pcm });
      worker.postMessage({ type: "audio", id: 123, pcm });
    }
    for (let i = 0; i < 50; i++) worker.postMessage({ type: "audio", id: 123, pcm: new Float32Array(960) });
    expect(await result).toMatchObject({ id: 123, text: expect.stringContaining("布鲁斯") });
    expect(messages.filter(message => message.stage === "commandAsr")).toHaveLength(1);
    expect(messages.filter(message => message.type === "wake")).toHaveLength(1);
  });
});
