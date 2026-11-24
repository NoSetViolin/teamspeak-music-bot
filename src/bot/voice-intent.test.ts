import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeVoiceCommand } from "./voice-command.js";
import { inferVoiceCommand } from "./voice-intent.js";

function completion(value: unknown) {
  return Response.json({ choices: [{ message: { content: JSON.stringify(value) } }] });
}

afterEach(() => vi.unstubAllGlobals());

describe("local semantic fallback", () => {
  it("distinguishes unknown wording from a canceled or compound command", () => {
    expect(analyzeVoiceCommand("这首听腻了，换个别的")).toBeNull();
    expect(analyzeVoiceCommand("暂停再调小一点")).toBe("blocked");
    expect(analyzeVoiceCommand("别停，继续放，歌名叫啥")).toBe("blocked");
    expect(analyzeVoiceCommand("别切歌")).toBe("blocked");
    expect(analyzeVoiceCommand("别切歌，声音小一点")).toEqual({ name: "vol", kind: "relative", value: -10 });
  });

  it.each([
    ["晴天先留到这首结束再放", { a: "playnext", s: "晴天" }, { name: "playnext", query: "晴天" }],
    ["王菲唱的红豆我现在想听", { a: "play", s: "红豆", r: "王菲" }, { name: "play", query: "红豆", artist: "王菲" }],
    ["王菲唱的红豆我现在想听", { a: "play", s: "红豆", r: "王菲", p: "qq" }, null],
    ["晴天先留着", { a: "playnext", s: "稻香" }, null],
    ["我接个电话，音乐等会儿再放", { a: "pause", v: 0 }, null],
    ["上一首叫什么？我问的是刚结束的那首", { a: "now" }, null],
    ["调到三成就够了", { a: "vol", v: 30 }, { name: "vol", kind: "absolute", value: 30 }],
    ["调到三成就够了", { a: "vol", v: 3 }, null],
    ["把音量调成负五", { a: "vol", v: 5 }, null],
    ["别调音量了", { a: "vol", d: -10 }, null],
  ])("checks model intent against %s", async (transcript, prediction, expected) => {
    const fetcher = vi.fn(async () => completion(prediction));
    vi.stubGlobal("fetch", fetcher);
    await expect(inferVoiceCommand(transcript)).resolves.toEqual(expected);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:18148/v1/chat/completions", expect.objectContaining({
      redirect: "error",
      method: "POST",
    }));
  });

  it("skips competing requests and releases the slot on failure", async () => {
    let fail!: (reason: Error) => void;
    const fetcher = vi.fn()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }))
      .mockResolvedValueOnce(completion({ a: "next" }));
    vi.stubGlobal("fetch", fetcher);
    const request = inferVoiceCommand("这首听腻了，换个别的");
    await expect(inferVoiceCommand("等会再说")).resolves.toBeNull();
    fail(new Error("timeout"));
    await expect(request).resolves.toBeNull();
    await expect(inferVoiceCommand("这首听腻了，换个别的")).resolves.toEqual({ name: "next" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
