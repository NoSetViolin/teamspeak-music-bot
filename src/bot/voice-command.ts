import type { Platform } from "../music/provider.js";

export type VoiceSongCommand = {
  name: "play" | "add" | "playnext";
  query: string;
  artist?: string;
  platform?: Platform;
  literalTitle?: string;
};

export type VoiceCommand =
  | VoiceSongCommand
  | { name: "pause" | "resume" | "prev" | "next" | "now" }
  | { name: "vol"; kind: "absolute" | "relative"; value: number };

type VoiceClause = { command: VoiceCommand; negated: boolean };

const PREFIX = /^(?:(?:麻烦(?:你)?|请(?:你)?|帮我|给我|我想(?:要)?|我要|你能不能|你能(?:不)?|能不能|可以|能|现在|先|马上)\s*)+/u;
const POLITENESS = /(?:[吧呗嘛吗]|可以吗|好吗|好不好|行不行|谢谢)+$/u;
const NEGATION = /^(?:不要|别|不用|不必|不想)(?:再)?\s*/u;
const MEDIA = "(?:B\\s*站|哔哩哔哩|bilibili|QQ\\s*音乐|网易云(?:\\s*音乐)?|酷狗(?:\\s*音乐)?|YouTube|Spotify|Jellyfin)";
const SOURCE_PREFIX = new RegExp(`^(?:在|用|从)\\s*(${MEDIA})(?:里|上|搜)?\\s*`, "iu");
const SOURCE_IN_QUERY = new RegExp(`^(${MEDIA})(?:上|里)的\\s*`, "iu");
const SOURCE_SUFFIX = new RegExp(`\\s*(?:在|用|从)\\s*(${MEDIA})(?:上|里)?$`, "iu");
const SOURCES: Readonly<Record<string, Platform>> = {
  b站: "bilibili",
  哔哩哔哩: "bilibili",
  bilibili: "bilibili",
  qq音乐: "qq",
  网易云: "netease",
  网易云音乐: "netease",
  酷狗: "kugou",
  酷狗音乐: "kugou",
  youtube: "youtube",
  spotify: "spotify",
  jellyfin: "jellyfin",
};

const CONTROLS: ReadonlyArray<[RegExp, "pause" | "resume" | "prev" | "next" | "now"]> = [
  [/^(?:把)?(?:(?:音乐|歌曲|(?:这|那)首(?:歌)?)(?:先)?)?(?:暂停(?:一下)?(?:播放|音乐|歌曲)?|停(?:一下)?(?:播放|音乐|歌曲)?|暂时停(?:一下)?|等一下再播放?)$/u, "pause"],
  [/^(?:继续(?:(?:播(?:放)?|放|听)(?:歌|(?:这|那)首(?:歌)?)?|(?:这|那)首(?:歌)?)?|接着(?:播(?:放)?|放|放歌|听)|恢复(?:播放|音乐)?)$/u, "resume"],
  [/^(?:上一首(?:歌)?|(?:切回|换回|重播|再放一遍)(?:到)?上一首(?:歌)?|返回上一首(?:歌)?)$/u, "prev"],
  [/^(?:下一首(?:歌)?|(?:换|切(?:到)?)(?:一?首|下一首)(?:歌)?|换歌|切歌|跳(?:过)?(?:这|那)首(?:歌)?|跳过(?:当前(?:这首)?(?:歌)?)?|这首(?:歌)?跳过)$/u, "next"],
  [/^(?:(?:现在|正在|当前)?(?:播(?:放)?|放|听|唱)的(?:是)?(?:哪首(?:歌)?|什么(?:歌)?)|(?:现在|当前)?(?:这|那)首(?:歌)?(?:叫(?:什么(?:名字)?|啥)|是(?:哪首(?:歌)?|什么歌))|歌名(?:是|叫)(?:什么|啥))$/u, "now"],
];

const CHINESE_DIGITS = "零一二三四五六七八九";

export function parseVolumeNumber(text: string): number | undefined {
  if (/^\d{1,3}$/u.test(text)) return Number(text);
  const number = text.replace(/〇/g, "零").replace(/两/g, "二");
  if (number === "一百" || number === "一百零") return 100;
  if (number.length === 1 && CHINESE_DIGITS.includes(number)) return CHINESE_DIGITS.indexOf(number);
  const tens = /^([一二三四五六七八九])?十([一二三四五六七八九])?$/u.exec(number);
  if (tens) return (tens[1] ? CHINESE_DIGITS.indexOf(tens[1]) : 1) * 10 + (tens[2] ? CHINESE_DIGITS.indexOf(tens[2]) : 0);
}

