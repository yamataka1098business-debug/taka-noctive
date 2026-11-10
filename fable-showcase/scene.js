// 30秒ショーケース。すべての絵は時刻 t の関数として決定的に描画する（素材ファイルなし）。
const W = 1920, H = 1080, DUR = 30;
const cv = document.getElementById('c');
const ctx = cv.getContext('2d');

const sat = x => Math.max(0, Math.min(1, x));
const lerp = (a, b, k) => a + (b - a) * k;
const smooth = (a, b, x) => { const k = sat((x - a) / (b - a)); return k * k * (3 - 2 * k); };
const easeOut = k => 1 - Math.pow(1 - k, 3);
const easeInOut = k => k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
const easeOutExpo = k => k >= 1 ? 1 : 1 - Math.pow(2, -10 * k);
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

const JP = '"Noto Sans JP"';
const MONO = '"JetBrains Mono","Noto Sans JP"';
const CUTS = [4, 10, 16, 24];

// ───────────────────────── 背景シェーダ（WebGL） ─────────────────────────
const glc = document.createElement('canvas'); glc.width = 960; glc.height = 540;
const gl = glc.getContext('webgl', { preserveDrawingBuffer: true, antialias: false });
const FRAG = `
precision highp float;
uniform vec2 R; uniform float T; uniform float M; uniform float K;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
float fbm(vec2 p){float a=.5,s=0.;for(int i=0;i<5;i++){s+=a*noise(p);p=p*2.03+vec2(1.7,9.2);a*=.5;}return s;}
vec3 nebula(vec2 uv){
  vec2 q=uv*1.5; float t=T*.07;
  vec2 w=vec2(fbm(q+vec2(t,-t)),fbm(q+vec2(5.2-t,1.3+t)));
  float n=fbm(q+2.6*w);
  vec3 c=mix(vec3(.012,.010,.028),vec3(.30,.10,.05),smoothstep(.38,.85,n));
  c=mix(c,vec3(.09,.06,.30),smoothstep(.45,.95,w.x)*.75);
  c*=1.-.5*dot(uv,uv);
  return max(c,0.)*.8;
}
vec2 path(float z){return vec2(sin(z*.35)*.9,cos(z*.27)*.7);}
float map(vec3 p){
  vec3 q=p*1.6;
  float g=(abs(dot(sin(q),cos(q.zxy)))-.10)/1.6;
  float tun=length(p.xy-path(p.z))-.5;
  return max(g*.7,-tun);
}
vec3 gyro(vec2 uv){
  float z=T*1.5;
  vec3 ro=vec3(path(z),z), ta=vec3(path(z+1.6),z+1.6);
  vec3 f=normalize(ta-ro), r=normalize(cross(vec3(0,1,0),f)), u=cross(f,r);
  float a=sin(T*.45)*.6; uv=mat2(cos(a),-sin(a),sin(a),cos(a))*uv;
  vec3 rd=normalize(f+uv.x*r*1.1+uv.y*u*1.1);
  float t=0.; vec3 col=vec3(0);
  for(int i=0;i<72;i++){
    vec3 p=ro+rd*t; float d=abs(map(p));
    vec3 pal=mix(vec3(1.,.42,.16),vec3(.40,.30,1.),.5+.5*sin(p.z*.55+T*.4));
    pal=mix(pal,vec3(.2,.9,1.),.25*(.5+.5*sin(p.x*2.+p.y*2.+T)));
    col+=pal*.010/(.012+d)*exp(-t*.22);
    t+=max(d*.8,.025);
    if(t>13.)break;
  }
  col*=(.55+.35*K);
  col=1.-exp(-col*.30);col=pow(col,vec3(1.25));
  col*=1.-.35*dot(uv,uv);
  return col;
}
void main(){
  vec2 uv=(gl_FragCoord.xy-.5*R)/R.y;
  vec3 c;
  if(M<.001) c=nebula(uv);
  else if(M>.999) c=gyro(uv);
  else c=mix(nebula(uv),gyro(uv),M);
  gl_FragColor=vec4(c,1.);
}`;
function sh(type, src) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; }
const prog = gl.createProgram();
gl.attachShader(prog, sh(gl.VERTEX_SHADER, 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}'));
gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
gl.linkProgram(prog); gl.useProgram(prog);
gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
const uR = gl.getUniformLocation(prog, 'R'), uT = gl.getUniformLocation(prog, 'T'), uM = gl.getUniformLocation(prog, 'M'), uK = gl.getUniformLocation(prog, 'K');

// ───────────────────────── テキスト配置（表示と粒子サンプリングで共用） ─────────────────────────
const PROMPT = '> 最強さを見せつける動画、作ってみて';
const PROMPT_FONT = `500 62px ${MONO}`;
const PROMPT_Y = H * 0.47;
const TYPE_T0 = 0.6, TYPE_DT = 0.09;
function promptX(c) { c.font = PROMPT_FONT; return (W - c.measureText(PROMPT).width) / 2; }
function drawPrompt(c, n) {
  c.font = PROMPT_FONT; c.textBaseline = 'middle'; c.textAlign = 'left';
  c.fillText(PROMPT.slice(0, n), promptX(c), PROMPT_Y);
}
const MARK = 'Fable 5.2';
const MARK_FONT = `900 300px ${JP}`;
const MARK_Y = H * 0.41;
function drawMark(c) {
  c.font = MARK_FONT; c.textBaseline = 'middle'; c.textAlign = 'center';
  c.fillText(MARK, W / 2, MARK_Y);
}

// ───────────────────────── 粒子 ─────────────────────────
const N = 16000, FOCAL = 1100;
const seed = new Float32Array(N * 4);
let P = {};
function sampleShape(drawFn, rnd) {
  const o = document.createElement('canvas'); o.width = W; o.height = H;
  const c = o.getContext('2d', { willReadFrequently: true });
  c.fillStyle = '#fff'; drawFn(c);
  const d = c.getImageData(0, 0, W, H).data, pts = [];
  for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) if (d[(y * W + x) * 4 + 3] > 128) pts.push(x, y);
  const out = new Float32Array(N * 3), m = pts.length / 2;
  for (let i = 0; i < N; i++) {
    const j = (rnd() * m) | 0;
    out[i * 3] = pts[j * 2] - W / 2 + rnd() * 2; out[i * 3 + 1] = pts[j * 2 + 1] - H / 2 + rnd() * 2; out[i * 3 + 2] = (rnd() - .5) * 8;
  }
  return out;
}
function buildShapes() {
  const rnd = mulberry32(20261110);
  for (let i = 0; i < N * 4; i++) seed[i] = rnd();
  P.A = sampleShape(c => drawPrompt(c, PROMPT.length), rnd);
  P.B = sampleShape(drawMark, rnd);
  const S = new Float32Array(N * 3), Kn = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    // 球（フィボナッチ格子）
    const y = 1 - 2 * (i + .5) / N, r = Math.sqrt(1 - y * y), th = i * 2.399963;
    const rad = 300 * (rnd() < .12 ? .55 + rnd() * .4 : 1);
    S[i * 3] = Math.cos(th) * r * rad; S[i * 3 + 1] = y * rad; S[i * 3 + 2] = Math.sin(th) * r * rad;
    // トーラス結び目 (2,3)
    const u = rnd() * Math.PI * 2, tr = 40 * Math.sqrt(rnd()), ta = rnd() * Math.PI * 2;
    const cr = 250 + 105 * Math.cos(3 * u);
    Kn[i * 3] = cr * Math.cos(2 * u) + tr * Math.cos(ta);
    Kn[i * 3 + 1] = cr * Math.sin(2 * u) + tr * Math.sin(ta);
    Kn[i * 3 + 2] = 105 * Math.sin(3 * u) * 1.6 + tr * Math.cos(ta * 1.7);
  }
  P.S = S; P.K = Kn;
}
// [形, 到着時刻, 出発時刻]
const KEYS = [['A', 0, 3.5], ['S', 5.3, 9.0], ['K', 10.6, 15.0], ['D', 16.4, 22.6], ['B', 24.4, 99]];
const PAL = {
  A: [[1, 1, 1], [1, .85, .7]],
  S: [[1, .45, .22], [1, .86, .6]],
  K: [[.25, .8, 1], [.62, .38, 1]],
  D: [[1, .72, .45], [.75, .8, 1]],
  B: [[1, .55, .3], [1, .95, .85]],
};
const beatPulse = t => (t >= 4 && t < 22) ? Math.exp(-7 * ((t * 2) % 1)) : 0;
const tmp = [0, 0, 0];
function shapePos(id, i, t, o) {
  const s0 = seed[i * 4], s1 = seed[i * 4 + 1], s2 = seed[i * 4 + 2];
  if (id === 'D') {
    o[0] = (s0 - .5) * 3400; o[1] = (s1 - .5) * 2000;
    o[2] = ((((s2 * 3000 - t * 520) % 3000) + 3000) % 3000) - 950;
    return;
  }
  const a = P[id]; let x = a[i * 3], y = a[i * 3 + 1], z = a[i * 3 + 2];
  if (id === 'A' || id === 'B') {
    if (id === 'B') { x += 3 * Math.sin(t * 2.3 + s0 * 40); y += 3 * Math.cos(t * 1.9 + s1 * 40); }
    o[0] = x; o[1] = y; o[2] = z; return;
  }
  let ry, rx, sc = 1 + .07 * beatPulse(t);
  if (id === 'S') {
    sc *= 1 + .2 * Math.sin(x * .011 + t * 1.8) * Math.sin(y * .013 - t * 1.3) * Math.sin(z * .012 + t);
    ry = t * .55; rx = .35 * Math.sin(t * .5);
  } else { ry = t * .75; rx = t * .33; }
  x *= sc; y *= sc; z *= sc;
  let c = Math.cos(ry), s = Math.sin(ry); const x1 = x * c + z * s, z1 = -x * s + z * c;
  c = Math.cos(rx); s = Math.sin(rx);
  o[0] = x1; o[1] = y * c - z1 * s; o[2] = y * s + z1 * c;
}
const pc = document.createElement('canvas'); pc.width = W; pc.height = H;
const pctx = pc.getContext('2d');
const BINS = 6;
function drawParticles(t) {
  if (t < 3.3) return;
  let k = KEYS.length - 1; for (let j = 0; j < KEYS.length - 1; j++) if (t < KEYS[j + 1][1]) { k = j; break; }
  const cur = KEYS[k], nxt = KEYS[k + 1];
  const moving = nxt && t > cur[2];
  const kk = moving ? (t - cur[2]) / (nxt[1] - cur[2]) : 0;
  const pa = PAL[cur[0]], pb = moving ? PAL[nxt[0]] : pa, ck = smooth(0, 1, kk);
  let alpha = smooth(3.3, 3.7, t) * (1 - smooth(29.2, 29.9, t));
  const dustW = cur[0] === 'D' ? (moving ? 1 - ck : 1) : (moving && nxt[0] === 'D' ? ck : 0);
  alpha *= 1 - .35 * dustW;
  if (t > 24.4) alpha *= lerp(1, .6, smooth(24.6, 25.6, t));
  const xs = [], a = [0, 0, 0], b = [0, 0, 0];
  for (let q = 0; q < BINS; q++) xs.push([]);
  for (let i = 0; i < N; i++) {
    const s0 = seed[i * 4], s1 = seed[i * 4 + 1], s2 = seed[i * 4 + 2], s3 = seed[i * 4 + 3];
    shapePos(cur[0], i, t, a);
    let x = a[0], y = a[1], z = a[2];
    if (moving) {
      shapePos(nxt[0], i, t, b);
      const e = easeInOut(sat(kk * 1.45 - s3 * .45)), turb = Math.sin(Math.PI * e) * 260;
      x = lerp(x, b[0], e) + turb * Math.sin(s0 * 50 + t * 2.1 + y * .004);
      y = lerp(y, b[1], e) + turb * Math.sin(s1 * 50 + t * 1.7 + x * .004);
      z = lerp(z, b[2], e) + turb * Math.cos(s2 * 50 + t * 1.3);
    }
    const w = FOCAL + z; if (w < 60) continue;
    const p = FOCAL / w, sx = W / 2 + x * p, sy = H / 2 + y * p;
    if (sx < -10 || sx > W + 10 || sy < -10 || sy > H + 10) continue;
    const sz = Math.min(7, Math.max(.9, (1.1 + s3 * 1.3) * p));
    xs[(s1 * BINS) | 0].push(sx, sy, sz);
  }
  pctx.clearRect(0, 0, W, H);
  for (let q = 0; q < BINS; q++) {
    const m = q / (BINS - 1), col = [0, 1, 2].map(j => Math.round(255 * lerp(lerp(pa[0][j], pa[1][j], m), lerp(pb[0][j], pb[1][j], m), ck)));
    pctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},0.85)`;
    const v = xs[q];
    for (let j = 0; j < v.length; j += 3) pctx.fillRect(v[j] - v[j + 2] / 2, v[j + 1] - v[j + 2] / 2, v[j + 2], v[j + 2]);
  }
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = alpha * .9; ctx.filter = 'blur(14px)'; ctx.drawImage(pc, 0, 0);
  ctx.filter = 'none'; ctx.globalAlpha = alpha; ctx.drawImage(pc, 0, 0);
  ctx.restore();
}

// ───────────────────────── テロップ ─────────────────────────
function caption(text, t, t0, t1, o = {}) {
  if (t < t0 || t > t1) return;
  const size = o.size || 104, y = o.y || H * .8, weight = o.weight || 900, track = (o.track ?? .06) * size;
  ctx.save();
  ctx.font = `${weight} ${size}px ${JP}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  const chars = [...text], ws = chars.map(c => ctx.measureText(c).width);
  const total = ws.reduce((s, w) => s + w, 0) + track * (chars.length - 1);
  const out = sat((t1 - t) / .35), inn = sat((t - t0) / .3);
  if (o.plate !== false) {
    const g = ctx.createRadialGradient(W / 2, y, 0, W / 2, y, total * .75);
    g.addColorStop(0, `rgba(0,0,0,${.62 * inn * out})`); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.save(); ctx.translate(W / 2, y); ctx.scale(1, .32); ctx.translate(-W / 2, -y);
    ctx.fillRect(0, y - total, W, total * 2); ctx.restore();
  }
  let x = (W - total) / 2;
  ctx.shadowColor = o.glow || 'rgba(0,0,0,.85)'; ctx.shadowBlur = o.glowBlur || 26;
  ctx.fillStyle = o.color || '#fff';
  chars.forEach((ch, j) => {
    const e = easeOut(sat((t - t0 - j * .045) / .42));
    ctx.globalAlpha = e * out * (o.alpha ?? 1);
    ctx.fillText(ch, x + (1 - out) * (j - chars.length / 2) * 6, y + (1 - e) * 54);
    x += ws[j] + track;
  });
  ctx.restore();
}

