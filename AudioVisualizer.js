import * as THREE from 'three';

// ─── AudioVisualizer ──────────────────────────────────────────────────────────

export class AudioVisualizer {
  constructor(file, opts = {}) {
    this.file          = file;
    this.numBins       = opts.numBins       ?? 128;
    this.chunkInterval = opts.chunkInterval ?? 0.05;

    this.snapshots      = null;
    this.totalSnapshots = 0;
    this.duration       = 0;

    this._audioCtx  = null;
    this._audioBuf  = null;   // cached decoded buffer (reused on seek)
    this._source    = null;
    this._startTime = 0;      // audioCtx.currentTime when offset=0 would be "t=0"
    this.isPlaying  = false;
    this.isPaused   = false;
    this._seeking   = false;

    this._renderer  = null;
    this._scene     = null;
    this._camera    = null;
    this._bars      = [];
    this._orb       = null;
    this._orbLights = [];
    this._particles = [];
    this._rafId     = null;

    this.onProgress       = null; // (ratio) => void
    this.onEnded          = null; // () => void
    this.onPlayPauseChange = null; // (isPaused) => void
  }

  // ── 1. Decode → Worker ────────────────────────────────────────────────────

  async decode() {
    const arrayBuffer = await this.file.arrayBuffer();
    const tmpCtx      = new AudioContext();
    const audioBuf    = await tmpCtx.decodeAudioData(arrayBuffer);
    await tmpCtx.close();

    this.duration  = audioBuf.duration;
    this._audioBuf = audioBuf; // cache for seek reuse

    const pcmBuffer = audioBuf.getChannelData(0).slice().buffer;

    return new Promise((resolve, reject) => {
      const worker = new Worker('audio-worker.js');
      worker.postMessage({ pcmBuffer, sampleRate: audioBuf.sampleRate }, [pcmBuffer]);

      worker.onmessage = ({ data }) => {
        if (data.type === 'progress') {
          this.onProgress?.(data.processed);
        } else if (data.type === 'complete') {
          this.snapshots      = data.packed;
          this.totalSnapshots = data.totalSnapshots;
          worker.terminate();
          resolve();
        } else if (data.type === 'error') {
          worker.terminate();
          reject(new Error(data.message));
        }
      };
      worker.onerror = (err) => { worker.terminate(); reject(err); };
    });
  }

  // ── 2. Playback controls ──────────────────────────────────────────────────

  async play(offset = 0) {
    if (this.isPlaying && !this.isPaused) return;

    if (!this._audioCtx) {
      this._audioCtx = new AudioContext();
    }

    // Decode on first play if not already cached
    if (!this._audioBuf) {
      const buf      = await this.file.arrayBuffer();
      this._audioBuf = await this._audioCtx.decodeAudioData(buf);
    }

    this._startSource(offset);
  }

  /** Internal: creates + starts a BufferSourceNode from `offset` seconds. */
  _startSource(offset) {
    // Tear down previous source without triggering onended
    if (this._source) {
      this._source.onended = null;
      try { this._source.stop(); } catch (_) {}
      this._source.disconnect();
    }

    const src        = this._audioCtx.createBufferSource();
    src.buffer       = this._audioBuf;
    src.connect(this._audioCtx.destination);
    src.start(0, offset);

    // _startTime anchors audioCtx.currentTime → elapsed mapping
    this._startTime = this._audioCtx.currentTime - offset;
    this._source    = src;
    this.isPlaying  = true;
    this.isPaused   = false;

    src.onended = () => {
      if (this._seeking) return; // ignore if we're mid-seek
      this.isPlaying = false;
      this.onEnded?.();
    };
  }

  async pause() {
    if (!this.isPlaying || this.isPaused) return;
    await this._audioCtx.suspend();
    this.isPaused = true;
    this.onPlayPauseChange?.(true);
  }

  async resume() {
    if (!this.isPlaying || !this.isPaused) return;
    await this._audioCtx.resume();
    this.isPaused = false;
    this.onPlayPauseChange?.(false);
  }

  async togglePlayPause() {
    if (this.isPaused) await this.resume();
    else               await this.pause();
  }

  /**
   * Seek to `seconds` in the audio.
   * Works whether playing or paused; preserves the paused state.
   */
  async seek(seconds) {
    if (!this.isPlaying && !this.isPaused) return;
    const target    = Math.max(0, Math.min(seconds, this.duration));
    const wasPaused = this.isPaused;

    this._seeking = true;

    // Resume first so we can create a running source (needed for suspend to work)
    if (wasPaused) await this._audioCtx.resume();

    this._startSource(target);
    this._seeking = false;

    // Restore paused state if we were paused
    if (wasPaused) {
      await this._audioCtx.suspend();
      this.isPaused = true;
    }
  }

