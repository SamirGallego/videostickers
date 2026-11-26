// VideoStickers — todo se procesa en el navegador (apto para GitHub Pages).
const $ = id => document.getElementById(id);
const video = $('video'), crop = $('crop'), wave = $('wave');
const MAXD = 10, MIND = 0.2, SIZE = 512, MAX_BYTES = 500 * 1024, MAX_FPS = 60;
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const st = { url: null, name: 'sticker', start: 0, dur: 5, fps: 30, audio: null, peaks: null, rate: 100, maxPeak: 1, zoom: false, loop: false };
let view = { v0: 0, v1: 1 }, dragging = false, mode = 'crop', box = { x: 0, y: 0, w: 1, h: 1 }, outUrls = [];
const T = () => (isFinite(video.duration) ? video.duration : 0);
const viewer = $('viewer');

// ================= rotación =================
const rot = { q: 0, fine: 0, flip: false }; // q = giros de 90°, fine = grados extra
const rotDims = (vw, vh) => (rot.q % 2 ? [vh, vw] : [vw, vh]); // tamaño del cuadro ya rotado
function drawRotated(g, src, vw, vh, scale = 1) {
  const [rw, rh] = rotDims(vw, vh);
  g.save();
  g.scale(scale, scale);
  g.translate(rw / 2, rh / 2);
  g.rotate((rot.q * 90 + rot.fine) * Math.PI / 180);
  if (rot.flip) g.scale(-1, 1);
  g.drawImage(src, -vw / 2, -vh / 2, vw, vh);
  g.restore();
}
function setRot(fn) {
  fn();
  rot.q = ((rot.q % 4) + 4) % 4;
  $('fine').value = rot.fine;
  $('rotInfo').textContent = `${(rot.q * 90 + rot.fine + 360) % 360}°${rot.flip ? ' ⇋' : ''}`;
  layoutViewer(); setCropSize(); renderViewer();
}
$('bRotL').onclick = () => setRot(() => rot.q--);
$('bRotR').onclick = () => setRot(() => rot.q++);
$('bFlip').onclick = () => setRot(() => { rot.flip = !rot.flip; });
$('bRotReset').onclick = () => setRot(() => { rot.q = 0; rot.fine = 0; rot.flip = false; });
$('fine').oninput = () => setRot(() => { rot.fine = +$('fine').value; });

// vista previa: el video se dibuja rotado en un canvas
function layoutViewer() {
  if (!video.videoWidth) return;
  const [rw, rh] = rotDims(video.videoWidth, video.videoHeight);
  const W = viewer.parentElement.clientWidth, H = Math.max(200, window.innerHeight * 0.55);
  const s = Math.min(W / rw, H / rh), dpr = window.devicePixelRatio || 1;
  viewer.style.width = rw * s + 'px'; viewer.style.height = rh * s + 'px';
  viewer.width = Math.round(rw * s * dpr); viewer.height = Math.round(rh * s * dpr);
  drawCrop();
}
function renderViewer() {
  if (!video.videoWidth) return;
  const g = viewer.getContext('2d'), [rw] = rotDims(video.videoWidth, video.videoHeight);
  g.clearRect(0, 0, viewer.width, viewer.height);
  drawRotated(g, video, video.videoWidth, video.videoHeight, viewer.width / rw);
}

// ¿El navegador sabe codificar WebP? (Chrome, Edge, Firefox y Android sí; Safari no)
const canWebp = (() => { const c = document.createElement('canvas'); c.width = c.height = 2; return c.toDataURL('image/webp').startsWith('data:image/webp'); })();

// ================= carga =================
$('drop').onclick = () => $('file').click();
$('drop').ondragover = e => { e.preventDefault(); $('drop').classList.add('over'); };
$('drop').ondragleave = () => $('drop').classList.remove('over');
$('drop').ondrop = e => { e.preventDefault(); $('drop').classList.remove('over'); if (e.dataTransfer.files[0]) load(e.dataTransfer.files[0]); };
$('file').onchange = e => e.target.files[0] && load(e.target.files[0]);

