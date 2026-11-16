import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";

const port = parentPort!;
const require = createRequire(import.meta.url);
const SAMPLE_RATE = 16_000;
const mode = workerData.mode as "voiceprint" | "keyword";
const streamingWake = mode === "voiceprint";
const modelPaths = workerData.paths as Record<string, string>;
const MAX_SPEAKERS = 8;
const SPEAKER_IDLE_MS = 15_000;
const COMMAND_TIMEOUT_MS = 8_000;
const START_TIMEOUT_MS = 5_000;
const COOLDOWN_MS = 2_000;
const KEYWORD_GAP_MS = 120;
const VAD_SILENCE_FEED_MS = 80;
const VAD_SILENCE_SAMPLES = Math.round(SAMPLE_RATE * VAD_SILENCE_FEED_MS / 1000);
const KEYWORD_LEADING_SILENCE = new Float32Array(SAMPLE_RATE / 2);
const VOICEPRINT_THRESHOLD = 0.38;
// The VAD segment excludes most of the user's leading and trailing silence.
// A normal spoken "布鲁斯布鲁斯" often arrives as roughly 0.8-0.9 seconds.
// The 3D-Speaker extractor is ready with half a second of clean speech.
const MIN_EMBEDDING_SAMPLES = SAMPLE_RATE / 2;
const WAKE_BUFFER_SAMPLES = SAMPLE_RATE * 4;

type NativeStream = {
  acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void;
  inputFinished?(): void;
};
type Speaker = {
  resampler: { resample(samples: Float32Array): Float32Array };
  lastPacket: number;
  silenceFedAt: number;
  cooldownUntil: number;
  vad?: any;
  pending?: Float32Array;
  keywordStream?: NativeStream;
  wakeBuffer?: any;
  inputGain: number;
  ignoreUntil: number;
};
type KeywordSession = {
  id: number;
  started: number;
  heardSpeech: boolean;
  lastAudio: number;
  silenceFedAt: number;
  ignoreUntil: number;
  vad: any;
  pending: Float32Array;
};
type VoiceprintSession = {
  id: number;
  started: number;
};

const speakers = new Map<number, Speaker>();
let keywordSession: KeywordSession | null = null;
let voiceprintSession: VoiceprintSession | null = null;
let diagnosticAudioLogged = false;
let diagnosticAudioPackets = 0;
let kws: any;
let recognizer: any;
let embeddingExtractor: any;
let embeddingManager: any;
let enrolledVectors: Array<{ name: string; vector: Float32Array }> = [];
let profileNames = new Map<string, string>();
let sherpa: any;

function createVad(): any {
  return new sherpa.Vad({
    sileroVad: {
      model: modelPaths.vadModel,
      threshold: 0.35,
      minSpeechDuration: 0.2,
      minSilenceDuration: 0.28,
      windowSize: 512,
    },
    sampleRate: SAMPLE_RATE,
    numThreads: 1,
    debug: false,
  }, 10);
}

function createKeywordStream(): NativeStream {
  const stream: NativeStream = kws.createStream();
  stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: KEYWORD_LEADING_SILENCE });
  return stream;
}

function resetKeywordSession(reason?: string): void {
  const session = keywordSession;
  if (!session) return;
  keywordSession = null;
  const speaker = speakers.get(session.id);
  if (speaker) {
    speaker.keywordStream = createKeywordStream();
    speaker.cooldownUntil = Date.now() + COOLDOWN_MS;
  }
  if (reason) port.postMessage({ type: "failure", id: session.id, reason });
}

function decodeSpeech(id: number, samples: Float32Array): string {
  const started = performance.now();
  const stream = recognizer.createStream();
  stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
  stream.inputFinished?.();
  recognizer.decode(stream);
  const text = String(recognizer.getResult(stream).text ?? "").trim();
  port.postMessage({ type: "diagnostic", stage: "commandAsr", id, elapsedMs: performance.now() - started });
  return text;
}

function prepareRecognitionSamples(samples: Float32Array): Float32Array {
  let energy = 0;
  for (const sample of samples) energy += sample * sample;
  const rms = Math.sqrt(energy / Math.max(samples.length, 1));
  if (!Number.isFinite(rms) || rms < 0.0001 || rms >= 0.04) return samples;

  const gain = Math.min(20, 0.04 / rms);
  if (gain <= 1) return samples;
  const prepared = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    prepared[i] = Math.max(-1, Math.min(1, samples[i] * gain));
  }
  return prepared;
}

function amplifyWakeAudio(speaker: Speaker, samples: Float32Array): Float32Array {
  let energy = 0;
  let peak = 0;
  for (const sample of samples) {
    energy += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
  }
  const rms = Math.sqrt(energy / Math.max(samples.length, 1));
  // Smooth gain across packets, with a ceiling and peak limit for close speech.
  const target = rms > 0.0001 ? Math.max(1, Math.min(20, 0.04 / rms)) : 1;
  speaker.inputGain += (target - speaker.inputGain) * 0.3;
  const gain = Math.min(speaker.inputGain, 0.95 / Math.max(peak, 0.0001));
  return samples.map(sample => sample * gain);
}

