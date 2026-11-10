// BGM をコードだけで合成して WAV に書き出す（サンプル素材なし）。120BPM / 1小節=2秒で映像のカットと同期。
import fs from 'node:fs';
const sr = 44100, DUR = 30.5, n = Math.floor(sr * DUR);
const mk = () => [new Float32Array(n), new Float32Array(n)];
const drums = mk(), mus = mk(), send = mk();
let seedv = 12345; const rnd = () => { seedv = (seedv * 1664525 + 1013904223) >>> 0; return seedv / 4294967296; };
const noise = () => rnd() * 2 - 1;
const TAU = Math.PI * 2;
function add(bus, i, v, pan = 0) { if (i < 0 || i >= n) return; bus[0][i] += v * Math.min(1, 1 - pan); bus[1][i] += v * Math.min(1, 1 + pan); }
const svf = () => { let low = 0, band = 0; return (x, fc, q = .7) => { const f = 2 * Math.sin(Math.PI * Math.min(fc, 6500) / sr); low += f * band; const high = x - low - q * band; band += f * high; return low; }; };
const saw = ph => 2 * (ph - Math.floor(ph + .5));

const kicks = [];
function kick(t0, g = 1) {
  kicks.push(t0); let ph = 0; const i0 = Math.floor(t0 * sr);
  for (let i = 0; i < sr * .4; i++) { const t = i / sr; ph += TAU * (46 + 130 * Math.exp(-t * 32)) / sr; add(drums, i0 + i, g * (Math.sin(ph) * Math.exp(-t * 8.5) + .25 * noise() * Math.exp(-t * 180))); }
}
function hat(t0, g = .2, len = .03, pan = .2) {
  const i0 = Math.floor(t0 * sr); let prev = 0;
  for (let i = 0; i < sr * len * 6; i++) { const x = noise(), hp = x - prev; prev = x; add(drums, i0 + i, g * hp * Math.exp(-i / sr / len), pan); }
}
function clap(t0, g = .35) {
  const i0 = Math.floor(t0 * sr), f = svf();
  for (let i = 0; i < sr * .25; i++) {
    const t = i / sr; let e = Math.exp(-t * 22); for (const d of [0, .011, .023]) if (t >= d && t < d + .01) e = Math.max(e, 1);
    const x = noise(), v = (x - f(x, 900)) * e * g; add(drums, i0 + i, v, -.1); add(send, i0 + i, v * .25);
  }
}
function bass(t0, dur, freq, g = .34) {
  const i0 = Math.floor(t0 * sr), f = svf(); let ph = 0;
  for (let i = 0; i < sr * dur; i++) {
    const t = i / sr; ph += freq / sr;
    const env = Math.min(1, t * 200) * Math.min(1, (dur - t) * 60);
    const x = saw(ph) * .7 + Math.sin(TAU * ph) * .8 + (ph % 1 < .5 ? .25 : -.25);
    add(mus, i0 + i, g * env * f(x, 180 + 900 * Math.exp(-t * 14), .5));
  }
}
function pluck(t0, freq, g = .2, pan = 0, decay = 8, bright = 3000, wet = .5) {
  const i0 = Math.floor(t0 * sr), f = svf(); let p1 = 0, p2 = 0;
  const len = Math.min(3, 6 / decay);
  for (let i = 0; i < sr * len; i++) {
    const t = i / sr; p1 += freq / sr; p2 += freq * 1.006 / sr;
    const v = g * Math.min(1, t * 400) * Math.exp(-t * decay) * f(saw(p1) + saw(p2), 300 + bright * Math.exp(-t * 10), .6);
    add(mus, i0 + i, v, pan); add(send, i0 + i, v * wet, -pan);
  }
}
function pad(t0, dur, freqs, g = .05, att = .6, rel = 1.2, cut = 1400) {
  const i0 = Math.floor(t0 * sr);
  freqs.forEach((fr, k) => {
    const f = svf(), ph = [rnd(), rnd(), rnd()], det = [1, 1.004, .996], pan = (k % 2 ? .5 : -.5) * (k / freqs.length + .3);
    for (let i = 0; i < sr * (dur + rel); i++) {
      const t = i / sr; let x = 0; for (let j = 0; j < 3; j++) { ph[j] += fr * det[j] / sr; x += saw(ph[j]); }
      const env = Math.min(1, t / att) * (t > dur ? Math.max(0, 1 - (t - dur) / rel) : 1);
      const v = g * env * f(x, cut * (.7 + .3 * Math.sin(t * .9 + k)), .4);
      add(mus, i0 + i, v, pan); add(send, i0 + i, v * .5, -pan);
    }
  });
}
function riser(t0, t1, g = .3) {
  const i0 = Math.floor(t0 * sr), f = svf(), d = t1 - t0;
  for (let i = 0; i < sr * d; i++) { const k = i / sr / d, x = noise(), v = g * k * k * (f(x, 300 + 6000 * k * k, .25) - .0); add(drums, i0 + i, v * (1 - .4 * k), Math.sin(k * 20) * .5); add(send, i0 + i, v * .3); }
}
function impact(t0, g = 1) {
  const i0 = Math.floor(t0 * sr), f = svf(); let ph = 0;
  for (let i = 0; i < sr * 2.5; i++) {
    const t = i / sr; ph += TAU * (38 + 60 * Math.exp(-t * 12)) / sr;
    add(drums, i0 + i, g * .9 * Math.sin(ph) * Math.exp(-t * 2.2));
    const nz = g * .5 * f(noise(), 500 + 5000 * Math.exp(-t * 3), .5) * Math.exp(-t * 2.5);
    add(drums, i0 + i, nz * .6, Math.sin(i * .001) * .3); add(send, i0 + i, nz);
  }
}
function tick(t0, g = .12) { const i0 = Math.floor(t0 * sr), f = svf(); for (let i = 0; i < sr * .02; i++) { const v = g * f(noise(), 2500 + 1500 * rnd(), .3) * Math.exp(-i / sr * 300); add(drums, i0 + i, v, (rnd() - .5) * .6); add(send, i0 + i, v * .4); } }
function snare(t0, g = .25) { const i0 = Math.floor(t0 * sr), f = svf(); let ph = 0; for (let i = 0; i < sr * .15; i++) { const t = i / sr; ph += TAU * 190 / sr; const x = noise(); add(drums, i0 + i, g * ((x - f(x, 1500)) * Math.exp(-t * 28) + .5 * Math.sin(ph) * Math.exp(-t * 40))); } }