async function load(file) {
  if (st.url) URL.revokeObjectURL(st.url);
  Object.assign(st, {
    url: URL.createObjectURL(file),
    name: file.name.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_').slice(0, 40) || 'sticker',
    audio: null, peaks: null, loop: false,
  });
  $('bLoop').classList.remove('on');
  $('gen').disabled = true; $('result').style.display = 'none'; showMsg('');
  video.src = st.url;
  $('drop').textContent = file.name + '  ·  cambiar video'; $('drop').classList.add('small');
  $('editor').style.display = 'block';
  status('Analizando audio…'); draw();
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    st.audio = await ctx.decodeAudioData(await file.arrayBuffer());
    ctx.close();
    computePeaks(st.audio);
    status('Listo. Elige el fragmento y genera.');
  } catch (e) {
    st.audio = null; st.peaks = [];
    status('Listo (no se encontró audio en el video, o el navegador no puede leerlo).');
  }
  st.fps = await measureFps(st.url); fillFpsOptions();
  if (!canWebp) status('Este navegador no puede crear WebP (Safari). Usa Chrome, Edge o Firefox.', true);
  draw();
}
function computePeaks(buf) {
  const R = st.rate, step = Math.max(1, Math.floor(buf.sampleRate / R)), n = Math.ceil(buf.length / step);
  const chans = []; for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
  const P = new Float32Array(n); let max = 1e-6;
  for (let i = 0; i < n; i++) {
    let m = 0; const a = i * step, b = Math.min(a + step, buf.length);
    for (const ch of chans) for (let j = a; j < b; j++) { const v = ch[j] < 0 ? -ch[j] : ch[j]; if (v > m) m = v; }
    P[i] = m; if (m > max) max = m;
  }
  st.peaks = P; st.maxPeak = max;
}
function showMsg(t) { $('msg').textContent = t; $('msg').style.display = t ? 'flex' : 'none'; }

video.onerror = () => {
  if (st.url) showMsg('Tu navegador no puede reproducir este formato de video (p. ej. HEVC/H.265 de iPhone). Prueba con otro navegador o conviértelo a MP4 (H.264).');
};
video.onloadedmetadata = () => {
  showMsg('');
  st.start = 0; st.dur = Math.min(5, T());
  $('gen').disabled = !canWebp;
  layoutViewer(); setCropSize(); updateView(); syncInputs(); draw();
};
video.onloadeddata = renderViewer;
video.onplay = video.onpause = () => { $('bPlay').textContent = video.paused ? '▶' : '⏸'; if (!video.paused) tick(); };
video.onseeked = () => { renderViewer(); draw(); };
window.addEventListener('resize', () => { layoutViewer(); renderViewer(); draw(); });

// Mide los fps reales del video reproduciendo un instante en silencio (sin tocar el reproductor)
async function measureFps(url) {
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.src = url;
  v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
  document.body.appendChild(v);
  try {
    await once(v, 'loadeddata');
    if (!v.requestVideoFrameCallback) return 30;
    const times = [];
    await new Promise(res => {
      const cb = (now, m) => { times.push(m.mediaTime); if (times.length < 30) v.requestVideoFrameCallback(cb); else res(); };
      v.requestVideoFrameCallback(cb);
      v.play().catch(res); setTimeout(res, 4000);
    });
    const d = []; for (let i = 1; i < times.length; i++) if (times[i] > times[i - 1]) d.push(times[i] - times[i - 1]);
    if (d.length < 4) return 30;
    d.sort((x, y) => x - y);
    let f = 1 / d[d.length >> 1]; // mediana
    let best = null;
    for (const k of [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 120]) if (Math.abs(f - k) / k < 0.07 && (!best || Math.abs(f - k) < Math.abs(f - best))) best = k;
    if (best) f = best;
    return clamp(f, 5, 240);
  } catch { return 30; } finally { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); }
}
function fillFpsOptions() {
  const src = Math.min(MAX_FPS, st.fps), sel = $('fpsSel'), prev = sel.value;
  const opts = [['max', `Máximo: ${+src.toFixed(2)} fps (todos los cuadros${st.fps > MAX_FPS ? ', tope 60' : ''})`]];
  for (const f of [30, 25, 24, 20, 15, 12, 10]) if (f < src - 0.5) opts.push([String(f), f + ' fps']);
  sel.innerHTML = opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
  sel.value = opts.some(o => o[0] === prev) ? prev : 'max';
}