function feedStreamingWake(id: number, speaker: Speaker, samples: Float32Array): void {
  const buffer = speaker.wakeBuffer;
  const overflow = buffer.size() + samples.length - WAKE_BUFFER_SAMPLES;
  if (overflow > 0) buffer.pop(overflow);
  buffer.push(samples);
  speaker.keywordStream!.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: amplifyWakeAudio(speaker, samples) });
  while (kws.isReady(speaker.keywordStream)) kws.decode(speaker.keywordStream);
  if (!kws.getResult(speaker.keywordStream).keyword) return;

  const started = performance.now();
  const audio = buffer.get(buffer.head(), buffer.size(), false);
  const embedding = computeEmbedding(prepareRecognitionSamples(audio));
  const matchedKey = embedding && embeddingManager
    ? String(embeddingManager.search({ v: embedding, threshold: VOICEPRINT_THRESHOLD }) ?? "")
    : "";
  const profileName = profileNames.get(matchedKey) ?? "";
  let similarity: number | undefined;
  let closestProfile: string | undefined;
  if (embedding) {
    let inputEnergy = 0;
    for (const value of embedding) inputEnergy += value * value;
    for (const profile of enrolledVectors) {
      let dot = 0;
      let profileEnergy = 0;
      for (let i = 0; i < embedding.length; i++) {
        dot += embedding[i] * profile.vector[i];
        profileEnergy += profile.vector[i] * profile.vector[i];
      }
      const score = dot / Math.sqrt(inputEnergy * profileEnergy);
      if (Number.isFinite(score) && (similarity === undefined || score > similarity)) {
        similarity = score;
        closestProfile = profile.name;
      }
    }
  }
  port.postMessage({ type: "diagnostic", stage: "streamingWake", id, matched: profileName, closestProfile, similarity, threshold: VOICEPRINT_THRESHOLD, samples: audio.length, elapsedMs: performance.now() - started });
  speaker.keywordStream = createKeywordStream();
  buffer.reset();
  if (!profileName) return;

  // A fresh detector keeps the wake phrase's tail out of the command utterance.
  speaker.vad = createVad();
  speaker.pending = new Float32Array(0);
  speaker.ignoreUntil = Date.now() + 250;
  speaker.cooldownUntil = Date.now() + COOLDOWN_MS;
  voiceprintSession = { id, started: Date.now() };
  port.postMessage({ type: "wake", id, profileName });
}

function computeEmbedding(samples: Float32Array): Float32Array | null {
  if (!embeddingExtractor || samples.length < MIN_EMBEDDING_SAMPLES) return null;
  const stream = embeddingExtractor.createStream() as NativeStream;
  stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
  stream.inputFinished?.();
  if (!embeddingExtractor.isReady(stream)) return null;
  return embeddingExtractor.compute(stream);
}

function rebuildEmbeddingManager(profiles: Array<{ name: string; embedding: number[]; embeddings?: number[][] }>): void {
  if (!embeddingExtractor) return;
  const manager = new sherpa.SpeakerEmbeddingManager(embeddingExtractor.dim);
  const vectors: Array<{ name: string; vector: Float32Array }> = [];
  const names = new Map<string, string>();
  for (const [profileIndex, profile] of profiles.entries()) {
    for (const [sampleIndex, embedding] of (profile.embeddings ?? [profile.embedding]).entries()) {
      const vector = new Float32Array(embedding);
      const key = `${profileIndex}/${sampleIndex}`;
      if (vector.length === embeddingExtractor.dim && manager.add({ name: key, v: vector })) {
        vectors.push({ name: profile.name, vector });
        names.set(key, profile.name);
      }
    }
  }
  embeddingManager = manager;
  enrolledVectors = vectors;
  profileNames = names;
}

function handleVoiceprintSegment(id: number, samples: Float32Array): void {
  if (voiceprintSession?.id !== id) return;
  port.postMessage({ type: "diagnostic", stage: "segment", id, samples: samples.length });
  const recognitionSamples = prepareRecognitionSamples(samples);
  try {
    const text = decodeSpeech(id, recognitionSamples);
    voiceprintSession = null;
    port.postMessage({ type: "result", id, text });
  } catch (err) {
    voiceprintSession = null;
    port.postMessage({ type: "failure", id, reason: `语音识别失败：${(err as Error).message}` });
  }
}