// ── 構成 ──
const CH = [ // Am F C G
  { root: 55.0, tones: [220, 261.63, 329.63, 440], pad: [110, 164.81, 220, 261.63, 329.63], lead: [[0, 659.25], [1.5, 587.33], [2.5, 523.25]] },
  { root: 43.65, tones: [174.61, 220, 261.63, 349.23], pad: [87.31, 174.61, 220, 261.63, 349.23], lead: [[0, 523.25], [1.5, 440], [2.5, 523.25]] },
  { root: 65.41, tones: [196, 261.63, 329.63, 392], pad: [130.81, 196, 261.63, 329.63, 392], lead: [[0, 659.25], [1.5, 783.99], [2.5, 659.25]] },
  { root: 49.0, tones: [196, 246.94, 293.66, 392], pad: [98, 196, 246.94, 293.66, 392], lead: [[0, 587.33], [1.5, 493.88], [2.5, 587.33], [3.5, 659.25]] },
];
const ARP = [0, 1, 2, 3, 2, 1, 2, 3, 0, 1, 2, 3, 2, 1, 3, 2];

// 0–4s: 導入（ドローン、タイプ音、ライザー）
pad(0, 3.6, [55, 82.41, 110], .07, 1.5, .5, 500);
for (let i = 0; i < 19; i++) tick(0.6 + i * 0.09);
pluck(2.75, 659.25, .12, 0, 5, 2500, .9); pluck(2.87, 880, .1, .3, 5, 2500, .9);
riser(2.4, 4.0, .32);
impact(4.0, .9);

// 4–22s: グルーヴ
for (let bar = 0; bar < 9; bar++) {
  const t0 = 4 + bar * 2, c = CH[bar % 4], hi = t0 >= 10, top = t0 >= 16;
  for (let b = 0; b < 4; b++) {
    kick(t0 + b * .5, .95);
    hat(t0 + b * .5 + .25, .22, .035, .25);
    if (hi) { hat(t0 + b * .5 + .125, .1, .015, -.3); hat(t0 + b * .5 + .375, .1, .015, -.3); if (b % 2) clap(t0 + b * .5, .34); }
  }
  for (let e = 0; e < 8; e++) bass(t0 + e * .25, .21, c.root * (e === 7 ? 2 : 1), e % 2 ? .36 : .26);
  for (let s = 0; s < 16; s++) {
    const fr = c.tones[ARP[s]] * (hi && s % 4 === 3 ? 2 : 1);
    pluck(t0 + s * .125, fr, hi ? .15 : .13, (s % 2 ? .45 : -.45), 9, hi ? 4200 : 2200, .55);
  }
  if (hi) pad(t0, 1.9, c.pad, top ? .05 : .04, .15, .3, top ? 2200 : 1400);
  if (top) for (const [b, fr] of c.lead) pluck(t0 + b * .5, fr, .2, 0, 3.2, 5000, .8);
}