// ================= transporte =================
function seek(t) { video.currentTime = clamp(t, 0, T()); draw(); }
const frame = () => 1 / (st.fps || 30);
const inSel = t => t >= st.start - 0.01 && t < st.start + st.dur;
function togglePlay() {
  if (!T()) return;
  if (video.paused) { if (st.loop && !inSel(video.currentTime)) video.currentTime = st.start; video.play(); }
  else video.pause();
}
function step(d) { video.pause(); seek(video.currentTime + d); }
function setLoop(on) { st.loop = on; $('bLoop').classList.toggle('on', on); if (on) { video.currentTime = st.start; video.play(); } }
$('bPlay').onclick = togglePlay;
$('bBack1').onclick = () => step(-1);
$('bFwd1').onclick = () => step(1);
$('bBackF').onclick = () => step(-frame());
$('bFwdF').onclick = () => step(frame());
$('bSelStart').onclick = () => seek(st.start);
$('bLoop').onclick = () => setLoop(!st.loop);
$('bZoom').onclick = () => toggleZoom();
function toggleZoom() { st.zoom = !st.zoom; $('bZoom').classList.toggle('on', st.zoom); updateView(); draw(); }
function tick() { // cursor fluido + bucle del fragmento
  if (st.loop && video.currentTime >= st.start + st.dur) video.currentTime = st.start;
  renderViewer(); draw();
  if (!video.paused) requestAnimationFrame(tick);
}
document.addEventListener('keydown', e => {
  if (!T() || e.target.tagName === 'INPUT') return;
  const k = e.key.toLowerCase();
  if (k === ' ') { e.preventDefault(); togglePlay(); }
  else if (k === 'arrowleft') { e.preventDefault(); step(e.shiftKey ? -1 : -frame()); }
  else if (k === 'arrowright') { e.preventDefault(); step(e.shiftKey ? 1 : frame()); }
  else if (k === 'home') seek(st.start);
  else if (k === 'i') setIn(video.currentTime);
  else if (k === 'o') setOut(video.currentTime);
  else if (k === 'l') setLoop(!st.loop);
  else if (k === 'z') toggleZoom();
  else if (k === 'q') $('bRotL').click();
  else if (k === 'e') $('bRotR').click();
  else if (k === 'm') $('bFlip').click();
});

// ================= fragmento =================
function setIn(t) { // mueve el inicio conservando el fin si se puede
  const end = st.start + st.dur;
  st.start = clamp(t, 0, Math.max(0, T() - MIND));
  if (end > st.start + MIND) st.dur = Math.min(end - st.start, MAXD);
  afterSel();
}
function setOut(t) { const end = clamp(t, st.start + MIND, T()); st.dur = Math.min(end - st.start, MAXD); afterSel(); }
function afterSel() { st.dur = clamp(st.dur, MIND, Math.max(MIND, T() - st.start)); syncInputs(); if (!dragging) updateView(); draw(); }
function syncInputs() { $('startN').value = st.start.toFixed(2); $('endN').value = (st.start + st.dur).toFixed(2); $('durN').value = st.dur.toFixed(2); }
$('bIn').onclick = () => setIn(video.currentTime);
$('bOut').onclick = () => setOut(video.currentTime);
$('startN').onchange = () => { setIn(+$('startN').value); seek(st.start); };
$('endN').onchange = () => { setOut(+$('endN').value); seek(st.start + st.dur); };
$('durN').onchange = () => { st.dur = clamp(+$('durN').value, MIND, MAXD); afterSel(); };

