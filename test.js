/**
 * test.js — run with: node test.js
 *
 * Tests the core DSP logic (FFT + snapshot pipeline) that lives in
 * audio-worker.js without needing a browser or audio file.
 */

// ─── FFT (copied from audio-worker.js) ───────────────────────────────────────
function fft(real, imag) {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let tmp = real[i]; real[i] = real[j]; real[j] = tmp;
      tmp = imag[i]; imag[i] = imag[j]; imag[j] = tmp;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang  = (Math.PI * 2) / len;
    const wBR  = Math.cos(ang);
    const wBI  = -Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wR = 1, wI = 0;
      for (let j = 0; j < half; j++) {
        const uR = real[i + j],      uI = imag[i + j];
        const vR = real[i + j + half] * wR - imag[i + j + half] * wI;
        const vI = real[i + j + half] * wI + imag[i + j + half] * wR;
        real[i + j]        = uR + vR;  imag[i + j]        = uI + vI;
        real[i + j + half] = uR - vR;  imag[i + j + half] = uI - vI;
        const nwR = wR * wBR - wI * wBI;
        wI = wR * wBI + wI * wBR;
        wR = nwR;
      }
    }
  }
}

// ─── Helper: windowed FFT magnitude spectrum ──────────────────────────────────
function magnitudes(samples) {
  const N    = samples.length;
  const BINS = N / 2;
  const real = new Float64Array(N);
  const imag = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const w  = 0.5 * (1 - Math.cos((Math.PI * 2 * i) / (N - 1))); // Hann
    real[i]  = samples[i] * w;
    imag[i]  = 0;
  }
  fft(real, imag);
  const out = new Float32Array(BINS);
  for (let i = 0; i < BINS; i++)
    out[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]) / N;
  return out;
}

// ─── Snapshot pipeline (mirrors audio-worker.js) ──────────────────────────────
function computeSnapshots(channelData, sampleRate) {
  const FFT_SIZE       = 256;
  const NUM_BINS       = FFT_SIZE / 2;
  const CHUNK_STEP     = Math.round(sampleRate * 0.05);
  const totalSnapshots = Math.ceil(channelData.length / CHUNK_STEP);
  const packed         = new Float32Array(totalSnapshots * NUM_BINS);
  const real = new Float64Array(FFT_SIZE);
  const imag = new Float64Array(FFT_SIZE);

  for (let snap = 0; snap < totalSnapshots; snap++) {
    const offset = snap * CHUNK_STEP;
    for (let i = 0; i < FFT_SIZE; i++) {
      const s  = (offset + i < channelData.length) ? channelData[offset + i] : 0;
      const w  = 0.5 * (1 - Math.cos((Math.PI * 2 * i) / (FFT_SIZE - 1)));
      real[i]  = s * w;
      imag[i]  = 0;
    }
    fft(real, imag);
    const base = snap * NUM_BINS;
    for (let i = 0; i < NUM_BINS; i++)
      packed[base + i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]) / FFT_SIZE;
  }
  return { packed, totalSnapshots, NUM_BINS, CHUNK_STEP };
}

// ─── Micro test runner ────────────────────────────────────────────────────────
let passed = 0, failed = 0;