// 22–24s: ビルドアップ
pad(22, 1.8, CH[0].pad.map(f => f * 2), .04, .1, .1, 3000);
for (let i = 0; i < 4; i++) snare(22 + i * .25, .2 + i * .02);
for (let i = 0; i < 6; i++) snare(23 + i * .125, .26 + i * .02);
for (let i = 0; i < 4; i++) snare(23.75 + i * .0625, .36);
riser(22, 24, .42);

// 24–30s: 着地
impact(24.0, 1.1); kick(24.0, 1);
pad(24, 4.2, [55, 110, 164.81, 220, 246.94, 261.63, 329.63], .06, .05, 2.2, 2400);
[[24, 659.25], [24.5, 880], [25, 987.77], [25.5, 1318.5], [26.25, 880], [27, 987.77], [27.75, 1318.5], [28.5, 1760]].forEach(([t, f], i) => pluck(t, f, .13 * Math.pow(.86, i), i % 2 ? .5 : -.5, 2.5, 5000, 1));

// ── ミックス ──
// サイドチェイン
const duck = new Float32Array(n).fill(1);
for (const k of kicks) { const i0 = Math.floor(k * sr); for (let i = 0; i < sr * .3 && i0 + i < n; i++) duck[i0 + i] = Math.min(duck[i0 + i], 1 - .6 * Math.exp(-i / sr * 11)); }
// ディレイ（ピンポン）＋簡易リバーブ
const fx = mk();
{
  const dl = Math.floor(.375 * sr), bufL = new Float32Array(dl), bufR = new Float32Array(dl); let p = 0;
  const combs = [1557, 1617, 1491, 1422, 1277, 1356].map((len, k) => ({ b: new Float32Array(len), p: 0, lp: 0, ch: k % 2 }));
  const aps = [225, 556, 441, 341].map((len, k) => ({ b: new Float32Array(len), p: 0, ch: k % 2 }));
  for (let i = 0; i < n; i++) {
    const inL = send[0][i], inR = send[1][i];
    const dL = bufL[p], dR = bufR[p];
    bufL[p] = inL + dR * .42; bufR[p] = inR + dL * .42; p = (p + 1) % dl;
    const x = [inL + dL * .6, inR + dR * .6], out = [0, 0];
    for (const c of combs) { const y = c.b[c.p]; c.lp = y * .75 + c.lp * .25; c.b[c.p] = x[c.ch] * .5 + c.lp * .86; c.p = (c.p + 1) % c.b.length; out[c.ch] += y; }
    for (const a of aps) { const y = a.b[a.p], v = out[a.ch]; a.b[a.p] = v + y * .5; out[a.ch] = y - v * .5; a.p = (a.p + 1) % a.b.length; }
    fx[0][i] = dL * .5 + out[0] * .22; fx[1][i] = dR * .5 + out[1] * .22;
  }
}
const out = mk(); let peak = 0;
for (let i = 0; i < n; i++) {
  const t = i / sr, master = Math.min(1, t / .3) * Math.min(1, Math.max(0, (30.3 - t) / 1.6));
  for (let c = 0; c < 2; c++) {
    const v = Math.tanh((drums[c][i] * .85 + (mus[c][i] + fx[c][i] * .9) * duck[i]) * 1.25) * master;
    out[c][i] = v; peak = Math.max(peak, Math.abs(v));
  }
}
const gain = .93 / peak, pcm = Buffer.alloc(44 + n * 4);
pcm.write('RIFF', 0); pcm.writeUInt32LE(36 + n * 4, 4); pcm.write('WAVEfmt ', 8); pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(2, 22);
pcm.writeUInt32LE(sr, 24); pcm.writeUInt32LE(sr * 4, 28); pcm.writeUInt16LE(4, 32); pcm.writeUInt16LE(16, 34); pcm.write('data', 36); pcm.writeUInt32LE(n * 4, 40);
for (let i = 0; i < n; i++) for (let c = 0; c < 2; c++) pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, out[c][i] * gain)) * 32767), 44 + i * 4 + c * 2);
const dest = process.argv[2] || 'out/bgm.wav';
fs.mkdirSync(new URL('.', new URL(dest, 'file://' + process.cwd() + '/')).pathname, { recursive: true });
fs.writeFileSync(dest, pcm);
console.log('wrote', dest, 'peak', peak.toFixed(3));
