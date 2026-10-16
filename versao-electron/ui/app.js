// `api` é exposto pelo preload.js (window.api).

const state = {
  hw: null,
  video: null,
  goal: "speed",
  codec: "h264",
  bench: null,
  selectedId: null,
  converting: false,
};

const $ = (id) => document.getElementById(id);
const VIDEO_EXT = ["mp4", "mov", "mkv", "avi", "webm", "m4v", "mts", "m2ts", "wmv", "flv", "mpg", "mpeg", "ts", "3gp"];
const CODEC_NAMES = { h264: "H.264", hevc: "H.265", av1: "AV1" };

// ---------- formatação ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const dec = (x, n = 1) => Number(x).toLocaleString("pt-BR", { minimumFractionDigits: n, maximumFractionDigits: n });

function fmtDur(s) {
  if (s == null || s < 0 || !isFinite(s)) return "—";
  s = Math.max(1, Math.round(s));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
  return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")} min`;
}

function fmtBytes(b) {
  const mb = b / 1048576;
  return mb >= 1024 ? `${dec(mb / 1024, 2)} GB` : `${dec(mb, 1)} MB`;
}

function qualityLabel(ssim) {
  if (ssim >= 0.99) return "Excelente";
  if (ssim >= 0.98) return "Muito boa";
  if (ssim >= 0.95) return "Boa";
  if (ssim > 0) return "Perda visível";
  return "Não medida";
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 6000);
}

// ---------- 1. hardware ----------
async function detectHardware() {
  try {
    state.hw = await api.detectHardware();
    renderHardware();
  } catch (e) {
    $("hw-body").innerHTML = `<ul class="warnings"><li>${esc(e)}</li></ul>`;
  }
}

function renderHardware() {
  const hw = state.hw;
  $("ffmpeg-version").textContent = `FFmpeg ${hw.ffmpegVersion}`;
  const gpus = hw.gpus.length
    ? hw.gpus.map((g) => `<div class="value">${esc(g.name)}</div>`).join("")
    : `<div class="value muted">Nenhuma GPU encontrada</div>`;

  const rows = ["h264", "hevc", "av1"].map((codec) => {
    const encs = hw.encoders.filter((e) => e.codec === codec);
    // Mostra só os de GPU que existem na máquina (ou que funcionaram), para não poluir.
    const vendors = new Set(hw.gpus.map((g) => g.vendor));
    const shown = encs.filter((e) => e.device === "cpu" || e.available || vendors.has(e.vendor));
    const chips = shown
      .map((e) => `<span class="chip ${e.available ? "on" : "off"} ${e.device}" title="${esc(e.name)}">${esc(e.label)}</span>`)
      .join("");
    return `<div class="codec-name">${CODEC_NAMES[codec]}</div><div class="chips">${chips}</div>`;
  });

  $("hw-body").innerHTML = `
    <div class="hw-grid">
      <div class="hw-item"><div class="label">Processador (CPU)</div><div class="value">${esc(hw.cpuName)}</div><div class="muted">${hw.cpuThreads} threads</div></div>
      <div class="hw-item"><div class="label">Placa de vídeo (GPU)</div>${gpus}</div>
    </div>
    <div class="enc-table">${rows.join("")}</div>`;

  // Desabilita formatos sem nenhum codificador funcionando.
  for (const opt of $("codec").options) {
    const ok = hw.encoders.some((e) => e.codec === opt.value && e.available);
    opt.disabled = !ok;
    if (!ok) opt.textContent += " (indisponível)";
  }
}

// ---------- 2. vídeo ----------
async function pickFile() {
  if (state.converting) return;
  const path = await api.openVideo(VIDEO_EXT);
  if (path) loadVideo(path);
}