function feedVoiceprintVad(speakerId: number, speaker: Speaker, samples: Float32Array): void {
  const pending = speaker.pending ?? new Float32Array(0);
  const combined = new Float32Array(pending.length + samples.length);
  combined.set(pending);
  combined.set(samples, pending.length);
  const windowSize = speaker.vad.config.sileroVad.windowSize;
  let offset = 0;
  while (combined.length - offset >= windowSize) {
    speaker.vad.acceptWaveform(combined.subarray(offset, offset + windowSize));
    offset += windowSize;
  }
  speaker.pending = combined.slice(offset);
  while (!speaker.vad.isEmpty()) {
    const segment = speaker.vad.front();
    speaker.vad.pop();
    if (segment?.samples) {
      port.postMessage({ type: "diagnostic", stage: "vadSegment", id: speakerId, samples: segment.samples.length });
    }
    const minimumSamples = voiceprintSession?.id === speakerId ? SAMPLE_RATE / 4 : MIN_EMBEDDING_SAMPLES;
    if (segment?.samples && segment.samples.length >= minimumSamples) {
      handleVoiceprintSegment(speakerId, segment.samples);
    }
  }
}

function feedKeywordVad(session: KeywordSession, samples: Float32Array): void {
  const combined = new Float32Array(session.pending.length + samples.length);
  combined.set(session.pending);
  combined.set(samples, session.pending.length);
  const windowSize = session.vad.config.sileroVad.windowSize;
  let offset = 0;
  while (combined.length - offset >= windowSize) {
    session.vad.acceptWaveform(combined.subarray(offset, offset + windowSize));
    offset += windowSize;
  }
  session.pending = combined.slice(offset);
  if (session.vad.isEmpty()) return;
  const segment = session.vad.front();
  session.vad.pop();
  if (!segment?.samples || segment.samples.length < SAMPLE_RATE / 4) {
    resetKeywordSession("没有听清语音指令");
    return;
  }
  try {
    const text = decodeSpeech(session.id, segment.samples);
    const id = session.id;
    resetKeywordSession();
    port.postMessage({ type: "result", id, text });
  } catch (err) {
    resetKeywordSession(`语音识别失败：${(err as Error).message}`);
  }
}

function receive(id: number, pcm: Float32Array): void {
  if (!Number.isSafeInteger(id) || id <= 0 || !(pcm instanceof Float32Array) || pcm.length > 1920) return;
  const now = Date.now();
  let speaker = speakers.get(id);
  const keywordGap = speaker ? now - speaker.lastPacket > KEYWORD_GAP_MS : false;
  if (!speaker) {
    if (speakers.size >= MAX_SPEAKERS) return;
    speaker = {
      resampler: new sherpa.LinearResampler(48_000, SAMPLE_RATE),
      lastPacket: now,
      silenceFedAt: now,
      cooldownUntil: 0,
      inputGain: 1,
      ignoreUntil: 0,
      ...(mode === "voiceprint" ? { vad: createVad(), pending: new Float32Array(0) } : { keywordStream: createKeywordStream() }),
      ...(streamingWake ? { keywordStream: createKeywordStream(), wakeBuffer: new sherpa.CircularBuffer(WAKE_BUFFER_SAMPLES + 1920) } : {}),
    };
    speakers.set(id, speaker);
  }
  if (streamingWake && now - speaker.lastPacket > 800) {
    speaker.keywordStream = createKeywordStream();
    speaker.wakeBuffer.reset();
    speaker.inputGain = 1;
  }
  speaker.lastPacket = now;
  speaker.silenceFedAt = now;
  const samples = speaker.resampler.resample(pcm);
  diagnosticAudioPackets++;
  if (!diagnosticAudioLogged) {
    diagnosticAudioLogged = true;
    let energy = 0;
    let peak = 0;
    for (const sample of samples) {
      energy += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }
    port.postMessage({ type: "diagnostic", stage: "audio", id, samples: samples.length, packets: diagnosticAudioPackets });
    port.postMessage({ type: "diagnostic", stage: "audioLevel", id, rms: Math.sqrt(energy / Math.max(samples.length, 1)), peak });
  }
  if (diagnosticAudioPackets % 100 === 0) {
    port.postMessage({ type: "diagnostic", stage: "audioProgress", id, packets: diagnosticAudioPackets });
  }

  if (mode === "voiceprint") {
    if (streamingWake && !voiceprintSession) {
      if (now >= speaker.cooldownUntil) feedStreamingWake(id, speaker, samples);
      return;
    }
    if (voiceprintSession && (voiceprintSession.id !== id || now < speaker.ignoreUntil)) return;
    feedVoiceprintVad(id, speaker, samples);
    return;
  }

  if (keywordSession) {
    if (keywordSession.id === id) {
      keywordSession.lastAudio = now;
      keywordSession.silenceFedAt = now;
      if (now < keywordSession.ignoreUntil) return;
      if (!keywordSession.heardSpeech) {
        let energy = 0;
        for (const sample of samples) energy += sample * sample;
        keywordSession.heardSpeech = energy / Math.max(samples.length, 1) > 0.0002;
      }
      feedKeywordVad(keywordSession, samples);
    }
    return;
  }
  if (now < speaker.cooldownUntil) return;
  if (keywordGap) speaker.keywordStream!.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: KEYWORD_LEADING_SILENCE });
  speaker.keywordStream!.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
  while (kws.isReady(speaker.keywordStream)) kws.decode(speaker.keywordStream);
  if (!kws.getResult(speaker.keywordStream).keyword) return;
  speaker.keywordStream = createKeywordStream();
  keywordSession = {
    id,
    started: now,
    heardSpeech: false,
    lastAudio: now,
    silenceFedAt: now,
    ignoreUntil: now + 250,
    vad: createVad(),
    pending: new Float32Array(0),
  };
  port.postMessage({ type: "wake", id });
}