// ================= forma de onda =================
function updateView() {
  const d = T() || 1;
  if (st.zoom) { const pad = Math.max(0.5, st.dur * 0.3); view = { v0: Math.max(0, st.start - pad), v1: Math.min(d, st.start + st.dur + pad) }; }
  else view = { v0: 0, v1: d };
}
let C = null; // colores del tema (CSS)
function themeColors() {
  const cs = getComputedStyle(document.documentElement), v = n => cs.getPropertyValue(n).trim();
  C = { acc: v('--acc'), wave: v('--wave'), mute: v('--mute'), ink: v('--ink'), soft: v('--soft') };
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { themeColors(); draw(); });
const xOf = (t, w) => (t - view.v0) / (view.v1 - view.v0 || 1) * w;
function fmtT(t, ms) {
  if (!isFinite(t)) t = 0;
  const m = Math.floor(t / 60), s = t - m * 60;
  return m + ':' + (ms ? s.toFixed(2).padStart(5, '0') : String(Math.floor(s)).padStart(2, '0'));
}
function draw() {
  const dpr = window.devicePixelRatio || 1, w = wave.clientWidth, h = wave.clientHeight;
  if (!w) return;
  if (!C) themeColors();
  if (wave.width !== Math.round(w * dpr)) { wave.width = Math.round(w * dpr); wave.height = Math.round(h * dpr); }
  const ctx = wave.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
  const span = view.v1 - view.v0 || 1, top = 16, wh = h - top, mid = top + wh / 2;
  const xs = xOf(st.start, w), xe = xOf(st.start + st.dur, w);

  // regla de tiempo
  const steps = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const stp = steps.find(s => span / s <= w / 70) || 600;
  ctx.fillStyle = C.mute; ctx.font = '10px ui-monospace, Consolas, monospace'; ctx.textBaseline = 'top';
  for (let t = Math.ceil(view.v0 / stp) * stp; t <= view.v1; t += stp) {
    const x = xOf(t, w); ctx.fillRect(x, 0, 1, 5);
    ctx.fillText(stp < 1 ? t.toFixed(2) : fmtT(t), x + 3, 2);
  }
  ctx.globalAlpha = 0.13; ctx.fillStyle = C.acc; ctx.fillRect(xs, top, xe - xs, wh); ctx.globalAlpha = 1;

  // barras de audio
  if (st.peaks && st.peaks.length) {
    const P = st.peaks, R = st.rate;
    for (let px = 0; px < w; px++) {
      const t0 = view.v0 + px / w * span, t1 = t0 + span / w;
      const i0 = Math.floor(t0 * R), i1 = Math.max(i0 + 1, Math.ceil(t1 * R)); let m = 0;
      for (let i = i0; i < i1 && i < P.length; i++) if (P[i] > m) m = P[i];
      const amp = Math.max(0.5, Math.sqrt(m / st.maxPeak) * (wh / 2 - 3));
      ctx.fillStyle = px >= xs && px <= xe ? C.acc : C.wave;
      ctx.fillRect(px, mid - amp, 1, amp * 2);
    }
  } else {
    ctx.fillStyle = C.wave; ctx.fillRect(0, mid, w, 1);
    ctx.fillStyle = C.mute; ctx.textBaseline = 'middle';
    ctx.fillText(st.peaks ? 'Sin audio' : 'Cargando forma de onda…', 8, mid - 10);
  }
  // bordes del fragmento y cursor
  ctx.fillStyle = C.ink;
  for (const x of [xs, xe]) { // bordes: línea + pestaña para agarrar
    ctx.fillStyle = C.ink; ctx.fillRect(x - 1, top, 2, wh); ctx.fillRect(x - 5, h - 14, 10, 14);
    ctx.fillStyle = C.acc; ctx.fillRect(x - 3, h - 12, 6, 10);
  }
  const xp = xOf(video.currentTime, w);
  ctx.fillStyle = C.ink; ctx.fillRect(xp - 0.75, 0, 1.5, h); // cursor
  ctx.beginPath(); ctx.moveTo(xp - 5, 0); ctx.lineTo(xp + 5, 0); ctx.lineTo(xp, 7); ctx.fill();
  $('clock').textContent = fmtT(video.currentTime, true) + ' / ' + fmtT(T(), true);
}
function hitTest(px, w) {
  const xs = xOf(st.start, w), xe = xOf(st.start + st.dur, w), tol = matchMedia('(pointer: coarse)').matches ? 16 : 8;
  if (Math.abs(px - xs) < tol && Math.abs(px - xs) <= Math.abs(px - xe)) return 's';
  if (Math.abs(px - xe) < tol) return 'e';
  return px > xs && px < xe ? 'm' : 'seek';
}
function hover(e) {
  if (dragging) return;
  const r = wave.getBoundingClientRect(), k = hitTest(e.clientX - r.left, r.width);
  wave.style.cursor = k === 's' || k === 'e' ? 'ew-resize' : k === 'm' ? 'grab' : 'pointer';
}
wave.onpointermove = hover;
wave.onpointerdown = e => {
  if (!T()) return;
  wave.setPointerCapture(e.pointerId);
  const r = wave.getBoundingClientRect(), span = view.v1 - view.v0;
  const tAt = cx => clamp(view.v0 + (cx - r.left) / r.width * span, 0, T());
  const kind = hitTest(e.clientX - r.left, r.width);
  const t0 = tAt(e.clientX), s0 = st.start, end0 = st.start + st.dur, x0 = e.clientX;
  let moved = false;
  dragging = true; video.pause();
  const move = m => {
    if (Math.abs(m.clientX - x0) > 3) moved = true;
    const t = tAt(m.clientX);
    if (kind === 's') { st.start = clamp(t, Math.max(0, end0 - MAXD), end0 - MIND); st.dur = end0 - st.start; seek(st.start); }
    else if (kind === 'e') { st.dur = clamp(t, s0 + MIND, Math.min(T(), s0 + MAXD)) - s0; seek(s0 + st.dur); }
    else if (kind === 'm') { if (!moved) return; wave.style.cursor = 'grabbing'; st.start = clamp(s0 + t - t0, 0, T() - st.dur); seek(st.start); }
    else seek(t);
    syncInputs(); draw();
  };
  move(e);
  wave.onpointermove = move;
  wave.onpointerup = wave.onpointercancel = () => {
    if (kind === 'm' && !moved) seek(t0);
    dragging = false; wave.onpointermove = hover; wave.onpointerup = wave.onpointercancel = null;
    updateView(); draw();
  };
};