async function loadVideo(path) {
  if (state.converting) return;
  const body = $("video-body");
  body.hidden = false;
  body.innerHTML = `<div class="loading video-info"><span class="spinner"></span> Analisando o arquivo e testando a leitura pela GPU…</div>`;
  resetBench();
  $("goal-card").hidden = true;
  $("conv-card").hidden = true;
  try {
    state.video = await api.analyzeVideo(path);
    $("out-path").value = await api.defaultOutputPath(path);
    renderVideo();
    $("drop").classList.add("compact");
    $("goal-card").hidden = false;
  } catch (e) {
    state.video = null;
    body.innerHTML = `<ul class="warnings video-info"><li>${esc(e)}</li></ul>`;
  }
}

function renderVideo() {
  const v = state.video;
  const facts = [
    ["Resolução", `${v.width}×${v.height}`],
    ["Quadros por segundo", dec(v.fps, v.fps % 1 ? 2 : 0)],
    ["Duração", fmtDur(v.duration)],
    ["Formato", `${v.codec.toUpperCase()}${v.profile ? " · " + v.profile : ""}`],
    ["Cor", `${v.bitDepth}-bit ${v.chroma}`],
    ["Tamanho", fmtBytes(v.sizeBytes)],
    ["Taxa de bits", v.bitrateKbps ? `${dec(v.bitrateKbps / 1000, 1)} Mb/s` : "—"],
    ["Áudio", v.audioCodec ? v.audioCodec.toUpperCase() : "Sem áudio"],
  ];
  const badge = v.hwDecode
    ? `<span class="decode-badge yes">✓ A GPU consegue ler este vídeo</span>`
    : `<span class="decode-badge no">! A GPU não lê este formato: a CPU fará a leitura</span>`;
  const warns = v.warnings.length ? `<ul class="warnings">${v.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : "";
  $("video-body").innerHTML = `
    <div class="video-info">
      <div class="file-name">${esc(v.fileName)}</div>
      <div class="facts">${facts.map(([l, val]) => `<div class="fact"><div class="label">${l}</div><div class="value">${esc(val)}</div></div>`).join("")}</div>
      ${badge}
      ${warns}
    </div>`;
}

// ---------- 3. objetivo ----------
function selectGoal(goal) {
  state.goal = goal;
  document.querySelectorAll(".goal").forEach((b) => {
    const on = b.dataset.goal === goal;
    b.classList.toggle("selected", on);
    b.setAttribute("aria-checked", on);
  });
  resetBench();
}

function resetBench() {
  state.bench = null;
  state.selectedId = null;
  $("bench-card").hidden = true;
  $("conv-card").hidden = true;
  $("conv-result").innerHTML = "";
}

// ---------- 4. benchmark ----------
async function analyze() {
  if (!state.video || !state.hw) return;
  resetBench();
  $("bench-card").hidden = false;
  $("bench-body").innerHTML = "";
  $("bench-progress").hidden = false;
  $("bench-bar").style.width = "3%";
  $("bench-label").textContent = "Preparando o teste…";
  $("analyze").disabled = true;
  $("bench-card").scrollIntoView({ behavior: "smooth", block: "start" });
  try {
    state.bench = await api.runBenchmark({ video: state.video, codec: state.codec, goal: state.goal });
    state.selectedId = state.bench.options.find((o) => o.recommended)?.id ?? state.bench.options[0].id;
    renderBench();
    $("conv-card").hidden = false;
    updateConvertHint();
  } catch (e) {
    $("bench-body").innerHTML = `<ul class="warnings"><li>${esc(e)}</li></ul>`;
  } finally {
    $("bench-progress").hidden = true;
    $("analyze").disabled = false;
  }
}

function renderBench() {
  const b = state.bench;
  const maxFps = Math.max(...b.options.map((o) => o.fps));
  const kindTag = { gpu: "GPU", cpu: "CPU", hybrid: "GPU + CPU" };
  const cards = b.options.map((o) => {
    const reasons = o.reasons.length ? `<ul class="reasons">${o.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : "";
    return `
      <div class="opt ${o.recommended ? "recommended" : ""} ${o.eligible ? "" : "ineligible"} ${o.id === state.selectedId ? "selected" : ""}" data-id="${esc(o.id)}">
        <div class="opt-head">
          <input type="radio" name="opt" ${o.id === state.selectedId ? "checked" : ""} aria-label="${esc(o.title)}">
          <span class="opt-title">${esc(o.title)}</span>
          <span class="tag ${o.kind}">${kindTag[o.kind]}</span>
          ${o.recommended ? `<span class="tag rec">Recomendado</span>` : ""}
          ${!o.eligible ? `<span class="tag">Não compensa</span>` : ""}
          <div class="opt-detail">${esc(o.detail)}</div>
        </div>
        <div class="metrics">
          <div class="metric"><div class="label">Tempo estimado</div><div class="value">${fmtDur(o.estSeconds)}</div><div class="sub">${dec(o.fps, 0)} quadros/s</div></div>
          <div class="metric"><div class="label">Velocidade</div><div class="value">${dec(o.speedX, 1)}×</div><div class="speedbar"><div style="width:${(o.fps / maxFps) * 100}%"></div></div></div>
          <div class="metric"><div class="label">Qualidade</div><div class="value">${qualityLabel(o.ssim)}</div><div class="sub">SSIM ${dec(o.ssim, 4)}</div></div>
          <div class="metric"><div class="label">Tamanho estimado</div><div class="value">${fmtBytes(o.estBytes)}</div><div class="sub">${state.video.sizeBytes ? `${dec((o.estBytes / state.video.sizeBytes) * 100, 0)}% do original` : ""}</div></div>
        </div>
        ${reasons}
      </div>`;
  });
  const notes = b.notes.length ? `<div class="notes">${b.notes.map((n) => `<p>ℹ ${esc(n)}</p>`).join("")}</div>` : "";
  $("bench-body").innerHTML = `
    <div class="summary">${esc(b.summary)}</div>
    <div class="options">${cards.join("")}</div>
    ${notes}
    <p class="muted small">Teste feito com ${dec(b.sampleSeconds, 0)} s do meio do seu vídeo. Você pode escolher outra opção clicando nela.</p>`;
}

