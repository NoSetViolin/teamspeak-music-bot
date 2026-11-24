import { Worker } from "node:worker_threads";
import { createOpusEncoder, type Encoder } from "../audio/encoder.js";
import { buildVoiceKeyword, missingVoiceModels, voiceModelPaths, WAKE_PHRASE, type VoiceWakeMode } from "./voice-models.js";
import type { Logger } from "../logger.js";

export interface IncomingVoice {
  clientId: number;
  codec: number;
  data: Buffer;
}

export interface VoiceprintProfile {
  name: string;
  embedding: number[];
  embeddings?: number[][];
}

export interface VoiceRequestCallbacks {
  onWake(clientId: number, profileName?: string): void;
  onResult(clientId: number, text: string, profileName?: string): void;
  onFailure(clientId: number, reason: string): void;
  onUnavailable(reason: string): void;
}

/** Owns per-speaker Opus decoders and the isolated local voice worker. */
export class VoiceRequestController {
  private worker: Worker | null = null;
  private ready = false;
  private decoders = new Map<number, Encoder>();
  private decoderLastSeen = new Map<number, number>();
  private generation = 0;
  private activeSpeaker: number | null = null;
  private mode: VoiceWakeMode = "voiceprint";
  private profiles: VoiceprintProfile[] = [];
  private receivedPackets = 0;
  private decodedPackets = 0;

  constructor(
    private readonly logger: Logger,
    private readonly callbacks: VoiceRequestCallbacks,
  ) {}

  setEnabled(
    enabled: boolean,
    profiles: VoiceprintProfile[] = this.profiles,
    mode: VoiceWakeMode = this.mode,
    wakePhrase = WAKE_PHRASE,
  ): void {
    this.profiles = profiles;
    this.mode = mode;
    this.receivedPackets = 0;
    this.decodedPackets = 0;
    this.stop();
    if (!enabled) return;
    const paths = voiceModelPaths();
    const missing = missingVoiceModels(mode);
    if (missing.length) {
      this.logger.error({ missing, mode }, "Voice request models are missing; run npm run setup:voice");
      this.callbacks.onUnavailable("语音模型未安装，请运行 npm run setup:voice");
      return;
    }
    let keywordLine: string;
    try {
      keywordLine = buildVoiceKeyword(wakePhrase, paths.kwsTokens);
    } catch (error) {
      this.logger.error({ error, wakePhrase }, "Could not build voice wake keyword");
      this.callbacks.onUnavailable("无法加载语音唤醒词，请检查语音点歌设置");
      return;
    }
    const generation = ++this.generation;
    const workerFile = import.meta.url.endsWith(".ts") ? "./voice-worker.ts" : "./voice-worker.js";
    let worker: Worker;
    try {
      worker = new Worker(new URL(workerFile, import.meta.url), {
        workerData: { paths, mode, keywordLine, profiles: this.profiles },
        execArgv: workerFile.endsWith(".ts") ? ["--import", "tsx"] : [],
      });
    } catch (error) {
      this.logger.error({ error }, "Could not start voice recognition worker");
      this.callbacks.onUnavailable("语音识别无法启动，请查看服务端日志");
      return;
    }
    this.worker = worker;
    worker.on("message", (message: {
      type: string;
      id?: number;
      text?: string;
      reason?: string;
      message?: string;
      profileName?: string;
      stage?: string;
      samples?: number;
      ready?: boolean;
      matched?: string;
      rms?: number;
      peak?: number;
      packets?: number;
      elapsedMs?: number;
      wakeEngine?: string;
      similarity?: number;
      threshold?: number;
      closestProfile?: string;
    }) => {
      if (generation !== this.generation) return;
      if (message.type === "ready") {
        this.ready = true;
        this.logger.info({ mode, wakePhrase, profiles: this.profiles.length, wakeEngine: message.wakeEngine }, "Local voice request recognition ready");
      } else if (message.type === "diagnostic") {
        this.logger.info(
          { stage: message.stage, clientId: message.id, samples: message.samples, ready: message.ready, matched: message.matched, closestProfile: message.closestProfile, similarity: message.similarity, threshold: message.threshold, text: message.text, rms: message.rms, peak: message.peak, packets: message.packets, elapsedMs: message.elapsedMs },
          "Voice request worker diagnostic",
        );
      } else if (message.type === "wake" && message.id) {
        if (this.activeSpeaker !== null) return;
        this.activeSpeaker = message.id;
        this.callbacks.onWake(message.id, message.profileName);
      } else if (message.type === "result" && message.id) {
        if (this.activeSpeaker !== message.id) return;
        this.activeSpeaker = null;
        this.callbacks.onResult(message.id, message.text ?? "", message.profileName);
      } else if (message.type === "failure" && message.id) {
        if (this.activeSpeaker !== null && this.activeSpeaker !== message.id) return;
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

  updateProfiles(profiles: VoiceprintProfile[]): void {
    this.profiles = profiles;
    if (this.worker && this.mode === "voiceprint") {
      this.worker.postMessage({ type: "profiles", profiles });
    }
  }

  receive(voice: IncomingVoice): void {
    if (!this.ready || !this.worker || (voice.codec !== 4 && voice.codec !== 5)) return;
    this.receivedPackets++;
    if (this.receivedPackets === 1) {
      this.logger.info({ clientId: voice.clientId, codec: voice.codec }, "Voice request received first forwarded packet");
    }
    const now = Date.now();
    let decoder = this.decoders.get(voice.clientId);
    if (!decoder) {
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
      this.decodedPackets++;
      if (this.decodedPackets === 1) {
        this.logger.info({ clientId: voice.clientId, pcmBytes: pcm.length }, "Voice request decoded first Opus packet");
      }
      if (pcm.length < 4 || pcm.length > 7680 || pcm.length % 4 !== 0) return;
      const mono = new Float32Array(pcm.length / 4);
      for (let i = 0; i < mono.length; i++) {
        mono[i] = (pcm.readInt16LE(i * 4) + pcm.readInt16LE(i * 4 + 2)) / 65536;
      }
      this.worker.postMessage({ type: "audio", id: voice.clientId, pcm: mono }, [mono.buffer]);
    } catch (error) {
      this.logger.warn({ error, clientId: voice.clientId }, "Skipped invalid Opus voice packet");
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
