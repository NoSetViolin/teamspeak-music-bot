import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pinyin } from "pinyin-pro";

export const VOICE_MODEL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "voice-models");
export const WAKE_PHRASE = "布鲁斯布鲁斯";
export type VoiceWakeMode = "voiceprint" | "keyword";
const DEFAULT_KEYWORD_LINE = `b ù l ǔ s ī b ù l ǔ s ī :1.8 #0.15 @${WAKE_PHRASE}\n`;
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
    asrModel: path.join(asr, "model.int8.onnx"),
    asrTokens: path.join(asr, "tokens.txt"),
    vadModel: path.join(root, "silero_vad.onnx"),
    speakerModel: path.join(root, "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"),
  };
}

export function missingVoiceModels(root?: string): string[];
export function missingVoiceModels(mode?: VoiceWakeMode, root?: string): string[];
export function missingVoiceModels(
  modeOrRoot: VoiceWakeMode | string = "voiceprint",
  root = VOICE_MODEL_DIR,
): string[] {
  const mode: VoiceWakeMode = modeOrRoot === "keyword" ? "keyword" : "voiceprint";
  const modelRoot = modeOrRoot === "keyword" || modeOrRoot === "voiceprint" ? root : modeOrRoot;
  const paths = voiceModelPaths(modelRoot);
  const required = [paths.encoder, paths.decoder, paths.joiner, paths.kwsTokens, paths.asrModel, paths.asrTokens, paths.vadModel];
  if (mode === "voiceprint") required.push(paths.speakerModel);
  return required.filter((file) => !existsSync(file));
}

export function normalizeVoiceWakePhrase(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const phrase = value.trim();
  if (!phrase) return WAKE_PHRASE;
  if (/^\p{Script=Han}{2,12}$/u.test(phrase)) return phrase;
}

export function voiceWakeSyllables(phrase: string): string[] {
  return pinyin(phrase, { type: "array", toneSandhi: false });
}

export function buildVoiceKeyword(phrase: string, tokensFile = voiceModelPaths().kwsTokens): string {
  if (phrase === WAKE_PHRASE) return DEFAULT_KEYWORD_LINE;
  if (normalizeVoiceWakePhrase(phrase) !== phrase) throw new Error("唤醒词请输入 2～12 个汉字");
  if (!existsSync(tokensFile)) throw new Error("请先在服务端运行 npm run setup:voice 安装语音模型");
  const vocabulary = new Set(readFileSync(tokensFile, "utf8").split(/\r?\n/u).map(line => line.split(/\s+/u)[0]));
  const keywords = voiceWakeSyllables(phrase).flatMap(syllable => {
    const initial = /^(?:zh|ch|sh|[bpmfdtnlgkhjqxrzcswy])/u.exec(syllable)?.[0] ?? "";
    return [initial, syllable.slice(initial.length)].filter(Boolean);
  });
  if (!keywords.length || keywords.some(token => !vocabulary.has(token))) {
    throw new Error("唤醒词含有当前语音模型不支持的读音，请换一组常用汉字");
  }
  return `${keywords.join(" ")} :1.8 #0.15 @${phrase}\n`;
}