function selectOption(id) {
  if (state.converting) return;
  state.selectedId = id;
  document.querySelectorAll(".opt").forEach((el) => {
    const on = el.dataset.id === id;
    el.classList.toggle("selected", on);
    el.querySelector("input").checked = on;
  });
  updateConvertHint();
}

function selectedOption() {
  return state.bench?.options.find((o) => o.id === state.selectedId);
}

function updateConvertHint() {
  const o = selectedOption();
  if (!o) return;
  $("convert-hint").textContent = `${o.title} · ~${fmtDur(o.estSeconds)} · ~${fmtBytes(o.estBytes)}`;
}

// ---------- 5. conversão ----------
async function chooseOutput() {
  const path = await api.chooseOutput($("out-path").value);
  if (path) $("out-path").value = path.toLowerCase().endsWith(".mp4") ? path : `${path}.mp4`;
}

async function convert() {
  const option = selectedOption();
  const outPath = $("out-path").value.trim();
  if (!option || !outPath) return;
  setConverting(true);
  $("conv-result").innerHTML = "";
  $("conv-bar").style.width = "0%";
  $("conv-pct").textContent = "0%";
  $("conv-stage").textContent = "Iniciando";
  $("conv-fps").textContent = "";
  $("conv-eta").textContent = "";
  try {
    await api.startConversion({ video: state.video, option, goal: state.goal, outPath });
  } catch (e) {
    setConverting(false);
    showError(e);
  }
}

function setConverting(on) {
  state.converting = on;
  $("conv-progress").hidden = !on;
  $("convert").disabled = on;
  $("analyze").disabled = on;
  $("choose-out").disabled = on;
  $("out-path").disabled = on;
}

function showError(msg) {
  $("conv-result").innerHTML = `<div class="result error"><h3>Não foi possível concluir</h3><div>${esc(msg)}</div></div>`;
}