const CODE = [
  'const N = 16000, FOCAL = 1100;', 'for (let i = 0; i < N; i++) {', '  shapePos(cur, i, t, a);', '  const e = easeInOut(k - s3 * .45);',
  '  x = lerp(x, b[0], e) + turb * sin(t);', '  const p = FOCAL / (FOCAL + z);', '  ctx.fillRect(sx, sy, sz, sz);', '}',
  'float g = abs(dot(sin(q), cos(q.zxy)));', 'col += pal * .010 / (.012 + d);', 't += max(d * .8, .025);', 'gl_FragColor = vec4(c, 1.);',
  'kick(t, 0.9); hat(t + .25, .3);', 'pluck(t, chord[i % 4], .22, pan);', 'low += f * band; band += f * high;', 'out[i] = Math.tanh(mix * 1.4);',
  'const cr = 250 + 105 * cos(3 * u);', 'Kn[i*3] = cr * cos(2 * u) + tr;', 'renderFrame(frame / 30);', 'await page.screenshot({ path });',
  'ffmpeg -i frames/%05d.jpg -i bgm.wav', 'caption("あるのは、コードだけ。")', 'if (t > 24.4) alpha *= .6;', 'return 1 - Math.pow(2, -10 * k);',
];
function drawCode(t) {
  const a = smooth(10.2, 11, t) * (1 - smooth(15, 15.8, t)); if (a <= 0) return;
  ctx.save(); ctx.font = `500 23px ${MONO}`; ctx.textBaseline = 'middle';
  const span = CODE.length * 38;
  for (let col = 0; col < 2; col++) for (let j = 0; j < CODE.length; j++) {
    const dir = col ? -1 : 1;
    let y = (((j * 38 + dir * (t - 10) * 70 + col * 300) % span) + span) % span - 60;
    if (y > H + 40) continue;
    const edge = Math.min(sat(y / 220), sat((H - y) / 220));
    const hot = Math.pow(.5 + .5 * Math.sin(j * 1.7 + t * 3 + col), 6);
    ctx.globalAlpha = a * edge * (.2 + .5 * hot);
    ctx.fillStyle = col ? '#b79bff' : '#7fd6ff';
    ctx.textAlign = col ? 'right' : 'left';
    ctx.fillText(CODE[(j + col * 7) % CODE.length], col ? W - 70 : 70, y);
  }
  ctx.restore();
}

