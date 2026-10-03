/**
 * Mic capture for the Gemini voice relay: the context's float audio → mono PCM16 at 16 kHz,
 * posted to the main thread in ~40 ms chunks (ArrayBuffer, transferred). Resampling is linear
 * (speech over a phone mic; the context runs at 44.1/48 kHz, Gemini wants 16 kHz).
 */
class Pcm16Capture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.target = (options.processorOptions && options.processorOptions.targetRate) || 16000;
    this.step = sampleRate / this.target;
    this.pos = 0; // fractional read position into the current input block (carried across blocks)
    this.last = 0; // last input sample of the previous block, for interpolation at the seam
    this.size = Math.round(this.target * 0.04); // kept apart: a transferred buffer is detached (length 0)
    this.chunk = new Int16Array(this.size);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    let pos = this.pos;
    while (pos < ch.length) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const a = i < 0 ? this.last : ch[i];
      const b = i + 1 < ch.length ? ch[i + 1] : ch[ch.length - 1];
      const v = a + (b - a) * frac;
      this.chunk[this.n++] = v < 0 ? Math.max(-1, v) * 0x8000 : Math.min(1, v) * 0x7fff;
      if (this.n === this.size) {
        this.port.postMessage(this.chunk.buffer, [this.chunk.buffer]);
        this.chunk = new Int16Array(this.size);
        this.n = 0;
      }
      pos += this.step;
    }
    this.pos = pos - ch.length;
    this.last = ch[ch.length - 1];
    return true;
  }
}

registerProcessor("pcm16-capture", Pcm16Capture);
