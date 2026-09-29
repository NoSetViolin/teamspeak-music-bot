import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const VOICE_MODEL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "voice-models");
export const WAKE_PHRASE = "布鲁斯布鲁斯";
const KEYWORD_LINE = "b ù l ǔ s ī b ù l ǔ s ī :1.2 #0.5 @布鲁斯布鲁斯\n";
const KWS_DIR = "sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01";
const ASR_DIR = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17";

export function voiceModelPaths(root = VOICE_MODEL_DIR) {
  const kws = path.join(root, KWS_DIR);
  const asr = path.join(root, ASR_DIR);
  const stem = "epoch-12-avg-2-chunk-16-left-64.int8.onnx";
  return {
    encoder: path.join(kws, `encoder-${stem}`),
    decoder: path.join(kws, `decoder-${stem}`),
    joiner: path.join(kws, `joiner-${stem}`),
    kwsTokens: path.join(kws, "tokens.txt"),
    keywords: path.join(root, "keywords.txt"),
    asrModel: path.join(asr, "model.int8.onnx"),
    asrTokens: path.join(asr, "tokens.txt"),
    vadModel: path.join(root, "silero_vad.onnx"),
  };
}

export function missingVoiceModels(root = VOICE_MODEL_DIR): string[] {
  return Object.values(voiceModelPaths(root)).filter((file) => !existsSync(file));
}

/** Refresh the generated keyword file for installations with older models. */
export function ensureVoiceKeyword(root = VOICE_MODEL_DIR): void {
  const file = voiceModelPaths(root).keywords;
  if (!existsSync(file) || readFileSync(file, "utf8") !== KEYWORD_LINE) {
    writeFileSync(file, KEYWORD_LINE, "utf8");
  }
}
