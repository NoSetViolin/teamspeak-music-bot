import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";

const port = parentPort!;
const require = createRequire(import.meta.url);
const SAMPLE_RATE = 16_000;
const WAKE_PHRASE = workerData.wakePhrase as string;
const modelPaths = workerData.paths as Record<string, string>;
const MAX_SPEAKERS = 8;
const SPEAKER_IDLE_MS = 15_000;
const COMMAND_TIMEOUT_MS = 8_000;
const START_TIMEOUT_MS = 5_000;
const COOLDOWN_MS = 2_000;
const KEYWORD_GAP_MS = 120;
const KEYWORD_LEADING_SILENCE = new Float32Array(SAMPLE_RATE / 2);

type NativeStream = {
  acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void;
};
type Speaker = {
  resampler: { resample(samples: Float32Array): Float32Array };
  keywordStream: NativeStream;
  lastPacket: number;
  cooldownUntil: number;
};
type Session = {
  id: number;
  started: number;
  heardSpeech: boolean;
  lastAudio: number;
  silenceFedAt: number;
  ignoreUntil: number;
  vad: any;
  pending: Float32Array;
};

const speakers = new Map<number, Speaker>();
let active: Session | null = null;
let kws: any;
let recognizer: any;
let sherpa: any;

function createKeywordStream(): NativeStream {
  const stream: NativeStream = kws.createStream();
  // TeamSpeak voice activation may begin with the first spoken packet.
  stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: KEYWORD_LEADING_SILENCE });
  return stream;
}

function resetActive(reason?: string): void {
  const session = active;
  if (!session) return;
  active = null;
  const speaker = speakers.get(session.id);
  if (speaker) {
    speaker.keywordStream = createKeywordStream();
    speaker.cooldownUntil = Date.now() + COOLDOWN_MS;
  }
  if (reason) port.postMessage({ type: "failure", id: session.id, reason });
}

function feedVad(session: Session, samples: Float32Array): void {
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
    resetActive("没有听清语音指令");
    return;
  }
  // Decode in this worker so a slow ASR pass never interrupts music packets.
  try {
    const stream = recognizer.createStream();
    stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: segment.samples });
    recognizer.decode(stream);
    const text = String(recognizer.getResult(stream).text ?? "").trim();
    const id = session.id;
    resetActive();
    port.postMessage({ type: "result", id, text });
  } catch (err) {
    resetActive(`语音识别失败：${(err as Error).message}`);
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
      keywordStream: createKeywordStream(),
      lastPacket: now,
      cooldownUntil: 0,
    };
    speakers.set(id, speaker);
  }
  speaker.lastPacket = now;
  const samples = speaker.resampler.resample(pcm);
  if (active) {
    if (active.id === id) {
      active.lastAudio = now;
      active.silenceFedAt = now;
      if (now < active.ignoreUntil) return;
      if (!active.heardSpeech) {
        let energy = 0;
        for (const sample of samples) energy += sample * sample;
        active.heardSpeech = energy / Math.max(samples.length, 1) > 0.0002;
      }
      feedVad(active, samples);
    }
    return;
  }
  if (now < speaker.cooldownUntil) return;
  // TeamSpeak also omits silence between utterances from the same speaker.
  if (keywordGap) speaker.keywordStream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: KEYWORD_LEADING_SILENCE });
  speaker.keywordStream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
  while (kws.isReady(speaker.keywordStream)) kws.decode(speaker.keywordStream);
  if (kws.getResult(speaker.keywordStream).keyword !== WAKE_PHRASE) return;
  speaker.keywordStream = createKeywordStream();
  active = {
    id,
    started: now,
    heardSpeech: false,
    lastAudio: now,
    silenceFedAt: now,
    ignoreUntil: now + 250,
    vad: new sherpa.Vad({
      sileroVad: {
        model: modelPaths.vadModel,
        threshold: 0.5,
        minSpeechDuration: 0.25,
        minSilenceDuration: 0.6,
        windowSize: 512,
      },
      sampleRate: SAMPLE_RATE,
      numThreads: 1,
      debug: false,
    }, 10),
    pending: new Float32Array(0),
  };
  port.postMessage({ type: "wake", id });
}

try {
  sherpa = require("sherpa-onnx-node");
  const p = modelPaths;
  kws = new sherpa.KeywordSpotter({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: p.encoder, decoder: p.decoder, joiner: p.joiner },
      tokens: p.kwsTokens, numThreads: 1, provider: "cpu", debug: 0,
    },
    keywordsFile: p.keywords,
  });
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      senseVoice: { model: p.asrModel, useInverseTextNormalization: 1 },
      tokens: p.asrTokens, numThreads: 2, provider: "cpu", debug: 0,
    },
  });
  port.on("message", (msg: { type: string; id?: number; pcm?: Float32Array }) => {
    if (msg.type === "audio" && msg.id && msg.pcm) receive(msg.id, msg.pcm);
    else if (msg.type === "cancel") resetActive();
    else if (msg.type === "remove" && msg.id) {
      if (active?.id === msg.id) resetActive();
      speakers.delete(msg.id);
    }
  });
  setInterval(() => {
    const now = Date.now();
    for (const [id, speaker] of speakers) {
      if (now - speaker.lastPacket > SPEAKER_IDLE_MS) speakers.delete(id);
    }
    // TeamSpeak normally stops sending packets at the end of speech. Feed
    // silence ourselves so VAD can close the utterance after its silence limit.
    if (active && now - active.lastAudio > 100 && now - active.silenceFedAt >= 200) {
      active.silenceFedAt = now;
      feedVad(active, new Float32Array(4000));
    }
    if (active && now - active.started > (active.heardSpeech ? COMMAND_TIMEOUT_MS : START_TIMEOUT_MS)) {
      resetActive("语音指令超时，请重新唤醒");
    }
  }, 250).unref();
  port.postMessage({ type: "ready" });
} catch (err) {
  port.postMessage({ type: "error", message: (err as Error).message });
}