  // ── 3. Position helpers ───────────────────────────────────────────────────

  getElapsed() {
    if (!this._audioCtx) return 0;
    return Math.max(0, Math.min(this._audioCtx.currentTime - this._startTime, this.duration));
  }

  getProgress() {
    return this.duration > 0 ? this.getElapsed() / this.duration : 0;
  }

  getCurrentFrequencies() {
    if (!this.snapshots || !this.isPlaying || this.isPaused || !this._audioCtx) return null;
    const idx    = Math.min(Math.floor(this.getElapsed() / this.chunkInterval), this.totalSnapshots - 1);
    const offset = idx * this.numBins;
    return this.snapshots.subarray(offset, offset + this.numBins);
  }

  // ── 4. Three.js scene ─────────────────────────────────────────────────────

  initScene(canvas) {
    const W = canvas.clientWidth  || window.innerWidth;
    const H = canvas.clientHeight || window.innerHeight;

    // Renderer
    this._renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this._renderer.setSize(W, H);
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this._renderer.setClearColor(0x06001a);
    this._renderer.toneMapping        = THREE.ACESFilmicToneMapping;
    this._renderer.toneMappingExposure = 1.8;

    // Scene + fog
    this._scene = new THREE.Scene();
    this._scene.fog = new THREE.FogExp2(0x06001a, 0.018);

    // Camera
    this._camera = new THREE.PerspectiveCamera(65, W / H, 0.1, 200);
    this._camera.position.set(0, 10, 26);
    this._camera.lookAt(0, 3, 0);

    // Lights
    this._scene.add(new THREE.AmbientLight(0x2a0060, 3));

    this._centreLight = new THREE.PointLight(0x00ffcc, 6, 40);
    this._centreLight.position.set(0, 4, 0);
    this._scene.add(this._centreLight);

    [
      { color: 0xff0088, radius: 14, speed: 0.38, phase: 0,        height: 6 },
      { color: 0x8844ff, radius: 14, speed: 0.22, phase: Math.PI,  height: 8 },
    ].forEach(def => {
      const light = new THREE.PointLight(def.color, 4, 28);
      const mesh  = new THREE.Mesh(
        new THREE.SphereGeometry(0.28, 16, 16),
        new THREE.MeshStandardMaterial({ color: def.color, emissive: def.color, emissiveIntensity: 6, roughness: 0 })
      );
      light.add(mesh);
      this._scene.add(light);
      this._orbLights.push({ light, ...def });
    });

    // Floor grid + reflective plane
    this._scene.add(new THREE.GridHelper(60, 40, 0x3300aa, 0x1a0044));

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(60, 60),
      new THREE.MeshStandardMaterial({ color: 0x08002a, roughness: 0.05, metalness: 1, transparent: true, opacity: 0.55 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.01;
    this._scene.add(floor);

    // Centre orb
    this._orb = new THREE.Mesh(
      new THREE.SphereGeometry(1.4, 48, 48),
      new THREE.MeshStandardMaterial({ color: 0x00ffcc, emissive: 0x00ffcc, emissiveIntensity: 3, roughness: 0, metalness: 0.3, transparent: true, opacity: 0.75 })
    );
    this._orb.position.set(0, 1.4, 0);
    this._scene.add(this._orb);

    const glowRing = new THREE.Mesh(
      new THREE.RingGeometry(1.8, 2.2, 64),
      new THREE.MeshBasicMaterial({ color: 0x00ffcc, transparent: true, opacity: 0.18, side: THREE.DoubleSide })
    );
    glowRing.rotation.x = -Math.PI / 2;
    glowRing.position.y = 0.02;
    this._scene.add(glowRing);

    // 128 frequency bars
    const RADIUS = 10;
    for (let i = 0; i < this.numBins; i++) {
      const angle = (i / this.numBins) * Math.PI * 2;
      const hue   = i / this.numBins;
      const geo   = new THREE.BoxGeometry(0.18, 1, 0.18);
      geo.translate(0, 0.5, 0);
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color().setHSL(hue, 1.0, 0.62),
        emissive: new THREE.Color().setHSL(hue, 1.0, 0.48),
        emissiveIntensity: 1.5,
        roughness: 0.06,
        metalness: 0.85,
      });
      const bar = new THREE.Mesh(geo, mat);
      bar.position.set(Math.cos(angle) * RADIUS, 0, Math.sin(angle) * RADIUS);
      bar.rotation.y = -angle;
      this._scene.add(bar);
      this._bars.push(bar);
    }

    // Floating particles
    const pGeo = new THREE.SphereGeometry(0.04, 6, 6);
    for (let i = 0; i < 220; i++) {
      const p = new THREE.Mesh(pGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL(Math.random(), 1, 0.8) }));
      const r = 8 + Math.random() * 16, a = Math.random() * Math.PI * 2;
      p.position.set(Math.cos(a) * r, Math.random() * 18, Math.sin(a) * r);
      p.userData = { speed: (Math.random() - 0.5) * 0.008, wobble: Math.random() * Math.PI * 2 };
      this._scene.add(p);
      this._particles.push(p);
    }

    window.addEventListener('resize', () => {
      const W = canvas.clientWidth  || window.innerWidth;
      const H = canvas.clientHeight || window.innerHeight;
      this._camera.aspect = W / H;
      this._camera.updateProjectionMatrix();
      this._renderer.setSize(W, H);
    });

    return this;
  }

  // ── 5. Animation loop ─────────────────────────────────────────────────────

  startAnimation() {
    const MIN_H = 0.05;
    const MAX_H = 18;

    const tick = () => {
      this._rafId = requestAnimationFrame(tick);
      const t    = performance.now() * 0.001;

      // Bars decay smoothly when paused, react when playing
      const freqs      = this.getCurrentFrequencies();
      const LERP       = this.isPaused ? 0.06 : 0.16;
      let   bassAvg    = 0;

      for (let i = 0; i < this._bars.length; i++) {
        const bar = this._bars[i];
        let targetH = MIN_H;

        if (freqs) {
          // Per-band gain: treble bins have less natural energy in music,
          // so they get a progressively higher boost to move as much as bass.
          const bandGain = 1 + (i / this._bars.length) * 2.0;

          // Amplify raw FFT magnitude, then apply a power curve < 1 so that
          // quieter signals are lifted toward the visible range without clipping
          // loud signals. Result is clamped to [0, 1].
          const raw  = freqs[i] * 22 * bandGain;
          const norm = Math.min(Math.pow(raw, 0.72), 1);

          targetH = MIN_H + norm * (MAX_H - MIN_H);
          if (i < 8) bassAvg += norm;
        }

        bar.scale.y += (targetH - bar.scale.y) * LERP;
        bar.material.emissiveIntensity = 1.0 + (bar.scale.y / MAX_H) * 5.5;
      }

      // Centre orb
      if (this._orb) {
        const bassNorm = freqs ? bassAvg / 8 : 0;
        this._orb.scale.setScalar(1 + bassNorm * 0.6 + Math.sin(t * 1.8) * 0.04);
        this._orb.material.emissiveIntensity = 2.5 + bassNorm * 5;
        this._centreLight.intensity          = 5   + bassNorm * 14;
      }

      // Orbital lights
      this._orbLights.forEach(({ light, radius, speed, phase, height }) => {
        const a = t * speed + phase;
        light.position.set(Math.cos(a) * radius, height, Math.sin(a) * radius);
      });

      // Particles
      for (const p of this._particles) {
        p.userData.wobble += p.userData.speed;
        p.position.y      += 0.012;
        p.position.x      += Math.sin(p.userData.wobble) * 0.004;
        if (p.position.y > 20) p.position.y = 0;
      }

      // Camera orbit
      const camT = t * 0.18;
      this._camera.position.x = Math.sin(camT) * 26;
      this._camera.position.z = Math.cos(camT) * 26;
      this._camera.position.y = 10 + Math.sin(t * 0.12) * 2;
      this._camera.lookAt(0, 3, 0);

      this._renderer.render(this._scene, this._camera);
    };

    tick();
  }

  // ── 6. Teardown ───────────────────────────────────────────────────────────

  stop() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    if (this._source) { this._source.onended = null; try { this._source.stop(); } catch (_) {} }
    if (this._audioCtx) this._audioCtx.close();
    this.isPlaying = false;
    this.isPaused  = false;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const canvas      = document.getElementById('canvas');
