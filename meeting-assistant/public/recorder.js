// 音声トラックを「話の区切り（無音）」ごとに短い音声ファイルに切り出す
// 切り出した音声は onSegment(blob, startedAt) で渡す
export class SegmentRecorder {
  constructor(track, { onSegment, onLevel, minMs = 3000, maxMs = 15000, silenceMs = 700, threshold = 0.015 }) {
    this.stream = new MediaStream([track]);
    this.onSegment = onSegment;
    this.onLevel = onLevel;
    this.opts = { minMs, maxMs, silenceMs, threshold };
    this.mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t)) || '';

    this.ctx = new AudioContext();
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    source.connect(this.analyser);
    this.buf = new Float32Array(this.analyser.fftSize);
  }

  start() {
    this.running = true;
    this.paused = false;
    this.#startSegment();
    this.timer = setInterval(() => this.#tick(), 100);
  }

  setPaused(paused) {
    this.paused = paused;
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    this.#finishSegment();
    this.ctx.close();
  }

  #level() {
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (const v of this.buf) sum += v * v;
    return Math.sqrt(sum / this.buf.length);
  }

  #tick() {
    const level = this.paused ? 0 : this.#level();
    this.onLevel?.(level);
    const now = Date.now();
    const seg = this.seg;
    if (!seg) return;
    if (level > this.opts.threshold) {
      seg.voiced = true;
      seg.lastVoice = now;
    }
    const age = now - seg.startedAt;
    const silentFor = now - seg.lastVoice;
    const cutOnPause = age >= this.opts.minMs && seg.voiced && silentFor >= this.opts.silenceMs;
    if (cutOnPause || age >= this.opts.maxMs) {
      // 途切れを減らすため、次の録音を先に始めてから今の録音を止める
      const prev = this.seg;
      this.#startSegment();
      this.#finishSegment(prev);
    }
  }

  #startSegment() {
    const recorder = new MediaRecorder(this.stream, this.mimeType ? { mimeType: this.mimeType } : undefined);
    const seg = { recorder, chunks: [], startedAt: Date.now(), lastVoice: Date.now(), voiced: false };
    recorder.ondataavailable = (e) => e.data.size && seg.chunks.push(e.data);
    recorder.onstop = () => {
      // 声が入っていない区間や一時停止中の区間は送らない（費用の節約と誤認識の防止）
      if (!seg.voiced || seg.paused) return;
      this.onSegment(new Blob(seg.chunks, { type: recorder.mimeType }), seg.startedAt);
    };
    recorder.start();
    this.seg = seg;
  }

  #finishSegment(seg = this.seg) {
    if (!seg || seg.recorder.state === 'inactive') return;
    seg.paused = this.paused;
    seg.recorder.stop();
    if (seg === this.seg) this.seg = null;
  }
}
