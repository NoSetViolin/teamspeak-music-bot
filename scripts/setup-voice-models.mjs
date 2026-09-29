import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = path.resolve('data', 'voice-models');
mkdirSync(root, { recursive: true });
const releases = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';
const archives = [
  ['kws-models', 'sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01.tar.bz2'],
  ['asr-models', 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2'],
];

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status} ${url}`);
  const temporary = `${destination}.download`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
  renameSync(temporary, destination);
}

function extract(archive) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xf', archive, '-C', root], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`tar exited ${code}`)));
  });
}

for (const [group, name] of archives) {
  const directory = path.join(root, name.replace(/\.tar\.bz2$/, ''));
  const required = group === 'kws-models'
    ? path.join(directory, 'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx')
    : path.join(directory, 'model.int8.onnx');
  if (existsSync(required)) continue;
  const archive = path.join(root, name);
  if (!existsSync(archive)) {
    console.log(`Downloading ${name}`);
    await download(`${releases}/${group}/${name}`, archive);
  }
  await extract(archive);
  if (!existsSync(required)) throw new Error(`Archive did not contain ${required}`);
  rmSync(archive);
}
const vad = path.join(root, 'silero_vad.onnx');
if (!existsSync(vad)) {
  console.log('Downloading silero_vad.onnx');
  await download(`${releases}/asr-models/silero_vad.onnx`, vad);
}
// The bundled WenetSpeech KWS model uses partial pinyin tokens. This is
// bù lǔ sī bù lǔ sī, with the original text returned on detection.
writeFileSync(path.join(root, 'keywords.txt'), 'b ù l ǔ s ī b ù l ǔ s ī :2.0 #0.5 @布鲁斯布鲁斯\n', 'utf8');
console.log(`Voice models ready in ${root}`);