function drawIntro(t) {
  if (t > 4.1) return;
  const fade = 1 - smooth(3.35, 3.75, t);
  const n = Math.max(0, Math.min(PROMPT.length, Math.floor((t - TYPE_T0) / TYPE_DT) + 1));
  ctx.save();
  ctx.fillStyle = '#fff'; ctx.globalAlpha = fade * smooth(.2, .6, t);
  ctx.shadowColor = 'rgba(255,170,110,.55)'; ctx.shadowBlur = 22;
  drawPrompt(ctx, t < TYPE_T0 ? 1 : n);
  // カーソル
  const tw = ctx.measureText(PROMPT.slice(0, t < TYPE_T0 ? 1 : n)).width;
  const typing = t > TYPE_T0 && n < PROMPT.length;
  if (typing || Math.floor(t * 2.5) % 2 === 0) { ctx.fillStyle = '#ff8a4c'; ctx.fillRect(promptX(ctx) + tw + 8, PROMPT_Y - 36, 30, 68); }
  ctx.restore();
  caption('了解。', t, 2.75, 3.7, { y: H * .6, size: 60, color: '#ff9a62', plate: false, track: .1 });
}

function drawFinale(t) {
  if (t < 24.3) return;
  const a = smooth(24.5, 25.3, t);
  ctx.save();
  const g = ctx.createLinearGradient(0, MARK_Y - 150, 0, MARK_Y + 150);
  g.addColorStop(0, '#fff7ee'); g.addColorStop(1, '#ff9a5c');
  ctx.globalAlpha = a; ctx.fillStyle = g;
  ctx.shadowColor = 'rgba(255,120,50,.75)'; ctx.shadowBlur = 60;
  drawMark(ctx);
  ctx.shadowBlur = 0;
  const bw = 720 * easeOutExpo(sat((t - 25.0) / .9));
  ctx.fillStyle = '#ff8a4c'; ctx.fillRect(W / 2 - bw / 2, MARK_Y + 190, bw, 6);
  ctx.restore();
  caption('CLAUDE', t, 25.1, 31, { y: MARK_Y - 215, size: 34, weight: 500, track: .9, color: 'rgba(255,225,205,.9)', plate: false });
  caption('この30秒をつくったのは、AIひとり。', t, 25.7, 31, { y: H * .7, size: 68, plate: false, glow: 'rgba(0,0,0,.9)' });
  caption('映像・音・構成　すべてコードから生成　｜　素材 0　編集ソフト 0', t, 26.9, 31, { y: H * .82, size: 30, weight: 500, track: .12, color: 'rgba(255,255,255,.72)', plate: false });
}

