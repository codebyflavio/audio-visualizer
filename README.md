# Audio Visualizer

A real-time 3D audio visualizer built with **Three.js** and the **Web Audio API**. Drop any audio file and watch 128 frequency bars arranged in a circle react to the music — powered by a custom FFT pipeline running in a Web Worker.

![Audio Visualizer Preview](https://raw.githubusercontent.com/codebyflavio/audio-visualizer/main/preview.png)

## Features

- **3D scene** — 128 vertical bars arranged in a circle with rainbow HSL coloring and emissive glow
- **Web Worker FFT** — audio decoding and frequency analysis run off the main thread, keeping the UI smooth
- **Custom Cooley-Tukey FFT** — implemented from scratch with Hann windowing for accurate frequency detection
- **Per-band gain** — treble bins receive progressive amplification to compensate for natural roll-off in music
- **Pause / Resume** — backed by `AudioContext.suspend()` / `.resume()`, bars decay gracefully when paused
- **Seek** — click or drag the progress bar to jump anywhere in the track; also works while paused
- **Drag & drop** — drop an audio file directly onto the landing screen
- **Atmosphere** — reflective floor, floating particles, two orbital colored lights, a pulsing centre orb
- **Keyboard shortcuts** — `Space` · `←` · `→`

## Architecture

```
index.html
├── AudioVisualizer.js   Main thread: class + Three.js scene + bootstrap UI
└── audio-worker.js      Web Worker: FFT snapshot computation
```

### Data flow

```
File (MP3/WAV/…)
  │
  ▼  Main thread
AudioContext.decodeAudioData()   → raw PCM Float32Array
  │  postMessage (zero-copy transfer)
  ▼  Web Worker
Cooley-Tukey FFT × N snapshots   → packed Float32Array (128 bins × every 50 ms)
  │  postMessage (zero-copy transfer back)
  ▼  Main thread
AudioVisualizer.getCurrentFrequencies()   → synced to AudioContext.currentTime
  │
  ▼  Three.js tick()
128 BoxGeometry bars scaled on Y   → rendered at 60 fps
```

### Web Worker (`audio-worker.js`)

Receives the raw PCM buffer, then for each 50 ms window:

1. Applies a **Hann window** to reduce spectral leakage
2. Runs **Cooley-Tukey FFT** (256-point, in-place, bit-reversal + butterfly passes)
3. Computes magnitude: `√(re² + im²) / N` for the first 128 bins
4. Packs results into a single `Float32Array` transferred back with zero copy

### `AudioVisualizer` class

| Method | Description |
|---|---|
| `decode()` | Decodes audio on main thread, sends PCM to worker, awaits snapshot array |
| `play(offset?)` | Creates `AudioContext`, starts `BufferSourceNode` from `offset` seconds |
| `pause()` | `AudioContext.suspend()` — freezes `currentTime`, bars decay to minimum |
| `resume()` | `AudioContext.resume()` — bars react to audio again |
| `seek(seconds)` | Restarts `BufferSourceNode` from new position; preserves paused state |
| `togglePlayPause()` | Convenience wrapper |
| `getElapsed()` | `audioCtx.currentTime − startTime` (freeze-safe) |
| `getProgress()` | `elapsed / duration` in `[0, 1]` |
| `getCurrentFrequencies()` | Returns `Float32Array(128)` for the current playback position |

### Bar sensitivity

Raw FFT magnitudes for music are small (typically 0.01–0.08 per bin). The visualizer applies:

```js
const bandGain = 1 + (binIndex / 128) * 2.0;   // treble gets up to 3× more gain
const raw      = magnitude * 22 * bandGain;
const norm     = Math.min(Math.pow(raw, 0.72), 1); // power curve lifts quiet signals
```

The exponent `0.72 < 1` maps quiet signals into the visible range while preventing loud signals from clipping.

## Getting started

> A local HTTP server is required — Web Workers cannot be loaded from `file://`.

```bash
# Clone
git clone https://github.com/codebyflavio/audio-visualizer.git
cd audio-visualizer

# Serve (any static server works)
npx serve .
# → open http://localhost:3000
```

No build step. No dependencies to install. Three.js is loaded via CDN import map.

## Controls

| Input | Action |
|---|---|
| `Space` | Play / Pause |
| `←` | Seek back 10 seconds |
| `→` | Seek forward 10 seconds |
| Click progress bar | Jump to position |
| Drag progress bar | Scrub through track |

## Supported formats

MP3 · WAV · OGG · FLAC · AAC — anything `AudioContext.decodeAudioData()` supports in your browser.

## Browser compatibility

| Browser | Support |
|---|---|
| Chrome 89+ | ✅ Full |
| Firefox 108+ | ✅ Full |
| Safari 16.4+ | ✅ Full |
| Edge 89+ | ✅ Full |

Requires: **Import Maps**, **Web Workers**, **Web Audio API**, **WebGL**.

## Running tests

Core DSP logic (FFT correctness, snapshot pipeline, buffer transfer) is tested with Node.js — no browser needed:

```bash
node test.js
```

```
FFT — DC signal (all 1s)             ✓ 4 assertions
FFT — pure sine at bin 16            ✓ 4 assertions
FFT — silence (all zeros)            ✓ 1 assertion
FFT — two sines at bins 8 and 32     ✓ 2 assertions
FFT — full-amplitude signal          ✓ 1 assertion
Snapshot pipeline — chunk count      ✓ 2 assertions
Snapshot pipeline — packed buffer    ✓ 2 assertions
Snapshot pipeline — sine energy      ✓ 1 assertion
Snapshot pipeline — pcmBuffer        ✓ 3 assertions

Results: 20 passed, 0 failed
```

## Tech stack

| Layer | Technology |
|---|---|
| 3D rendering | [Three.js](https://threejs.org) r165 |
| Audio decoding | Web Audio API (`AudioContext`, `AudioBufferSourceNode`) |
| FFT | Custom Cooley-Tukey (no library) |
| Off-thread work | Web Workers |
| Styling | Vanilla CSS |
| Module loading | ES Import Maps (no bundler) |

## License

MIT