const ui          = document.getElementById('ui');
const loadingEl   = document.getElementById('loading');
const trackNameEl = document.getElementById('track-name-loading');
const barFill     = document.getElementById('progress-bar-fill');
const pctEl       = document.getElementById('progress-pct');
const statusEl    = document.getElementById('status');
const fileInput   = document.getElementById('file-input');
const browseBtn   = document.getElementById('browse-btn');
const dropzone    = document.getElementById('dropzone');

// Controls
const controls      = document.getElementById('controls');
const btnPlayPause  = document.getElementById('btn-playpause');
const ctrlName      = document.getElementById('ctrl-name');
const ctrlTime      = document.getElementById('ctrl-time');
const ctrlProgWrap  = document.getElementById('ctrl-progress-wrap');
const ctrlProgFill  = document.getElementById('ctrl-progress-fill');
const ctrlProgThumb = document.getElementById('ctrl-progress-thumb');

const ICON_PLAY  = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>`;
const ICON_PAUSE = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="3" width="4" height="18" rx="1"/><rect x="15" y="3" width="4" height="18" rx="1"/></svg>`;

let current   = null;
let trackName = '';
let rafHud    = null;

// ── File input ────────────────────────────────────────────────────────────────

browseBtn.addEventListener('click', () => fileInput.click());

dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag-over'); });
dropzone.addEventListener('dragleave', ()  => dropzone.classList.remove('drag-over'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) loadFile(file);
});

fileInput.addEventListener('change', (e) => {
  if (e.target.files[0]) loadFile(e.target.files[0]);
});

// ── Load + start ──────────────────────────────────────────────────────────────

async function loadFile(file) {
  current?.stop();
  current = null;
  cancelAnimationFrame(rafHud);

  trackName = file.name.replace(/\.[^/.]+$/, '');
  trackNameEl.textContent = trackName;
  ctrlName.textContent    = trackName;

  ui.classList.add('hidden');
  loadingEl.classList.add('visible');
  barFill.style.width = '0%';
  pctEl.textContent   = '0%';

  const av = new AudioVisualizer(file, { numBins: 128, chunkInterval: 0.05 });

  av.onProgress = (r) => {
    const p = Math.round(r * 100);
    barFill.style.width = p + '%';
    pctEl.textContent   = p + '%';
  };

  av.onPlayPauseChange = (paused) => {
    btnPlayPause.innerHTML = paused ? ICON_PLAY : ICON_PAUSE;
    btnPlayPause.setAttribute('aria-label', paused ? 'Play' : 'Pause');
  };

  av.onEnded = () => {
    cancelAnimationFrame(rafHud);
    controls.classList.remove('visible');
    ui.classList.remove('hidden');
    statusEl.textContent = 'Choose another file to play again';
  };

  try {
    await av.decode();
    barFill.style.width = '100%';
    pctEl.textContent   = '100%';

    av.initScene(canvas);
    av.startAnimation();
    current = av;

    loadingEl.classList.remove('visible');
    controls.classList.add('visible');
    btnPlayPause.innerHTML = ICON_PAUSE;

    await av.play();
    startHud(av);
  } catch (err) {
    loadingEl.classList.remove('visible');
    ui.classList.remove('hidden');
    statusEl.textContent = `Error: ${err.message}`;
    console.error(err);
  }
}

// ── HUD update loop ───────────────────────────────────────────────────────────

function startHud(av) {
  const update = () => {
    rafHud = requestAnimationFrame(update);
    const elapsed  = av.getElapsed();
    const progress = av.getProgress();
    ctrlTime.textContent    = `${formatTime(elapsed)} / ${formatTime(av.duration)}`;
    ctrlProgFill.style.width = (progress * 100) + '%';
    ctrlProgThumb.style.left = (progress * 100) + '%';
  };
  update();
}

// ── Play / Pause button ───────────────────────────────────────────────────────

btnPlayPause.addEventListener('click', async () => {
  if (!current) return;
  await current.togglePlayPause();
});

document.getElementById('btn-back10').addEventListener('click', async () => {
  if (!current) return;
  await current.seek(current.getElapsed() - 10);
});

document.getElementById('btn-fwd10').addEventListener('click', async () => {
  if (!current) return;
  await current.seek(current.getElapsed() + 10);
});

// ── Seek via progress bar ─────────────────────────────────────────────────────

function seekFromEvent(e) {
  if (!current) return;
  const rect    = ctrlProgWrap.getBoundingClientRect();
  const ratio   = Math.max(0, Math.min((e.clientX - rect.left) / rect.width, 1));
  current.seek(ratio * current.duration);
}

let seeking = false;
ctrlProgWrap.addEventListener('mousedown', (e) => { seeking = true; seekFromEvent(e); });
window.addEventListener('mousemove',  (e) => { if (seeking) seekFromEvent(e); });
window.addEventListener('mouseup',    ()  => { seeking = false; });

// Touch support for progress bar
ctrlProgWrap.addEventListener('touchstart', (e) => { seeking = true; seekFromEvent(e.touches[0]); }, { passive: true });
window.addEventListener('touchmove',  (e) => { if (seeking) seekFromEvent(e.touches[0]); }, { passive: true });
window.addEventListener('touchend',   ()  => { seeking = false; });

// ── Keyboard shortcuts ────────────────────────────────────────────────────────

window.addEventListener('keydown', async (e) => {
  if (!current) return;
  // Ignore when typing in an input
  if (e.target.tagName === 'INPUT') return;

  switch (e.code) {
    case 'Space':
      e.preventDefault();
      await current.togglePlayPause();
      break;
    case 'ArrowRight':
      e.preventDefault();
      await current.seek(current.getElapsed() + 10);
      break;
    case 'ArrowLeft':
      e.preventDefault();
      await current.seek(current.getElapsed() - 10);
      break;
  }
});