// ================= recorte =================
function setCropSize() { // el recorte se mide sobre el cuadro ya rotado
  if (!video.videoWidth) return;
  const [vw, vh] = rotDims(video.videoWidth, video.videoHeight);
  const side = Math.min(vw, vh) * $('cropSize').value / 100;
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  box.w = side / vw; box.h = side / vh;
  box.x = clamp(cx - box.w / 2, 0, 1 - box.w); box.y = clamp(cy - box.h / 2, 0, 1 - box.h);
  drawCrop();
}
function videoRect() { // posición del canvas de vista previa dentro del contenedor
  return { left: viewer.offsetLeft, top: viewer.offsetTop, w: viewer.clientWidth, h: viewer.clientHeight };
}
function drawCrop() {
  if (!video.videoWidth) return;
  const r = videoRect();
  crop.classList.toggle('off', mode !== 'crop');
  Object.assign(crop.style, { left: r.left + box.x * r.w + 'px', top: r.top + box.y * r.h + 'px', width: box.w * r.w + 'px', height: box.h * r.h + 'px' });
}
$('cropSize').oninput = setCropSize;
crop.onpointerdown = e => {
  crop.setPointerCapture(e.pointerId);
  const r = videoRect(), sx = e.clientX, sy = e.clientY, bx = box.x, by = box.y;
  let moved = false;
  crop.onpointermove = m => {
    if (Math.abs(m.clientX - sx) + Math.abs(m.clientY - sy) > 3) moved = true;
    box.x = clamp(bx + (m.clientX - sx) / r.w, 0, 1 - box.w);
    box.y = clamp(by + (m.clientY - sy) / r.h, 0, 1 - box.h);
    drawCrop();
  };
  crop.onpointerup = () => { crop.onpointermove = null; if (!moved) togglePlay(); }; // clic sin arrastrar = play/pausa
};
viewer.onclick = togglePlay;
document.querySelectorAll('#mode button').forEach(b => b.onclick = () => {
  mode = b.dataset.m;
  document.querySelectorAll('#mode button').forEach(x => x.classList.toggle('on', x === b));
  $('cropSizeWrap').style.display = mode === 'crop' ? '' : 'none';
  drawCrop();
});

// ================= generación (todo en el navegador) =================
function status(t, err) { $('status').textContent = t; $('status').className = err ? 'err' : 'note'; }
var once = (el, ev) => new Promise((res, rej) => {
  const ok = () => { el.removeEventListener('error', bad); res(); };
  const bad = () => { el.removeEventListener(ev, ok); rej(new Error('No se pudo leer el video')); };
  el.addEventListener(ev, ok, { once: true }); el.addEventListener('error', bad, { once: true });
});

