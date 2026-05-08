/**
 * audio-worker.js
 *
 * Receives decoded PCM data from the main thread and pre-computes frequency
 * magnitude snapshots for every 50 ms using a Cooley-Tukey FFT + Hann window.
 * Results are packed into a single transferable Float32Array.
 *
 * Message in  : { channelData: Float32Array, sampleRate: number }
 * Messages out:
 *   { type: 'progress', processed: number }   – 0..1 during computation
 *   { type: 'complete', packed, totalSnapshots, sampleRate, chunkInterval }
 *   { type: 'error',   message: string }
 */

// ─── Cooley-Tukey in-place FFT (power-of-two length) ────────────────────────
function fft(real, imag) {
  const n = real.length;

  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let tmp = real[i]; real[i] = real[j]; real[j] = tmp;
      tmp = imag[i]; imag[i] = imag[j]; imag[j] = tmp;
    }
  }

  // Butterfly passes
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang  = (Math.PI * 2) / len;
    const wBR  = Math.cos(ang);
    const wBI  = -Math.sin(ang);

    for (let i = 0; i < n; i += len) {
      let wR = 1, wI = 0;
      for (let j = 0; j < half; j++) {
        const uR = real[i + j];
        const uI = imag[i + j];
        const vR = real[i + j + half] * wR - imag[i + j + half] * wI;
        const vI = real[i + j + half] * wI + imag[i + j + half] * wR;

        real[i + j]        = uR + vR;
        imag[i + j]        = uI + vI;
        real[i + j + half] = uR - vR;
        imag[i + j + half] = uI - vI;

        const nextWR = wR * wBR - wI * wBI;
        wI = wR * wBI + wI * wBR;
        wR = nextWR;
      }
    }
  }
}

// ─── Main handler ────────────────────────────────────────────────────────────
self.onmessage = ({ data }) => {
  const { pcmBuffer, sampleRate } = data;
  const channelData = new Float32Array(pcmBuffer);

  try {
    const FFT_SIZE       = 256;
    const NUM_BINS       = FFT_SIZE / 2;                  // 128 frequency bins
    const CHUNK_STEP     = Math.round(sampleRate * 0.05); // samples per 50 ms
    const totalSnapshots = Math.ceil(channelData.length / CHUNK_STEP);
    const packed         = new Float32Array(totalSnapshots * NUM_BINS);

    const real = new Float64Array(FFT_SIZE);
    const imag = new Float64Array(FFT_SIZE);

    for (let snap = 0; snap < totalSnapshots; snap++) {
      const offset = snap * CHUNK_STEP;

      // Windowed samples → real[], zeros → imag[]
      for (let i = 0; i < FFT_SIZE; i++) {
        const s = (offset + i < channelData.length) ? channelData[offset + i] : 0;
        const w = 0.5 * (1 - Math.cos((Math.PI * 2 * i) / (FFT_SIZE - 1))); // Hann
        real[i] = s * w;
        imag[i] = 0;
      }

      fft(real, imag);

      // Normalised magnitude → packed
      const base = snap * NUM_BINS;
      for (let i = 0; i < NUM_BINS; i++) {
        packed[base + i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]) / FFT_SIZE;
      }

      if (snap % 200 === 0) {
        self.postMessage({ type: 'progress', processed: snap / totalSnapshots });
      }
    }

    self.postMessage(
      { type: 'complete', packed, totalSnapshots, sampleRate, chunkInterval: 0.05 },
      [packed.buffer]
    );
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};