function onProgress(p) {
  $("conv-bar").style.width = `${p.percent}%`;
  $("conv-pct").textContent = `${Math.floor(p.percent)}%`;
  $("conv-stage").textContent = p.stage;
  $("conv-fps").textContent = p.fps > 0 ? `${dec(p.fps, 0)} quadros/s` : "";
  $("conv-eta").textContent = p.eta >= 0 ? `faltam ~${fmtDur(p.eta)}` : "";
}

function onDone(d) {
  setConverting(false);
  const v = state.video;
  const diff = d.seconds / d.estSeconds - 1;
  const precision = Math.abs(diff) < 0.15 ? "a estimativa acertou" : diff > 0 ? `${dec(diff * 100, 0)}% mais lento que o estimado` : `${dec(-diff * 100, 0)}% mais rápido que o estimado`;
  $("conv-result").innerHTML = `
    <div class="result">
      <h3>✓ Vídeo convertido</h3>
      <div class="result-facts">
        <div><span>Tempo</span><strong>${fmtDur(d.seconds)}</strong></div>
        <div><span>Estimado</span><strong>${fmtDur(d.estSeconds)}</strong></div>
        <div><span>Tamanho final</span><strong>${fmtBytes(d.bytes)}</strong></div>
        <div><span>Comparado ao original</span><strong>${v.sizeBytes ? dec((d.bytes / v.sizeBytes) * 100, 0) + "%" : "—"}</strong></div>
      </div>
      <div class="muted">${esc(d.outPath)} · ${precision}</div>
      <div><button class="ghost" id="reveal">Mostrar na pasta</button></div>
    </div>`;
  $("reveal").onclick = () => api.revealInFolder(d.outPath);
  // Próxima conversão não sobrescreve esta.
  api.defaultOutputPath(v.path).then((p) => ($("out-path").value = p));
}

function onError(msg) {
  setConverting(false);
  showError(msg);
}

// ---------- eventos ----------
function wire() {
  $("drop").addEventListener("click", pickFile);
  $("drop").addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && pickFile());
  document.querySelectorAll(".goal").forEach((b) => b.addEventListener("click", () => selectGoal(b.dataset.goal)));
  $("codec").addEventListener("change", (e) => {
    state.codec = e.target.value;
    resetBench();
  });
  $("analyze").addEventListener("click", analyze);
  $("bench-body").addEventListener("click", (e) => {
    const card = e.target.closest(".opt");
    if (card) selectOption(card.dataset.id);
  });
  $("choose-out").addEventListener("click", chooseOutput);
  $("convert").addEventListener("click", convert);
  $("cancel").addEventListener("click", () => api.cancelConversion());

  api.on("benchmark-progress", (p) => {
    $("bench-bar").style.width = `${(p.step / p.total) * 100 - 5}%`;
    $("bench-label").textContent = p.label;
  });
  api.on("conversion-progress", onProgress);
  api.on("conversion-done", onDone);
  api.on("conversion-error", onError);

  // Arrastar e soltar em qualquer lugar da janela.
  const drop = $("drop");
  const dropPath = (path) => {
    const ext = path.split(".").pop().toLowerCase();
    if (VIDEO_EXT.includes(ext)) loadVideo(path);
    else toast("Esse arquivo não parece ser um vídeo.");
  };
  if (api.onFileDrop) {
    // Tauri: a própria janela entrega o caminho do arquivo.
    api.onFileDrop((type, path) => {
      drop.classList.toggle("over", type === "over");
      if (type === "drop") dropPath(path);
    });
    return;
  }
  // Electron: eventos HTML normais de arrastar e soltar.
  document.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("over");
  });
  document.addEventListener("dragleave", (e) => {
    if (!e.relatedTarget) drop.classList.remove("over");
  });
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    const file = e.dataTransfer.files[0];
    if (file) dropPath(api.pathForFile(file));
  });
}

wire();
detectHardware();