// ───────────────────────── 1フレーム描画 ─────────────────────────
window.renderFrame = function (t) {
  // 背景
  const M = smooth(15.5, 16.3, t) * (1 - smooth(23.3, 24.3, t));
  gl.viewport(0, 0, glc.width, glc.height);
  gl.uniform2f(uR, glc.width, glc.height); gl.uniform1f(uT, t); gl.uniform1f(uM, M); gl.uniform1f(uK, beatPulse(t));
  gl.drawArrays(gl.TRIANGLES, 0, 3); gl.finish();

  let punch = 0, flash = 0;
  for (const c of CUTS) if (t >= c) { punch = Math.max(punch, Math.exp(-(t - c) * 5)); flash = Math.max(flash, Math.exp(-(t - c) * 7)); }
  const z = 1 + .06 * punch + .012 * beatPulse(t);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  ctx.setTransform(z, 0, 0, z, W / 2 * (1 - z), H / 2 * (1 - z));
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.globalAlpha = smooth(0, 1.2, t) * (t < 16 ? lerp(.75, 1, smooth(3.6, 4.2, t)) : 1);
  ctx.drawImage(glc, 0, 0, W, H);
  ctx.globalAlpha = 1;

  drawCode(t);
  drawParticles(t);
  drawIntro(t);
  caption('素材、ゼロ。', t, 4.5, 6.9, { y: H * .83 });
  caption('編集ソフトも、ゼロ。', t, 7.1, 9.7, { y: H * .83 });
  caption('あるのは、コードだけ。', t, 10.6, 15.4, { y: H * .86 });
  caption('形も。', t, 16.4, 18.0, { y: H * .5, size: 150 });
  caption('光も。', t, 18.2, 19.8, { y: H * .5, size: 150 });
  caption('音も。', t, 20.0, 21.6, { y: H * .5, size: 150 });
  caption('ぜんぶ、数式から。', t, 21.9, 23.7, { y: H * .5, size: 130 });
  drawFinale(t);

  // 仕上げ：ビネット・フラッシュ・フェードアウト
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const vg = ctx.createRadialGradient(W / 2, H / 2, H * .45, W / 2, H / 2, H * 1.05);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.6)');
  ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
  if (flash > .01) { ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = `rgba(255,235,215,${flash * .7})`; ctx.fillRect(0, 0, W, H); ctx.globalCompositeOperation = 'source-over'; }
  const fo = smooth(29.3, 29.95, t);
  if (fo > 0) { ctx.fillStyle = `rgba(0,0,0,${fo})`; ctx.fillRect(0, 0, W, H); }
};

window.ready = (async () => {
  const all = PROMPT + MARK + CODE.join('') + '了解。素材、ゼロ編集ソフトもあるのはコードだけ形光音ぜんぶ数式からCLAUDEこの30秒をつくったAIひとり映像・構成──すべて生成｜　0';
  await Promise.all([document.fonts.load(`900 100px ${JP}`, all), document.fonts.load(`500 100px ${JP}`, all), document.fonts.load('500 60px "JetBrains Mono"', all)]);
  await document.fonts.ready;
  buildShapes();
  return true;
})();
