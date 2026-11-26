// VideoStickers — todo se procesa en el navegador (apto para GitHub Pages).
const $ = id => document.getElementById(id);
const video = $('video'), crop = $('crop'), wave = $('wave');
const MAXD = 10, MIND = 0.2, SIZE = 512, MAX_BYTES = 500 * 1024, MAX_FPS = 60;
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const st = { url: null, name: 'sticker', start: 0, dur: 5, fps: 30, audio: null, peaks: null, rate: 100, maxPeak: 1, zoom: false, loop: false };
let view = { v0: 0, v1: 1 }, dragging = false, mode = 'crop', box = { x: 0, y: 0, w: 1, h: 1 }, outUrls = [];
const T = () => (isFinite(video.duration) ? video.duration : 0);
const viewer = $('vbox'); // caja que contiene el video ya rotado

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

// vista previa: se muestra el <video> nativo y se rota con CSS. Así adelantar/atrasar funciona igual
// en celulares (dibujar un video oculto en un canvas no se actualizaba al buscar en Android/iPhone).
function layoutViewer() {
  if (!video.videoWidth) return;
  const vw = video.videoWidth, vh = video.videoHeight, [rw, rh] = rotDims(vw, vh);
  const W = viewer.parentElement.clientWidth, H = Math.max(200, window.innerHeight * 0.55);
  const s = Math.min(W / rw, H / rh);
  viewer.style.width = rw * s + 'px'; viewer.style.height = rh * s + 'px';
  video.style.width = vw * s + 'px'; video.style.height = vh * s + 'px';
  video.style.transform = `translate(-50%, -50%) rotate(${rot.q * 90 + rot.fine}deg)${rot.flip ? ' scaleX(-1)' : ''}`;
  drawCrop();
}
function renderViewer() { /* el navegador pinta el video solo */ }

// ¿El navegador sabe codificar WebP? (Chrome, Edge, Firefox y Android sí; Safari/iPhone no -> se usa WebAssembly)
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
  $('drop').textContent = file.name + '  ·  cambiar video'; $('drop').classList.add('small');
  $('editor').style.display = 'block';
  status('Abriendo video…'); draw();
  const meta = once(video, 'loadedmetadata', 20000).catch(() => null);
  video.src = st.url; video.load();
  await meta;
  // "despierta" el video (iPhone no carga cuadros hasta reproducir) y de paso mide los fps reales
  st.fps = await primeAndMeasureFps(); fillFpsOptions();
  status('Analizando audio…');
  try {
    // videos largos: decodificar a 22 kHz para no agotar la memoria del celular
    const rate = T() > 90 ? 22050 : 44100;
    const AC = window.AudioContext || window.webkitAudioContext;
    let ctx;
    try { ctx = new AC({ sampleRate: rate }); } catch { ctx = new AC(); }
    let buf = await file.arrayBuffer();
    st.audio = await new Promise((res, rej) => { const p = ctx.decodeAudioData(buf, res, rej); if (p && p.then) p.then(res, rej); });
    buf = null; if (ctx.close) ctx.close();
    computePeaks(st.audio);
    status('Listo. Elige el fragmento y genera.');
  } catch (e) {
    st.audio = null; st.peaks = [];
    status('Listo (no se encontró audio en el video, o el navegador no puede leerlo).');
  }
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
  $('gen').disabled = false;
  layoutViewer(); setCropSize(); updateView(); syncInputs(); draw();
};
video.onplay = video.onpause = () => { $('bPlay').textContent = video.paused ? '▶' : '⏸'; if (!video.paused) tick(); };
video.onseeked = () => { renderViewer(); draw(); };
window.addEventListener('resize', () => { layoutViewer(); renderViewer(); draw(); });