try {
  sherpa = require("sherpa-onnx-node");
  kws = new sherpa.KeywordSpotter({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: modelPaths.encoder, decoder: modelPaths.decoder, joiner: modelPaths.joiner },
      tokens: modelPaths.kwsTokens, numThreads: 1, provider: "cpu", debug: 0,
    },
    keywordsFile: modelPaths.keywords,
    numTrailingBlanks: 1,
  });
  if (mode === "voiceprint") {
    embeddingExtractor = new sherpa.SpeakerEmbeddingExtractor({
      model: modelPaths.speakerModel,
      numThreads: 1,
      provider: "cpu",
      debug: 0,
    });
    rebuildEmbeddingManager(workerData.profiles ?? []);
  }
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      senseVoice: { model: modelPaths.asrModel, useInverseTextNormalization: 1 },
      tokens: modelPaths.asrTokens, numThreads: 2, provider: "cpu", debug: 0,
    },
  });
  port.on("message", (msg: {
    type: string;
    id?: number;
    pcm?: Float32Array;
    profiles?: Array<{ name: string; embedding: number[]; embeddings?: number[][] }>;
  }) => {
    if (msg.type === "audio" && msg.id && msg.pcm) receive(msg.id, msg.pcm);
    else if (msg.type === "profiles" && mode === "voiceprint") rebuildEmbeddingManager(msg.profiles ?? []);
    else if (msg.type === "cancel") {
      resetKeywordSession();
      voiceprintSession = null;
      speakers.clear();
    } else if (msg.type === "remove" && msg.id) {
      if (keywordSession?.id === msg.id) resetKeywordSession();
      if (voiceprintSession?.id === msg.id) voiceprintSession = null;
      speakers.delete(msg.id);
    }
  });
  setInterval(() => {
    const now = Date.now();
    for (const [id, speaker] of speakers) {
      if (now - speaker.lastPacket > SPEAKER_IDLE_MS) speakers.delete(id);
    }
    if (mode === "keyword") {
      if (keywordSession && now - keywordSession.lastAudio > VAD_SILENCE_FEED_MS && now - keywordSession.silenceFedAt >= VAD_SILENCE_FEED_MS) {
        keywordSession.silenceFedAt = now;
        feedKeywordVad(keywordSession, new Float32Array(VAD_SILENCE_SAMPLES));
      }
      if (keywordSession && now - keywordSession.started > (keywordSession.heardSpeech ? COMMAND_TIMEOUT_MS : START_TIMEOUT_MS)) {
        resetKeywordSession("语音指令超时，请重新唤醒");
      }
    } else {
      for (const [id, speaker] of speakers) {
        if (now - speaker.lastPacket > VAD_SILENCE_FEED_MS && now - speaker.silenceFedAt >= VAD_SILENCE_FEED_MS && speaker.vad) {
          speaker.silenceFedAt = now;
          if (streamingWake && !voiceprintSession) {
            // Stop after one second. Repeated silence must not evict recent speech.
            if (now - speaker.lastPacket < 1000 && now >= speaker.cooldownUntil) {
              feedStreamingWake(id, speaker, new Float32Array(VAD_SILENCE_SAMPLES));
            }
          } else if (!voiceprintSession || voiceprintSession.id === id) {
            feedVoiceprintVad(id, speaker, new Float32Array(VAD_SILENCE_SAMPLES));
          }
        }
      }
      if (voiceprintSession && now - voiceprintSession.started > COMMAND_TIMEOUT_MS) {
        const id = voiceprintSession.id;
        voiceprintSession = null;
        port.postMessage({ type: "failure", id, reason: "语音指令超时，请在唤醒后重新说话" });
      }
    }
  }, VAD_SILENCE_FEED_MS).unref();
  port.postMessage({ type: "ready", wakeEngine: streamingWake ? "streaming-keyword+voiceprint" : "streaming-keyword" });
} catch (err) {
  port.postMessage({ type: "error", message: (err as Error).message });
}