// Extrae TODOS los cuadros del tramo a los fps pedidos. Para cada uno guarda un PNG (sin pérdida)
// y el rectángulo que cambió respecto a lo que ya se ve (para codificar solo esa zona).
const DIFF = 10; // diferencia mínima por canal para considerar que un píxel cambió
function diffRect(ref, px) {
  let x0 = SIZE, y0 = SIZE, x1 = -1, y1 = -1;
  for (let y = 0; y < SIZE; y++) {
    let o = y * SIZE * 4;
    for (let x = 0; x < SIZE; x++, o += 4) {
      if (Math.abs(ref[o] - px[o]) > DIFF || Math.abs(ref[o + 1] - px[o + 1]) > DIFF ||
          Math.abs(ref[o + 2] - px[o + 2]) > DIFF || Math.abs(ref[o + 3] - px[o + 3]) > DIFF) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; y1 = y;
      }
    }
  }
  if (x1 < 0) return null; // cuadro idéntico al anterior
  x0 &= ~1; y0 &= ~1; // WebP exige offsets pares
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
function copyRect(ref, px, r) {
  for (let y = r.y; y < r.y + r.h; y++) { const o = (y * SIZE + r.x) * 4; ref.set(px.subarray(o, o + r.w * 4), o); }
}
function unionRect(a, b) {
  if (!a) return b; if (!b) return a;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

async function grabFrames(start, dur, fps, onProgress) {
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = st.url;
  await once(v, 'loadeddata');
  const ow = v.videoWidth, oh = v.videoHeight, [vw, vh] = rotDims(ow, oh);
  const rc = document.createElement('canvas'); rc.width = vw; rc.height = vh; // cuadro rotado a resolución original
  const rg = rc.getContext('2d');
  const c = document.createElement('canvas'); c.width = c.height = SIZE;
  const g = c.getContext('2d', { willReadFrequently: true });
  const n = Math.max(1, Math.round(dur * fps)), frames = [];
  let ref = null;
  for (let i = 0; i < n; i++) {
    v.currentTime = Math.min(start + (i + 0.5) / fps, start + dur - 0.001); // centro del cuadro = cuadro exacto
    await once(v, 'seeked');
    rg.clearRect(0, 0, vw, vh);
    drawRotated(rg, v, ow, oh);
    g.clearRect(0, 0, SIZE, SIZE);
    if (mode === 'crop') {
      g.drawImage(rc, box.x * vw, box.y * vh, box.w * vw, box.h * vh, 0, 0, SIZE, SIZE);
    } else { // video completo con bordes transparentes
      const s = SIZE / Math.max(vw, vh), w = vw * s, h = vh * s;
      g.drawImage(rc, (SIZE - w) / 2, (SIZE - h) / 2, w, h);
    }
    const px = g.getImageData(0, 0, SIZE, SIZE).data;
    let rect;
    if (!ref) { ref = new Uint8ClampedArray(px); rect = { x: 0, y: 0, w: SIZE, h: SIZE }; }
    else { rect = diffRect(ref, px); if (rect) copyRect(ref, px, rect); }
    frames.push({ blob: await new Promise(r => c.toBlob(r, 'image/png')), rect });
    if (onProgress) onProgress((i + 1) / n);
  }
  v.removeAttribute('src'); v.load();
  return frames;
}

// Lista de cuadros a escribir conservando 1 de cada `step`. Los cuadros sin cambios no se escriben:
// su tiempo se suma al cuadro anterior (se ve exactamente igual y ahorra espacio).
function planFrames(frames, step, fps, dur) {
  const items = []; let pending = null;
  for (let i = 0; i < frames.length; i++) {
    pending = unionRect(pending, frames[i].rect);
    if (i % step !== 0) continue;
    if (pending || !items.length) items.push({ idx: i, rect: pending || { x: 0, y: 0, w: SIZE, h: SIZE }, t: i * 1000 / fps });
    pending = null;
  }
  items.forEach((it, k) => { const end = k + 1 < items.length ? items[k + 1].t : dur * 1000; it.d = Math.max(8, Math.round(end) - Math.round(it.t)); });
  return items;
}

// --- WebP animado: une cuadros WebP del canvas en un RIFF con VP8X + ANIM + ANMF ---
async function encodeItem(frames, it, q) {
  const r = it.rect, bmp = await createImageBitmap(frames[it.idx].blob, r.x, r.y, r.w, r.h);
  const cv = document.createElement('canvas'); cv.width = r.w; cv.height = r.h;
  cv.getContext('2d').drawImage(bmp, 0, 0); bmp.close();
  const blob = await new Promise(res => cv.toBlob(res, 'image/webp', q));
  const b = new Uint8Array(await blob.arrayBuffer()), dv = new DataView(b.buffer);
  const chunks = []; let alpha = false, bytes = 24;
  for (let p = 12; p + 8 <= b.length;) {
    const id = String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]), len = dv.getUint32(p + 4, true);
    const total = 8 + len + (len & 1);
    if (id === 'ALPH' || id === 'VP8 ' || id === 'VP8L') { chunks.push(b.subarray(p, p + total)); bytes += total; }
    if (id === 'ALPH') alpha = true;
    if (id === 'VP8L' && (b[p + 8 + 4] & 0x10)) alpha = true;
    p += total;
  }
  if (!chunks.length) throw new Error('El navegador no generó WebP');
  return { chunks, alpha, bytes };
}
function u24(a, o, v) { a[o] = v & 255; a[o + 1] = (v >> 8) & 255; a[o + 2] = (v >> 16) & 255; }
function riffChunk(id, parts) {
  const len = parts.reduce((s, p) => s + p.length, 0), out = new Uint8Array(8 + len + (len & 1));
  for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
  new DataView(out.buffer).setUint32(4, len, true);
  let o = 8; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
async function buildWebp(frames, items, q, onProgress) {
  const parts = []; let anyAlpha = false;
  for (let k = 0; k < items.length; k++) {
    const it = items[k], f = await encodeItem(frames, it, q); anyAlpha = anyAlpha || f.alpha;
    const hdr = new Uint8Array(16);
    u24(hdr, 0, it.rect.x / 2); u24(hdr, 3, it.rect.y / 2);
    u24(hdr, 6, it.rect.w - 1); u24(hdr, 9, it.rect.h - 1); u24(hdr, 12, it.d);
    hdr[15] = 0x02; // sin mezcla y sin borrar: el rectángulo reemplaza esa zona y el resto se conserva
    parts.push(riffChunk('ANMF', [hdr, ...f.chunks]));
    if (onProgress) onProgress((k + 1) / items.length);
  }
  const vp8x = new Uint8Array(10); vp8x[0] = 0x02 | (anyAlpha ? 0x10 : 0); u24(vp8x, 4, SIZE - 1); u24(vp8x, 7, SIZE - 1);
  const anim = new Uint8Array(6); // fondo transparente, bucle infinito
  const body = [new TextEncoder().encode('WEBP'), riffChunk('VP8X', [vp8x]), riffChunk('ANIM', [anim]), ...parts];
  const len = body.reduce((s, p) => s + p.length, 0), head = new Uint8Array(8);
  head.set(new TextEncoder().encode('RIFF')); new DataView(head.buffer).setUint32(4, len, true);
  return new Blob([head, ...body], { type: 'image/webp' });
}

// Mayor calidad posible que quepa en 500 KB con TODOS los cuadros; solo si ni con calidad mínima
// cabe, se quitan cuadros (1 de cada 2, luego 1 de cada 3…).
async function encodeBest(frames, fps, dur) {
  for (const step of [1, 2, 3, 4, 6, 8]) {
    const items = planFrames(frames, step, fps, dur);
    const ns = Math.min(items.length, 16), sample = [];
    for (let j = 0; j < ns; j++) sample.push(items[Math.floor(j * items.length / ns)]);
    const est = async q => { let s = 0; for (const it of sample) s += (await encodeItem(frames, it, q)).bytes; return 40 + s * items.length / ns; };
    const fpsTxt = +(fps / step).toFixed(2);
    status(`Calculando calidad para ${items.length} cuadros (${fpsTxt} fps)…`);
    if (await est(0) > MAX_BYTES * 0.95) continue; // ni con calidad mínima cabe: quitar cuadros
    let lo = 0, hi = 1;
    for (let k = 0; k < 6; k++) { const m = (lo + hi) / 2; if (await est(m) <= MAX_BYTES * 0.92) lo = m; else hi = m; }
    for (let q = lo; q >= 0; q -= 0.06) {
      const webp = await buildWebp(frames, items, q, p => status(`Codificando ${items.length} cuadros (${fpsTxt} fps, calidad ${Math.round(q * 100)})… ${Math.round(p * 100)}%`));
      if (webp.size <= MAX_BYTES) return { webp, used: { fps: fpsTxt, q: Math.round(q * 100), frames: items.length, total: Math.ceil(frames.length / step) } };
    }
  }
  throw new Error('No fue posible que el sticker quepa en 500 KB. Acorta el fragmento.');
}

// --- audio: el mismo tramo exacto + MP3 (lamejs) y WAV ---
function sliceAudio(buf, start, dur) {
  const sr = buf.sampleRate, a = Math.floor(start * sr), n = Math.max(1, Math.min(Math.floor(dur * sr), buf.length - a));
  const fade = Math.min(n >> 1, Math.floor(sr * 0.03)), out = [];
  for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) {
    const s = buf.getChannelData(c).slice(a, a + n);
    for (let i = 0; i < fade; i++) { s[i] *= i / fade; s[n - 1 - i] *= i / fade; } // evita "clics"
    out.push(s);
  }
  return { sr, chans: out };
}
const toI16 = f => { const o = new Int16Array(f.length); for (let i = 0; i < f.length; i++) { const v = clamp(f[i], -1, 1); o[i] = v < 0 ? v * 0x8000 : v * 0x7fff; } return o; };
function encodeMp3({ sr, chans }) {
  if (![48000, 44100, 32000, 24000, 22050, 16000].includes(sr) || !window.lamejs) return null;
  const enc = new lamejs.Mp3Encoder(chans.length, sr, 128), L = toI16(chans[0]), R = chans[1] ? toI16(chans[1]) : null, out = [];
  for (let i = 0; i < L.length; i += 1152) {
    const d = R ? enc.encodeBuffer(L.subarray(i, i + 1152), R.subarray(i, i + 1152)) : enc.encodeBuffer(L.subarray(i, i + 1152));
    if (d.length) out.push(new Uint8Array(d));
  }
  const e = enc.flush(); if (e.length) out.push(new Uint8Array(e));
  return new Blob(out, { type: 'audio/mpeg' });
}
function encodeWav({ sr, chans }) {
  const n = chans[0].length, ch = chans.length, buf = new ArrayBuffer(44 + n * ch * 2), dv = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVEfmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, ch, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * ch * 2, true);
  dv.setUint16(32, ch * 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * ch * 2, true);
  const I = chans.map(toI16); let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { dv.setInt16(o, I[c][i], true); o += 2; }
  return new Blob([buf], { type: 'audio/wav' });
}