function parseVolume(text: string): VoiceCommand | undefined {
  const absolute = /^(?:把)?(?:音量|声音)?(?:调到|调至|调成|调为|设到|设成|设置为|设为|开到|降到|降低到|提高到|加到)(?:百分之)?([\d零〇一二两三四五六七八九十百]+)%?$/u.exec(text);
  if (absolute) {
    const value = parseVolumeNumber(absolute[1]);
    if (value !== undefined && value <= 100) return { name: "vol", kind: "absolute", value };
  }
  const relative = /^(?:把)?(?:音乐|音量|声音)?(?:调|放|开|弄)?(小|低|轻|降|降低|减|减少|大|高|响|加|提高|增加)(?:一?点(?:儿)?|一些|一下)$/u.exec(text);
  if (relative) return { name: "vol", kind: "relative", value: "小低轻降降低减减少".includes(relative[1]) ? -10 : 10 };
}

const PLAY_PREFIX = /^(?:(?:想|要)?听(?:一?首|一下)?|(?:播放|点歌|放|播|来)(?:一?首)?)(?:\s|[:：])*/u;
const INSERT_PREFIX = /^(?:下一首(?:歌)?(?:就)?(?:放|播(?:放)?|听)|插播)(?:一?首)?\s*/u;
const QUEUE_SUFFIX = /(?:(?:加(?:入|到|进)|排(?:到|在|进)|放(?:到|在|进))(?:播放)?(?:列表(?:里|末尾|最后)?|队列(?:里|末尾|最后)?|队尾|最后|后面|最后面)|排队)$/u;
const QUEUE_PREFIX = /^(?:排队(?:播放)?|排一首|(?:加(?:入|到|进)|排(?:到|在|进))(?:播放)?(?:列表|队列|队尾))\s*/u;
const INSERT_SUFFIX = /(?:排|加|插|放)(?:到|在|作(?:为)?)?下一首(?:播(?:放)?|放)?$/u;
const QUOTED_TITLE = /^(?:《([^》]+)》|“([^”]+)”|「([^」]+)」|"([^"]+)")$/u;
const CLAUSE_BOUNDARY = /《[^》]+》|“[^”]+”|「[^」]+」|"[^"]+"|https?:\/\/[^\s,;。!]+|[,;。!?]+|(?:然后(?:再)?|接着|并且|同时|但是|不过|再|并)(?=\s*(?:把|帮我|给我|暂停|继续|恢复|切歌|切到|换(?:一)?首|跳过|上一首|下一首|播放|放(?:一)?首|调(?:高|低|到|大|小)|音量|声音))/giu;

function unquote(text: string): string {
  const quoted = QUOTED_TITLE.exec(text);
  return quoted ? quoted.slice(1).find(Boolean)! : text;
}