function assert(cond, msg) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${msg}`); passed++; }
  else       { console.error(`  \x1b[31m✗\x1b[0m ${msg}`); failed++; }
}

function suite(name, fn) {
  console.log(`\n\x1b[1m${name}\x1b[0m`);
  fn();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

suite('FFT — DC signal (all 1s)', () => {
  // With a Hann window, a DC signal produces energy at bins 0 and 1
  // because the window itself is: 0.5 − 0.5·cos(2πi/N), introducing a ±1 bin
  // spectral spread. Bin 0 must still be the dominant peak.
  const N    = 256;
  const mags = magnitudes(new Float64Array(N).fill(1.0));
  const peak = mags.indexOf(Math.max(...mags));
  assert(peak === 0,           `Peak at bin 0 (got ${peak})`);
  assert(mags[0] > mags[1],   `Bin 0 dominates bin 1 (${mags[0].toFixed(4)} > ${mags[1].toFixed(4)})`);
  assert(mags[0] > 0,         `DC magnitude positive (${mags[0].toFixed(5)})`);
  assert(mags[2] < 0.01,      `Bin 2 near zero, leakage stops at bin 1 (${mags[2].toFixed(5)})`);
});

suite('FFT — pure sine at bin 16', () => {
  const N = 256, k = 16;
  const s = new Float64Array(N);
  for (let i = 0; i < N; i++) s[i] = Math.sin((2 * Math.PI * k * i) / N);
  const mags = magnitudes(s);
  const peak = mags.indexOf(Math.max(...mags));
  assert(peak === k,          `Peak at bin ${k} (got ${peak})`);
  assert(mags[k] > 0.1,      `Magnitude significant (${mags[k].toFixed(4)})`);
  assert(mags[0]  < mags[k], `Bin 0 < peak`);
  assert(mags[32] < mags[k], `Bin 32 < peak`);
});

suite('FFT — silence (all zeros)', () => {
  const mags   = magnitudes(new Float64Array(256).fill(0));
  const maxMag = Math.max(...mags);
  assert(maxMag < 1e-10, `All bins ≈ 0 for silence (max=${maxMag.toExponential(2)})`);
});

suite('FFT — two sines at bins 8 and 32', () => {
  const N = 256;
  const s = new Float64Array(N);
  for (let i = 0; i < N; i++)
    s[i] = 0.5 * Math.sin((2 * Math.PI * 8  * i) / N)
         + 0.5 * Math.sin((2 * Math.PI * 32 * i) / N);
  const mags = magnitudes(s);
  assert(mags[8]  > mags[7]  && mags[8]  > mags[9],  `Local peak at bin 8  (${mags[8].toFixed(4)})`);
  assert(mags[32] > mags[31] && mags[32] > mags[33], `Local peak at bin 32 (${mags[32].toFixed(4)})`);
});

suite('FFT — full-amplitude signal stays normalised', () => {
  const N = 256;
  const s = new Float64Array(N);
  for (let i = 0; i < N; i++) s[i] = Math.sin((2 * Math.PI * 4 * i) / N);
  const mags = magnitudes(s);
  assert(Math.max(...mags) <= 1.0, `Max magnitude ≤ 1.0 (${Math.max(...mags).toFixed(4)})`);
});

suite('Snapshot pipeline — chunk count at 44100 Hz', () => {
  const SR   = 44100;
  const data = new Float32Array(SR * 1); // 1 second of audio
  const { totalSnapshots, CHUNK_STEP } = computeSnapshots(data, SR);
  assert(totalSnapshots === 20,   `20 snapshots per second (got ${totalSnapshots})`);
  assert(CHUNK_STEP     === 2205, `Chunk step = 2205 samples (got ${CHUNK_STEP})`);
});

suite('Snapshot pipeline — packed buffer size', () => {
  const SR   = 44100;
  const secs = 2;
  const data = new Float32Array(SR * secs);
  const { packed, totalSnapshots, NUM_BINS } = computeSnapshots(data, SR);
  assert(packed.length === totalSnapshots * NUM_BINS,
    `Packed length = ${totalSnapshots} × ${NUM_BINS} = ${packed.length}`);
  assert(NUM_BINS === 128, `NUM_BINS = 128`);
});

suite('Snapshot pipeline — sine wave has non-zero energy', () => {
  const SR   = 44100;
  const data = new Float32Array(SR * 0.5); // 500 ms
  for (let i = 0; i < data.length; i++)
    data[i] = Math.sin((2 * Math.PI * 440 * i) / SR); // 440 Hz tone
  const { packed, totalSnapshots, NUM_BINS } = computeSnapshots(data, SR);
  let anyNonZero = false;
  for (let i = 0; i < totalSnapshots * NUM_BINS; i++)
    if (packed[i] > 1e-6) { anyNonZero = true; break; }
  assert(anyNonZero, 'At least one bin has energy > 1e-6 for a 440 Hz tone');
});

suite('Snapshot pipeline — pcmBuffer round-trip (simulates worker transfer)', () => {
  // Simulate: main thread creates Float32Array → sends .buffer → worker wraps it
  const original   = new Float32Array([0.1, -0.2, 0.3, -0.4, 0.5]);
  const pcmBuffer  = original.slice().buffer;          // detached copy (like transfer)
  const received   = new Float32Array(pcmBuffer);      // worker side reconstruction
  assert(received.length === original.length,          `Length preserved (${received.length})`);
  assert(Math.abs(received[2] - 0.3) < 1e-6,          `Values preserved (received[2]=${received[2]})`);
  assert(received[0] !== undefined,                    `First element accessible`);
});

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(44)}`);
const color = failed > 0 ? '\x1b[31m' : '\x1b[32m';
console.log(`${color}Results: ${passed} passed, ${failed} failed\x1b[0m\n`);
if (failed > 0) process.exit(1);