$('gen').onclick = async () => {
  if (!T()) return;
  video.pause(); setLoop(false); video.pause();
  $('gen').disabled = true;
  const start = st.start, dur = st.dur;
  const src = Math.min(MAX_FPS, st.fps || 30), sel = $('fpsSel').value;
  const fps = sel === 'max' ? src : Math.min(+sel, src);
  try {
    status('Extrayendo cuadros… 0%');
    const frames = await grabFrames(start, dur, fps, p => status(`Extrayendo cuadros (${+fps.toFixed(2)} fps)… ${Math.round(p * 100)}%`));
    const { webp, used } = await encodeBest(frames, fps, dur);
    let mp3 = null, wav = null;
    if (st.audio) { const a = sliceAudio(st.audio, start, dur); mp3 = encodeMp3(a); wav = encodeWav(a); }
    show({ webp, mp3, wav, used, start });
    status('¡Sticker generado!');
  } catch (e) { console.error(e); status('Error: ' + (e.message || e), true); }
  $('gen').disabled = false;
};
function show({ webp, mp3, wav, used, start }) {
  outUrls.forEach(u => URL.revokeObjectURL(u)); outUrls = [];
  const url = b => { const u = URL.createObjectURL(b); outUrls.push(u); return u; };
  const files = [['WebP (sticker)', webp, 'webp']];
  if (mp3) files.push(['MP3 (sonido)', mp3, 'mp3']);
  if (wav) files.push(['WAV (sonido sin compresión)', wav, 'wav']);
  $('result').style.display = 'block';
  const img = $('outImg'); img.src = url(webp); img.dataset.src = img.src;
  const aud = mp3 || wav, hasA = !!aud;
  $('outAud').style.display = $('playBoth').style.display = hasA ? '' : 'none';
  if (hasA) $('outAud').src = url(aud);
  $('info').innerHTML = `WebP: ${(webp.size / 1024).toFixed(1)} KB · <b>${used.total} cuadros</b> a ${used.fps} fps · calidad ${used.q}` +
    (used.frames < used.total ? ` · ${used.total - used.frames} cuadros repetidos fusionados` : '') +
    (webp.size <= MAX_BYTES ? '' : ' <span class="warn">(supera 500 KB: reduce la duración)</span>') +
    (used.q < 25 ? '<br><span class="warn">Calidad baja para caber en 500 KB con tantos cuadros. Si se ve borroso, baja los fps o acorta el fragmento.</span>' : '') +
    (hasA ? '' : '<br><span class="warn">Sin audio en este video.</span>');
  const base = `${st.name}_${start.toFixed(1)}s`;
  $('files').innerHTML = '';
  for (const [label, blob, ext] of files) {
    const a = document.createElement('a');
    a.className = 'btn'; a.href = url(blob); a.download = `${base}.${ext}`;
    a.textContent = `↓ ${a.download}  ·  ${label}  ·  ${(blob.size / 1024).toFixed(0)} KB`;
    $('files').appendChild(a);
  }
}
$('playBoth').onclick = () => { // reinicia animación y sonido a la vez
  const img = $('outImg'), s = img.dataset.src; img.src = ''; img.src = s;
  $('outAud').currentTime = 0; $('outAud').play();
};