// Reproduce en silencio un instante con el mismo reproductor: en iPhone es necesario para que el
// video entregue cuadros y se pueda adelantar/atrasar; además sirve para medir los fps reales.
async function primeAndMeasureFps() {
  const times = [];
  try {
    video.muted = true;
    const done = new Promise(res => {
      if (!video.requestVideoFrameCallback) return setTimeout(res, 400);
      const cb = (now, m) => { times.push(m.mediaTime); if (times.length < 25) video.requestVideoFrameCallback(cb); else res(); };
      video.requestVideoFrameCallback(cb);
      setTimeout(res, 2500);
    });
    await video.play();
    await done;
  } catch { /* sin reproducción automática: seguimos con 30 fps */ }
  video.pause(); video.muted = false;
  await seekTo(video, 0);
  const d = []; for (let i = 1; i < times.length; i++) if (times[i] > times[i - 1]) d.push(times[i] - times[i - 1]);
  if (d.length < 4) return 30;
  d.sort((x, y) => x - y);
  const f = 1 / d[d.length >> 1]; let best = null; // mediana
  for (const k of [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 120]) if (Math.abs(f - k) / k < 0.07 && (!best || Math.abs(f - k) < Math.abs(f - best))) best = k;
  return clamp(best || f, 5, 240);
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
viewer.onclick = togglePlay; // tocar el video = play/pausa
document.querySelectorAll('#mode button').forEach(b => b.onclick = () => {
  mode = b.dataset.m;
  document.querySelectorAll('#mode button').forEach(x => x.classList.toggle('on', x === b));
  $('cropSizeWrap').style.display = mode === 'crop' ? '' : 'none';
  drawCrop();
});

// ================= generación (todo en el navegador) =================
function status(t, err) { $('status').textContent = t; $('status').className = err ? 'err' : 'note'; }
function once(el, ev, ms = 0) { // espera un evento (con límite de tiempo opcional)
  return new Promise((res, rej) => {
    let t;
    const ok = () => { clearTimeout(t); el.removeEventListener('error', bad); res(); };
    const bad = () => { clearTimeout(t); el.removeEventListener(ev, ok); rej(new Error('No se pudo leer el video')); };
    el.addEventListener(ev, ok, { once: true }); el.addEventListener('error', bad, { once: true });
    if (ms) t = setTimeout(() => { el.removeEventListener(ev, ok); el.removeEventListener('error', bad); rej(new Error('tiempo agotado')); }, ms);
  });
}
// Mueve el video a `t` y espera a que ese cuadro esté listo para dibujarse.
async function seekTo(v, t) {
  const p = once(v, 'seeked', 4000).catch(() => {});
  v.currentTime = t;
  await p;
  if (v.requestVideoFrameCallback) await new Promise(res => { v.requestVideoFrameCallback(() => res()); setTimeout(res, 120); });
}

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
  // Se usa el mismo reproductor: en celulares abrir un segundo video suele fallar o quedarse colgado.
  const v = video, back = v.currentTime;
  v.pause();
  const ow = v.videoWidth, oh = v.videoHeight, [vw, vh] = rotDims(ow, oh);
  // cuadro rotado, limitado a ~1080p para ahorrar memoria (el sticker es de 512 px)
  const k = Math.min(1, 1920 / Math.max(vw, vh));
  const rc = document.createElement('canvas'); rc.width = Math.round(vw * k); rc.height = Math.round(vh * k);
  const rg = rc.getContext('2d');
  const c = document.createElement('canvas'); c.width = c.height = SIZE;
  const g = c.getContext('2d', { willReadFrequently: true });
  const n = Math.max(1, Math.round(dur * fps)), frames = [];
  let ref = null;
  try {
    for (let i = 0; i < n; i++) {
      await seekTo(v, Math.min(start + (i + 0.5) / fps, start + dur - 0.001)); // centro del cuadro = cuadro exacto
      rg.clearRect(0, 0, rc.width, rc.height);
      rg.save(); rg.scale(k, k); drawRotated(rg, v, ow, oh); rg.restore();
      g.clearRect(0, 0, SIZE, SIZE);
      if (mode === 'crop') {
        g.drawImage(rc, box.x * rc.width, box.y * rc.height, box.w * rc.width, box.h * rc.height, 0, 0, SIZE, SIZE);
      } else { // video completo con bordes transparentes
        const s = SIZE / Math.max(rc.width, rc.height), w = rc.width * s, h = rc.height * s;
        g.drawImage(rc, (SIZE - w) / 2, (SIZE - h) / 2, w, h);
      }
      const px = g.getImageData(0, 0, SIZE, SIZE).data;
      let rect;
      if (!ref) { ref = new Uint8ClampedArray(px); rect = { x: 0, y: 0, w: SIZE, h: SIZE }; }
      else { rect = diffRect(ref, px); if (rect) copyRect(ref, px, rect); }
      frames.push({ blob: await new Promise(r => c.toBlob(r, 'image/png')), rect });
      draw();
      if (onProgress) onProgress((i + 1) / n);
    }
  } finally {
    rc.width = rc.height = c.width = c.height = 0; // libera memoria de canvas (iPhone tiene un tope)
    await seekTo(v, back);
  }
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
const itemCanvas = document.createElement('canvas'); // un solo canvas reutilizado (evita agotar memoria)
let wasmEnc = null;
function loadWasmEncoder() { // libwebp en WebAssembly, solo si el navegador no codifica WebP (Safari/iPhone)
  if (!wasmEnc) wasmEnc = import('https://cdn.jsdelivr.net/npm/@jsquash/webp@1.4.0/codec/enc/webp_enc.js')
    .then(m => m.default({ noInitialRun: true }))
    .catch(e => { wasmEnc = null; throw new Error('No se pudo cargar el codificador WebP (¿sin internet?)'); });
  return wasmEnc;
}
const WASM_OPTS = { quality: 75, target_size: 0, target_PSNR: 0, method: 4, sns_strength: 50, filter_strength: 60, filter_sharpness: 0,
  filter_type: 1, partitions: 0, segments: 4, pass: 1, show_compressed: 0, preprocessing: 0, autofilter: 0, partition_limit: 0,
  alpha_compression: 1, alpha_filtering: 1, alpha_quality: 100, lossless: 0, exact: 0, image_hint: 0, emulate_jpeg_size: 0,
  thread_level: 0, low_memory: 0, near_lossless: 100, use_delta_palette: 0, use_sharp_yuv: 0 };
async function canvasToWebp(cv, q) {
  if (canWebp) return new Uint8Array(await (await new Promise(res => cv.toBlob(res, 'image/webp', q))).arrayBuffer());
  const enc = await loadWasmEncoder();
  const img = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
  const out = enc.encode(img.data, cv.width, cv.height, { ...WASM_OPTS, quality: Math.round(q * 100) });
  if (!out) throw new Error('No se pudo codificar WebP');
  return new Uint8Array(out);
}
async function encodeItem(frames, it, q) {
  const r = it.rect, bmp = await createImageBitmap(frames[it.idx].blob, r.x, r.y, r.w, r.h);
  itemCanvas.width = r.w; itemCanvas.height = r.h;
  const ig = itemCanvas.getContext('2d', { willReadFrequently: !canWebp });
  ig.clearRect(0, 0, r.w, r.h); ig.drawImage(bmp, 0, 0); if (bmp.close) bmp.close();
  const b = await canvasToWebp(itemCanvas, q), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
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
    if (!canWebp) { status('Cargando codificador WebP…'); await loadWasmEncoder(); }
    status('Extrayendo cuadros… 0%');
    const frames = await grabFrames(start, dur, fps, p => status(`Extrayendo cuadros (${+fps.toFixed(2)} fps)… ${Math.round(p * 100)}%`));
    const { webp, used } = await encodeBest(frames, fps, dur);
    st.last = { frames, fps, dur, mode, base: `${st.name}_${start.toFixed(1)}s` };
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
  // En el celular: compartir directo a WhatsApp u otra app
  const share = [new File([webp], base + '.webp', { type: 'image/webp' })];
  if (mp3) share.push(new File([mp3], base + '.mp3', { type: 'audio/mpeg' }));
  const gb = document.createElement('button');
  gb.className = 'btn'; gb.textContent = `↓ ${base}.gif  ·  GIF animado (para ver o compartir como GIF)`;
  gb.onclick = () => downloadGif(gb);
  setTimeout(() => $('files').appendChild(gb));
  const sb = $('shareBtn');
  if (navigator.canShare && navigator.canShare({ files: share })) {
    sb.style.display = ''; sb.onclick = () => navigator.share({ files: share }).catch(() => {});
  } else sb.style.display = 'none';
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

// ================= GIF (para ver la animación en cualquier galería) =================
let gifLib = null;
async function downloadGif(btn) {
  const L = st.last; if (!L) return;
  const label = btn.textContent; btn.disabled = true;
  try {
    gifLib = gifLib || await import('https://cdn.jsdelivr.net/npm/gifenc@1.0.3/dist/gifenc.esm.js');
    const { GIFEncoder, quantize, applyPalette } = gifLib;
    // los navegadores ignoran demoras < 20 ms en GIF: a 60 fps se toma 1 de cada 2 cuadros
    const step = Math.max(1, Math.ceil(L.fps * 0.02 - 1e-9)), alpha = L.mode === 'fit';
    const idx = []; for (let i = 0; i < L.frames.length; i += step) idx.push(i);
    const cv = document.createElement('canvas'); cv.width = cv.height = SIZE;
    const g = cv.getContext('2d', { willReadFrequently: true });
    const gif = GIFEncoder();
    const r10 = ms => Math.round(ms / 10) * 10; // GIF guarda centésimas de segundo
    for (let k = 0; k < idx.length; k++) {
      const bmp = await createImageBitmap(L.frames[idx[k]].blob);
      g.clearRect(0, 0, SIZE, SIZE); g.drawImage(bmp, 0, 0); if (bmp.close) bmp.close();
      const data = g.getImageData(0, 0, SIZE, SIZE).data;
      const palette = alpha ? quantize(data, 256, { format: 'rgba4444', oneBitAlpha: true }) : quantize(data, 256);
      const index = applyPalette(data, palette, alpha ? 'rgba4444' : 'rgb565');
      const t0 = idx[k] * 1000 / L.fps, t1 = k + 1 < idx.length ? idx[k + 1] * 1000 / L.fps : L.dur * 1000;
      const opts = { palette, delay: Math.max(20, r10(t1) - r10(t0)) };
      if (alpha) { const ti = palette.findIndex(c => c[3] === 0); if (ti >= 0) Object.assign(opts, { transparent: true, transparentIndex: ti, dispose: 2 }); }
      gif.writeFrame(index, SIZE, SIZE, opts);
      btn.textContent = `Creando GIF… ${Math.round((k + 1) / idx.length * 100)}%`;
      if (k % 5 === 4) await new Promise(res => setTimeout(res)); // deja respirar la interfaz
    }
    gif.finish();
    const blob = new Blob([gif.bytes()], { type: 'image/gif' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = L.base + '.gif';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    btn.textContent = label + `  ·  ${(blob.size / 1024).toFixed(0)} KB`;
  } catch (e) { console.error(e); btn.textContent = 'No se pudo crear el GIF: ' + (e.message || e); }
  btn.disabled = false;
}
