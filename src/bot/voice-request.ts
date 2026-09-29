import { Worker } from "node:worker_threads";
import { createOpusEncoder, type Encoder } from "../audio/encoder.js";
import { ensureVoiceKeyword, missingVoiceModels, voiceModelPaths, WAKE_PHRASE } from "./voice-models.js";
import type { Logger } from "../logger.js";

export interface IncomingVoice {
  clientId: number;
  codec: number;
  data: Buffer;
}

export interface VoiceRequestCallbacks {
  onWake(clientId: number): void;
  onResult(clientId: number, text: string): void;
  onFailure(clientId: number, reason: string): void;
  onUnavailable(reason: string): void;
}

/** Owns the per-speaker Opus decoders and the isolated local-ASR worker. */
export class VoiceRequestController {
  private worker: Worker | null = null;
  private ready = false;
  private decoders = new Map<number, Encoder>();
  private decoderLastSeen = new Map<number, number>();
  private generation = 0;
  private activeSpeaker: number | null = null;

  constructor(
    private readonly logger: Logger,
    private readonly callbacks: VoiceRequestCallbacks,
  ) {}

  setEnabled(enabled: boolean): void {
    this.stop();
    if (!enabled) return;
    const paths = voiceModelPaths();
    const missing = missingVoiceModels().filter((file) => file !== paths.keywords);
    if (missing.length) {
      this.logger.error({ missing }, "Voice request models are missing; run npm run setup:voice");
      this.callbacks.onUnavailable("语音模型未安装，请运行 npm run setup:voice");
      return;
    }
    try {
      ensureVoiceKeyword();
    } catch (error) {
      this.logger.error({ error }, "Could not update voice wake keyword");
      this.callbacks.onUnavailable("无法更新语音唤醒词，请检查模型目录权限");
      return;
    }
    const generation = ++this.generation;
    const workerFile = import.meta.url.endsWith(".ts") ? "./voice-worker.ts" : "./voice-worker.js";
    let worker: Worker;
    try {
      worker = new Worker(new URL(workerFile, import.meta.url), {
        workerData: { paths: voiceModelPaths(), wakePhrase: WAKE_PHRASE },
        execArgv: workerFile.endsWith(".ts") ? ["--import", "tsx"] : [],
      });
    } catch (error) {
      this.logger.error({ error }, "Could not start voice recognition worker");
      this.callbacks.onUnavailable("语音识别无法启动，请查看服务端日志");
      return;
    }
    this.worker = worker;
    worker.on("message", (message: { type: string; id?: number; text?: string; reason?: string; message?: string }) => {
      if (generation !== this.generation) return;
      if (message.type === "ready") {
        this.ready = true;
        this.logger.info("Local voice request recognition ready");
      } else if (message.type === "wake" && message.id) {
        if (this.activeSpeaker !== null) return;
        this.activeSpeaker = message.id;
        this.callbacks.onWake(message.id);
      } else if (message.type === "result" && message.id) {
        if (this.activeSpeaker !== message.id) return;
        this.activeSpeaker = null;
        this.callbacks.onResult(message.id, message.text ?? "");
      } else if (message.type === "failure" && message.id) {
        if (this.activeSpeaker !== message.id) return;
        this.activeSpeaker = null;
        this.callbacks.onFailure(message.id, message.reason ?? "语音识别失败");
      } else if (message.type === "error") {
        this.logger.error({ error: message.message }, "Voice recognition worker failed");
        this.callbacks.onUnavailable("语音识别模型加载失败，请查看服务端日志");
        this.stop();
      }
    });
    worker.on("error", (error) => {
      if (generation !== this.generation) return;
      this.logger.error({ error }, "Voice recognition worker crashed");
      this.callbacks.onUnavailable("语音识别中断，请查看服务端日志");
      this.stop();
    });
    worker.on("exit", (code) => {
      if (generation !== this.generation || code === 0) return;
      this.logger.error({ code }, "Voice recognition worker exited");
      this.callbacks.onUnavailable("语音识别中断，请查看服务端日志");
      this.stop();
    });
  }

  receive(voice: IncomingVoice): void {
    if (!this.ready || !this.worker || (voice.codec !== 4 && voice.codec !== 5)) return;
    const now = Date.now();
    let decoder = this.decoders.get(voice.clientId);
    if (!decoder) {
      // Bound native decoder memory when many clients speak over time.
      if (this.decoders.size >= 8) {
        const oldest = [...this.decoderLastSeen].sort((a, b) => a[1] - b[1])[0];
        if (oldest) this.removeSpeaker(oldest[0]);
      }
      decoder = createOpusEncoder();
      this.decoders.set(voice.clientId, decoder);
    }
    this.decoderLastSeen.set(voice.clientId, now);
    try {
      const pcm = decoder.decode(voice.data);
      if (pcm.length < 4 || pcm.length > 7680 || pcm.length % 4 !== 0) return;
      const mono = new Float32Array(pcm.length / 4);
      for (let i = 0; i < mono.length; i++) {
        mono[i] = (pcm.readInt16LE(i * 4) + pcm.readInt16LE(i * 4 + 2)) / 65536;
      }
      this.worker.postMessage({ type: "audio", id: voice.clientId, pcm: mono }, [mono.buffer]);
    } catch (error) {
      this.logger.debug({ error, clientId: voice.clientId }, "Skipped invalid Opus voice packet");
    }
  }

  removeSpeaker(clientId: number): void {
    if (this.activeSpeaker === clientId) this.activeSpeaker = null;
    this.decoders.delete(clientId);
    this.decoderLastSeen.delete(clientId);
    this.worker?.postMessage({ type: "remove", id: clientId });
  }

  cancel(): void {
    this.activeSpeaker = null;
    this.worker?.postMessage({ type: "cancel" });
    this.decoders.clear();
    this.decoderLastSeen.clear();
  }

  stop(): void {
    this.generation++;
    this.activeSpeaker = null;
    this.ready = false;
    this.decoders.clear();
    this.decoderLastSeen.clear();
    const worker = this.worker;
    this.worker = null;
    if (worker) void worker.terminate();
  }

  isReady(): boolean {
    return this.ready;
  }
}

export type VoiceCommand = { name: "play"; query: string } | { name: "pause" | "resume" };

/** Parse the one command spoken after a successful wake. */
export function parseVoiceCommand(transcript: string): VoiceCommand | null {
  const clean = transcript.replace(/<\|[^|]*\|>/g, "").trim()
    .replace(/^布鲁斯[，,、\s]*布鲁斯[，,。！!？?\s]*/u, "")
    .replace(/[。！？!?，,]+$/u, "").trim();
  if (clean === "暂停") return { name: "pause" };
  if (clean === "继续") return { name: "resume" };
  const match = clean.match(/^(?:请|帮我|给我|我要|我想|麻烦你|你能)?\s*(?:我要听|播放|点歌|放一首|来一首|放|来)\s*(.+)$/u);
  if (!match) return null;
  const query = match[1].trim();
  return query.length >= 1 && query.length <= 120 ? { name: "play", query } : null;
}
