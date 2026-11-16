import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { getFfmpegCommand } from "../audio/player.js";
import { voiceModelPaths } from "./voice-models.js";

const require = createRequire(import.meta.url);
const SAMPLE_RATE = 16_000;
const MIN_SAMPLES = SAMPLE_RATE;
const MAX_SAMPLES = SAMPLE_RATE * 10;
let extractor: any;
let recognizer: any;

function decodeToPcm(audio: Buffer): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const child = spawn(getFfmpegCommand(), [
      "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
      "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "pipe:1",
    ], { stdio: ["pipe", "pipe", "pipe"] });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) {
        reject(error);
        return;
      }
      const pcm = Buffer.concat(output);
      if (pcm.length % 4 !== 0) {
        reject(new Error("音频解码结果无效"));
        return;
      }
      const samples = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4);
      if (samples.length < MIN_SAMPLES) {
        reject(new Error("录音太短，请完整说出“布鲁斯布鲁斯”"));
        return;
      }
      if (samples.length > MAX_SAMPLES) {
        reject(new Error("录音超过 10 秒，请重新录制"));
        return;
      }
      resolve(new Float32Array(samples));
    };
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.concat(errors).length < 4096) errors.push(chunk);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code !== 0) {
        const detail = Buffer.concat(errors).toString("utf8").trim();
        finish(new Error(detail || "无法解码浏览器录音"));
      } else {
        finish();
      }
    });
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error("录音处理超时，请重试"));
    }, 12_000);
    timeout.unref();
    child.once("close", () => clearTimeout(timeout));
    child.stdin.end(audio);
  });
}

function getModels(): { extractor: any; recognizer: any } {
  if (extractor && recognizer) return { extractor, recognizer };
  const sherpa = require("sherpa-onnx-node");
  const paths = voiceModelPaths();
  extractor = new sherpa.SpeakerEmbeddingExtractor({
    model: paths.speakerModel,
    numThreads: 1,
    provider: "cpu",
    debug: 0,
  });
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      senseVoice: { model: paths.asrModel, useInverseTextNormalization: 1 },
      tokens: paths.asrTokens,
      numThreads: 2,
      provider: "cpu",
      debug: 0,
    },
  });
  return { extractor, recognizer };
}

export async function createVoiceprintFromBrowserAudio(
  audio: Buffer,
  requireWakePhrase = true,
): Promise<{ embedding: number[]; transcript: string; duration: number; rms: number }> {
  if (audio.length < 1_000 || audio.length > 350_000) {
    throw new Error("录音文件大小不合适，请重新录制");
  }
  const samples = await decodeToPcm(audio);
  let energy = 0;
  for (const sample of samples) energy += sample * sample;
  const rms = Math.sqrt(energy / samples.length);
  if (rms < 0.0001) throw new Error("录音音量过低或没有声音，请检查麦克风后重录这一句");
  const models = getModels();
  const embeddingStream = models.extractor.createStream();
  embeddingStream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
  embeddingStream.inputFinished();
  if (!models.extractor.isReady(embeddingStream)) {
    throw new Error("声纹样本不够清晰，请在安静环境中重新录制");
  }
  const embedding = Array.from(models.extractor.compute(embeddingStream)) as number[];

  const asrStream = models.recognizer.createStream();
  asrStream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
  models.recognizer.decode(asrStream);
  const transcript = String(models.recognizer.getResult(asrStream).text ?? "").trim();
  const normalized = transcript.replace(/<\|[^|]*\|>/g, "").replace(/[^\p{Script=Han}]/gu, "");
  if (!normalized) throw new Error("没有检测到清晰的人声，请重新录制这一句");
  if (requireWakePhrase && !normalized.includes("布鲁斯布鲁斯")) {
    throw new Error(`没有听到完整唤醒词，识别结果是“${transcript || "空白"}”`);
  }
  return { embedding, transcript, duration: samples.length / SAMPLE_RATE, rms };
}
