import { parseVolumeNumber, voiceSourceWasSpoken, type VoiceCommand } from "./voice-command.js";

const URL = "http://127.0.0.1:18148/v1/chat/completions";
const CONTROLS = ["pause", "resume", "prev", "next", "now", "none"] as const;
const SONG_ACTIONS = ["play", "add", "playnext"] as const;
const SOURCES = ["qq", "netease", "bilibili", "youtube", "kugou", "spotify", "jellyfin"] as const;
const PROMPT = `把用户这句话解析为一条音乐操作，只给JSON。a是操作：play立即播放，add加到整个队列末尾，playnext当前这首一结束就播指定歌曲，next跳过当前这首，prev回放上一首，pause暂停，resume恢复暂停的音乐，now查询当前歌，vol调音量，none无有效请求。有明确歌名才填s，有明确歌手才填r，有明确音源才填p（qq/netease/bilibili/youtube/kugou/spotify/jellyfin）。vol用v表示绝对百分比或d表示相对十个百分点。保留现状和否定句不执行；两条肯定动作就用none，暂时操作只执行当前一步。只问已结束的歌用none。
例：
直接给我来一首演员 -> {"a":"play","s":"演员"}
这首播完就换到听海 -> {"a":"playnext","s":"听海"}
别弄停，声音再低一丢丢 -> {"a":"vol","d":-10}
我觉得这首好听，保持这样 -> {"a":"none"}`;

function shape(action: string, fields: Record<string, unknown> = {}, required: string[] = []) {
  return { type: "object", properties: { a: { const: action }, ...fields }, required: ["a", ...required], additionalProperties: false };
}

const SCHEMA = {
  oneOf: [
    ...CONTROLS.map(action => shape(action)),
    ...SONG_ACTIONS.map(action => shape(action, { s: { type: "string" }, r: { type: "string" }, p: { enum: SOURCES } }, ["s"])),
    shape("vol", { d: { enum: [-10, 10] } }, ["d"]),
    shape("vol", { v: { type: "integer", minimum: 0, maximum: 100 } }, ["v"]),
  ],
};

function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[\s\p{P}]/gu, "");
}

function fieldWasSpoken(field: unknown, spoken: string, limit: number): field is string {
  return typeof field === "string" && field.length <= limit && !!normalize(field) && spoken.includes(normalize(field));
}

function hasSpokenVolume(transcript: string, volume: number): boolean {
  for (const [, sign, number, fraction, suffix] of transcript.normalize("NFKC").matchAll(/(负|-\s*)?([0-9零〇一二两三四五六七八九十百]+)([.点][0-9零〇一二两三四五六七八九]+)?(成|%)?/gu)) {
    if (sign || fraction) continue;
    const value = parseVolumeNumber(number);
    if (value !== undefined && (suffix === "成" ? value * 10 : value) === volume) return true;
  }
  return false;
}

function validate(value: unknown, transcript: string): VoiceCommand | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const fields = Object.keys(raw);
  const action = CONTROLS.find(candidate => candidate === raw.a);
  if (action) {
    if (fields.length !== 1 || action === "none") return null;
    if (action === "now" && /上一首|刚结束的|刚播完的|刚才那首/u.test(transcript)) return null;
    if (action === "next" && /(?:别|不要|不用|别再)\s*(?:切|换|跳)/u.test(transcript)) return null;
    if (action === "pause" && /(?:别|不要|不用|别再)\s*(?:停|暂停)/u.test(transcript)) return null;
    return { name: action };
  }
  if (raw.a === "vol" && fields.length === 2) {
    if (/(?:别|不要|不用)(?:再)?\s*(?:改|调)(?:声音|音量)/u.test(transcript)) return null;
    if (raw.d === -10 || raw.d === 10) return { name: "vol", kind: "relative", value: raw.d };
    if (typeof raw.v === "number" && Number.isInteger(raw.v) && raw.v >= 0 && raw.v <= 100 && hasSpokenVolume(transcript, raw.v)) {
      return { name: "vol", kind: "absolute", value: raw.v };
    }
    return null;
  }
  const name = SONG_ACTIONS.find(candidate => candidate === raw.a);
  if (!name || fields.some(field => !["a", "s", "r", "p"].includes(field))) return null;
  const spoken = normalize(transcript);
  if (!fieldWasSpoken(raw.s, spoken, 120) || (raw.r !== undefined && !fieldWasSpoken(raw.r, spoken, 80))) return null;
  const platform = SOURCES.find(candidate => candidate === raw.p);
  if (raw.p !== undefined && (!platform || !voiceSourceWasSpoken(platform, spoken))) return null;
  return { name, query: raw.s.trim(), ...(typeof raw.r === "string" ? { artist: raw.r.trim() } : {}), ...(platform ? { platform } : {}) };
}

let busy = false;

export async function inferVoiceCommand(transcript: string): Promise<VoiceCommand | null> {
  const text = transcript.replace(/<\|[^|]*\|>/g, "").trim();
  if (busy || !text || text.length > 300) return null;
  busy = true;
  try {
    const response = await fetch(URL, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(4_000),
      body: JSON.stringify({
        model: "voice-intent",
        messages: [{ role: "system", content: PROMPT }, { role: "user", content: text }],
        temperature: 0,
        seed: 42,
        stream: false,
        max_tokens: 48,
        chat_template_kwargs: { enable_thinking: false },
        response_format: { type: "json_schema", json_schema: { name: "voice_intent", schema: SCHEMA } },
      }),
    });
    if (!response.ok) return null;
    const data = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = data.choices?.[0]?.message?.content;
    return typeof content === "string" && content.length <= 512 ? validate(JSON.parse(content), text) : null;
  } catch {
    return null;
  } finally {
    busy = false;
  }
}