function parseSongCommand(text: string): VoiceSongCommand | undefined {
  text = text.replace(/(?:可以吗|好不好|谢谢|[吧呗])$/u, "").trim();
  let platform: Platform | undefined;
  const source = SOURCE_PREFIX.exec(text) ?? SOURCE_SUFFIX.exec(text);
  if (source) {
    platform = SOURCES[source[1].toLowerCase().replace(/\s+/gu, "")];
    text = (source.index === 0 ? text.slice(source[0].length) : text.slice(0, source.index)).trim();
  }

  let name: VoiceSongCommand["name"] = "play";
  const insert = INSERT_PREFIX.exec(text) ?? INSERT_SUFFIX.exec(text);
  const queue = QUEUE_PREFIX.exec(text) ?? QUEUE_SUFFIX.exec(text);
  const play = PLAY_PREFIX.exec(text);
  const action = insert ?? queue ?? play;
  if (!action || (insert && queue)) return;
  if (insert) name = "playnext";
  else if (queue) name = "add";
  let query = (action.index === 0 ? text.slice(action[0].length) : text.slice(0, action.index).replace(/^把/u, "")).trim();
  if (action.index > 0) query = query.replace(PLAY_PREFIX, "");
  const sourceInQuery = SOURCE_IN_QUERY.exec(query);
  if (sourceInQuery) {
    const requested = SOURCES[sourceInQuery[1].toLowerCase().replace(/\s+/gu, "")];
    if (platform && platform !== requested) return;
    platform = requested;
    query = query.slice(sourceInQuery[0].length).trim();
  }

  const explicitTitle = /^(?:歌名叫|歌名是|名字叫|一首叫)(?:\s|:)*\s*/u.exec(query);
  if (explicitTitle) query = query.slice(explicitTitle[0].length);
  query = query.replace(/([》”」"])(?:吗|嘛|好吗)$/u, "$1");
  const quoted = QUOTED_TITLE.test(query);
  const artistAndTitle = !explicitTitle && !quoted && /^([^《“「"\s].*?)(演唱的|唱的|的)\s*(.+)$/u.exec(query);
  let artist: string | undefined;
  let literalTitle: string | undefined;
  if (artistAndTitle && !/^(?:我|你|他|她|它|我们|你们|他们|她们)$/u.test(artistAndTitle[1])) {
    artist = artistAndTitle[1].trim();
    const title = artistAndTitle[3].trim();
    if (artistAndTitle[2] === "的" && !QUOTED_TITLE.test(title) && query.length <= 120) literalTitle = query;
    query = title;
  }
  query = unquote(query);
  if (!query || query.length > 120 || (artist && artist.length > 80)) return;
  if (!quoted && /^(?:歌|一首歌|个歌|音乐|这首(?:歌)?|那首(?:歌)?|什么(?:歌)?|啥(?:歌)?|聊.*|看看.*|说说.*|玩一下|试试|一首|首)$/u.test(query)) return;
  return {
    name,
    query,
    ...(artist ? { artist } : {}),
    ...(platform ? { platform } : {}),
    ...(literalTitle ? { literalTitle } : {}),
  };
}

function parseClause(clause: string): VoiceClause | undefined {
  let text = clause.trim().replace(PREFIX, "");
  const negated = NEGATION.test(text);
  if (negated) text = text.replace(NEGATION, "").replace(PREFIX, "");
  const controlText = text.replace(/\s+/gu, "").replace(POLITENESS, "");
  for (const [pattern, name] of CONTROLS) {
    if (pattern.test(controlText)) return { command: { name }, negated };
  }
  const command = parseVolume(controlText) ?? parseSongCommand(text);
  if (command) return { command, negated };
}

export function voiceSourceWasSpoken(platform: Platform, normalizedTranscript: string): boolean {
  return Object.entries(SOURCES).some(([phrase, source]) => source === platform && normalizedTranscript.includes(phrase));
}

export function analyzeVoiceCommand(transcript: string): VoiceCommand | "blocked" | null {
  if (transcript.length > 300) return "blocked";
  const text = transcript.normalize("NFKC").replace(/<\|[^|]*\|>/g, "").trim()
    .replace(/^布鲁斯[,、\s]*布鲁斯[,。!?\s]*/u, "");
  const clauses: string[] = [];
  let start = 0;
  for (const match of text.matchAll(CLAUSE_BOUNDARY)) {
    if (QUOTED_TITLE.test(match[0]) || /^https?:\/\//iu.test(match[0])) continue;
    const before = text.slice(start, match.index).trim();
    if (!/^[,;。!?]/u.test(match[0]) && !parseClause(before)) continue;
    if (before) clauses.push(before);
    start = match.index + match[0].length;
  }
  clauses.push(text.slice(start));

  let intent: VoiceCommand | undefined;
  let unknown = false;
  const negated = new Set<VoiceCommand["name"]>();
  for (const rawClause of clauses) {
    const clause = rawClause.trim();
    if (!clause || /^(?:嗯|呃|那个|我想|请|麻烦你|帮我|谢谢(?:你)?|好的?|可以吗|好吗|好不好|拜托(?:了)?)$/u.test(clause)) continue;
    const parsed = parseClause(clause);
    if (!parsed) unknown = true;
    else if (parsed.negated) negated.add(parsed.command.name);
    else if (intent) return "blocked";
    else intent = parsed.command;
  }
  if (intent && negated.has(intent.name)) return "blocked";
  return unknown ? null : intent ?? "blocked";
}

export function parseVoiceCommand(transcript: string): VoiceCommand | null {
  const result = analyzeVoiceCommand(transcript);
  return result === "blocked" ? null : result;
}
