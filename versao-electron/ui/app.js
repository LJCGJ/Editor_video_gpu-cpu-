// `api` é exposto pelo preload.js (window.api).

const state = {
  mode: "convert", // "convert" (um vídeo) ou "join" (juntar vários)
  hw: null,
  video: null,
  clips: [],
  loadingClips: false,
  goal: "speed",
  codec: "h264",
  bench: null,
  plan: null,
  selectedId: null,
  converting: false,
};

const $ = (id) => document.getElementById(id);
const VIDEO_EXT = ["mp4", "mov", "mkv", "avi", "webm", "m4v", "mts", "m2ts", "wmv", "flv", "mpg", "mpeg", "ts", "3gp"];
const CODEC_NAMES = { h264: "H.264", hevc: "H.265", av1: "AV1" };
const isVideo = (path) => VIDEO_EXT.includes(path.split(".").pop().toLowerCase());

/** Textos que mudam conforme o modo. */
const TEXTS = {
  convert: {
    video: "Vídeo",
    drop: "Arraste um vídeo aqui",
    analyze: "Analisar o meu vídeo",
    hint: "A análise codifica um trecho de 5 segundos do seu vídeo com cada opção disponível e mede tempo, qualidade e tamanho de verdade.",
    bench: "Resultado da análise",
    conv: "Converter",
    button: "Converter agora",
  },
  join: {
    video: "Vídeos para juntar",
    drop: "Arraste vários vídeos aqui",
    analyze: "Planejar a junção",
    hint: "Se todos os vídeos tiverem o mesmo formato, eles são emendados direto, sem perder qualidade. Se não, o app testa GPU e CPU no vídeo mais longo e escolhe a melhor forma de recodificar.",
    bench: "Plano da junção",
    conv: "Juntar",
    button: "Juntar agora",
  },
};

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
  if (state.hw) {
    // Re-detecção (outro FFmpeg): mostra o carregamento de novo.
    state.hw = null;
    $("hw-body").innerHTML = `<div class="loading"><span class="spinner"></span> Detectando os codificadores do novo FFmpeg…</div>`;
    for (const opt of $("codec").options) opt.textContent = opt.textContent.replace(" (indisponível)", "");
  }
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

// ---------- pastas ----------
const GB = 1073741824;
const gb = (b) => `${dec(b / GB, 1)} GB`;
const driveName = (p) => p.slice(0, 2).toUpperCase();

async function loadSettings() {
  if (!api.getSettings) {
    // A versão Tauri (Rust) ainda não tem as preferências de pastas.
    $("folders-card").hidden = true;
    return;
  }
  try {
    state.settings = await api.getSettings();
    renderFolders();
  } catch (e) {
    $("folders-body").innerHTML = `<ul class="warnings"><li>${esc(e)}</li></ul>`;
  }
}

/** Sugere outro disco quando o da pasta de trabalho está apertado e existe um com bem mais folga. */
function driveSuggestion(s) {
  const work = s.drives.find((d) => driveName(d.root) === driveName(s.workDir));
  const best = [...s.drives].sort((a, b) => b.free - a.free)[0];
  if (!work || !best || best.root === work.root) return null;
  const tight = work.free < 15 * GB || work.free / work.total < 0.1;
  return tight && best.free > work.free * 2 ? { from: work, to: best } : null;
}

function renderFolders() {
  const s = state.settings;
  if (!s) return;
  const lock = state.converting ? "disabled" : "";
  const sug = driveSuggestion(s);
  const base = sug ? `${sug.to.root}SmartRender` : "";
  const alert = sug
    ? `<div class="folder-alert">
         <div>⚠️ O disco <strong>${driveName(sug.from.root)}</strong> está com pouco espaço (${gb(sug.from.free)} livres).
         O disco <strong>${driveName(sug.to.root)}</strong> tem ${gb(sug.to.free)} livres.</div>
         <button class="primary" id="use-drive" data-base="${esc(base)}" ${lock}>Usar ${esc(base)} para tudo</button>
       </div>`
    : "";
  const space = (sp, p) => (sp ? `Disco ${driveName(p)} · ${gb(sp.free)} livres` : "");
  const work = s.workDirCustom ? s.workDir : `Pasta temporária do Windows (${s.workDir})`;
  const out = s.outputDir || "Na mesma pasta do vídeo original";
  $("folders-body").innerHTML = `
    ${alert}
    <div class="folder-row">
      <div class="folder-info">
        <div class="label">Arquivos temporários (teste de 5 s e modo híbrido)</div>
        <div class="folder-path">${esc(work)}</div>
        <div class="muted small-line">${space(s.workSpace, s.workDir)}</div>
      </div>
      <div class="folder-actions">
        <button class="ghost" data-folder="workDir" ${lock}>Alterar…</button>
        ${s.workDirCustom ? `<button class="ghost" data-reset="workDir" ${lock}>Usar o padrão</button>` : ""}
      </div>
    </div>
    <div class="folder-row">
      <div class="folder-info">
        <div class="label">Vídeos prontos</div>
        <div class="folder-path">${esc(out)}</div>
        <div class="muted small-line">${s.outputDir ? space(s.outputSpace, s.outputDir) : "Você também pode mudar o nome e o local em cada conversão."}</div>
      </div>
      <div class="folder-actions">
        <button class="ghost" data-folder="outputDir" ${lock}>Alterar…</button>
        ${s.outputDir ? `<button class="ghost" data-reset="outputDir" ${lock}>Mesma pasta do original</button>` : ""}
      </div>
    </div>
    ${ffmpegRow(s, lock)}
    ${dataRow(s, lock, base)}
    ${memoryAlert(s)}
    ${usagePanel(s)}`;
}

function ffmpegRow(s, lock) {
  const where = s.ffmpegPath || "Não encontrado";
  const how = s.ffmpegCustom ? "Pasta escolhida por você." : s.ffmpegBundled ? "Cópia que acompanha o programa." : "O do sistema (PATH).";
  return `
    <div class="folder-row">
      <div class="folder-info">
        <div class="label">FFmpeg</div>
        <div class="folder-path">${esc(where)}</div>
        <div class="muted small-line">${how} Ele só é lido, não grava nada no disco.</div>
      </div>
      <div class="folder-actions">
        <button class="ghost" data-folder="ffmpegDir" ${lock}>Alterar…</button>
        ${s.ffmpegCustom ? `<button class="ghost" data-reset="ffmpegDir" ${lock}>Usar o do sistema</button>` : ""}
      </div>
    </div>`;
}

function dataRow(s, lock, suggestedBase) {
  const d = s.data;
  if (!d) return "";
  const target = suggestedBase ? `${suggestedBase}\\dados` : "";
  const status = d.portable
    ? `Modo portátil ligado: nada do app fica em %APPDATA%.${d.oldDataRemoved ? " O cache antigo no C: foi apagado." : ""}`
    : "Padrão do Windows (%APPDATA%). Mover tira preferências, cache e logs do C:.";
  const error = d.error ? `<div class="small-line warn-text">${esc(d.error)}</div>` : "";
  return `
    <div class="folder-row">
      <div class="folder-info">
        <div class="label">Dados do app (preferências, cache do navegador interno, logs)</div>
        <div class="folder-path">${esc(d.dataDir)}</div>
        <div class="muted small-line">${status}</div>
        ${error}
      </div>
      <div class="folder-actions">
        ${!d.portable && target ? `<button class="primary" data-move-data="${esc(target)}" ${lock}>Mover para ${esc(target)}</button>` : ""}
        <button class="ghost" data-move-data="?" ${lock}>${d.portable ? "Mudar…" : "Mover…"}</button>
        ${d.portable ? `<button class="ghost" data-move-data="" ${lock}>Voltar ao padrão</button>` : ""}
      </div>
    </div>`;
}

function memoryAlert(s) {
  const m = s.memory;
  if (!m || !m.low) return "";
  const pf = m.pagefiles[0];
  const where = pf ? `O arquivo de paginação fica em <strong>${esc(pf.path)}</strong>${pf.diskFree != null ? `, num disco com ${gb(pf.diskFree)} livres` : ""}.` : "";
  return `
    <div class="folder-alert memory">
      <div>
        <div>⚠️ <strong>Pouca memória virtual:</strong> ${gb(m.freeVirtual)} livres. ${where}
        Com isso, codificadores de CPU podem falhar; o app já usa configurações mais econômicas.</div>
        <details class="guide">
          <summary>Como mover a memória virtual para outro disco (resolve de vez)</summary>
          <ol>
            <li>Clique em <strong>Abrir configurações</strong> ao lado (ou rode <code>SystemPropertiesPerformance</code>).</li>
            <li>Na aba <strong>Avançado</strong>, em "Memória virtual", clique em <strong>Alterar…</strong>.</li>
            <li>Desmarque <strong>"Gerenciar automaticamente o tamanho do arquivo de paginação"</strong>.</li>
            <li>Selecione o disco com espaço (ex.: <strong>D:</strong>), marque <strong>"Tamanho gerenciado pelo sistema"</strong> e clique em <strong>Definir</strong>.</li>
            <li>Selecione o <strong>C:</strong>, marque <strong>"Sem arquivo de paginação"</strong> (ou um tamanho pequeno) e clique em <strong>Definir</strong>.</li>
            <li>Clique em <strong>OK</strong> e <strong>reinicie o computador</strong>. Precisa de permissão de administrador.</li>
          </ol>
        </details>
      </div>
      <button class="ghost" id="open-memory">Abrir configurações</button>
    </div>`;
}

function usagePanel(s) {
  if (!s.usage?.length) return "";
  const onC = s.usage.filter((u) => u.onC);
  const rows = s.usage
    .map((u) => `
      <tr class="${u.onC ? "on-c" : ""}">
        <td>${u.onC ? "⚠️" : "✅"}</td>
        <td><strong>${esc(u.label)}</strong><div class="muted">${esc(u.note)}</div></td>
        <td class="mono">${esc(u.where)}</td>
      </tr>`)
    .join("");
  const summary = onC.length
    ? `${onC.length} de ${s.usage.length} itens ainda usam o C:`
    : "Nada do SmartRender usa o C:";
  return `
    <details class="usage">
      <summary>O que o SmartRender usa no disco C: <span class="pill ${onC.length ? "warn" : "ok"}">${summary}</span></summary>
      <table>${rows}</table>
    </details>`;
}

async function saveSettings(next, message) {
  if (state.converting) return;
  try {
    state.settings = await api.setSettings(next);
    renderFolders();
    updateDefaultOutput();
    toast(message);
  } catch (e) {
    toast(String(e));
  }
}

async function onFoldersClick(e) {
  const btn = e.target.closest("button");
  if (!btn || state.converting) return;
  const s = state.settings;
  if (btn.id === "use-drive") {
    const base = btn.dataset.base;
    return saveSettings({ workDir: `${base}\\temp`, outputDir: `${base}\\videos` }, `Pronto: processando e salvando em ${base}.`);
  }
  if (btn.id === "open-memory") return api.openMemorySettings();
  if (btn.dataset.moveData !== undefined) return moveData(btn.dataset.moveData);
  if (btn.dataset.reset) {
    await saveSettings({ [btn.dataset.reset]: null }, "Voltou para o padrão.");
    if (btn.dataset.reset === "ffmpegDir") detectHardware();
    return;
  }
  if (btn.dataset.folder) {
    const key = btn.dataset.folder;
    const start = { workDir: s.workDir, outputDir: s.outputDir, ffmpegDir: s.ffmpegPath && s.ffmpegPath.replace(/[\\/][^\\/]+$/, "") }[key] || undefined;
    const dir = await api.chooseFolder(start);
    if (!dir) return;
    const messages = { workDir: "Pasta de trabalho atualizada.", outputDir: "Pasta dos vídeos prontos atualizada.", ffmpegDir: "FFmpeg atualizado." };
    await saveSettings({ [key]: dir }, messages[key]);
    // Outro FFmpeg pode ter outros codificadores: detecta de novo.
    if (key === "ffmpegDir") detectHardware();
  }
}

/** Move os dados do app (modo portátil). `target`: pasta, "?" para escolher, "" para voltar ao padrão. */
async function moveData(target) {
  if (state.converting) return;
  let dir = target;
  if (target === "?") {
    dir = await api.chooseFolder(state.settings.data?.dataDir);
    if (!dir) return;
  }
  const what = dir ? `para ${dir}` : "de volta para o padrão do Windows (%APPDATA%)";
  if (!confirm(`Mover as preferências, o cache e os logs do SmartRender ${what}?\n\nO app vai reiniciar.`)) return;
  try {
    await api.moveData(dir || null);
    toast("Reiniciando o SmartRender…");
  } catch (e) {
    toast(String(e));
  }
}

// ---------- modo ----------
function setMode(mode) {
  if (state.converting || state.loadingClips || mode === state.mode) return;
  state.mode = mode;
  document.querySelectorAll(".mode").forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle("selected", on);
    b.setAttribute("aria-selected", on);
  });
  const t = TEXTS[mode];
  $("video-title").textContent = t.video;
  $("drop-title").textContent = t.drop;
  $("analyze").textContent = t.analyze;
  $("analyze-hint").textContent = t.hint;
  $("bench-title").textContent = t.bench;
  $("conv-title").textContent = t.conv;
  $("convert").textContent = t.button;
  $("video-body").hidden = mode !== "convert" || !$("video-body").innerHTML;
  $("join-body").hidden = mode !== "join" || !state.clips.length;
  $("drop").classList.toggle("compact", mode === "convert" ? !!state.video : state.clips.length > 0);
  resetBench();
  refreshGoalCard();
  updateDefaultOutput();
}

/** O passo 3 aparece quando há o que analisar: um vídeo, ou pelo menos dois para juntar. */
function refreshGoalCard() {
  $("goal-card").hidden = state.mode === "convert" ? !state.video : state.clips.length < 2;
}

async function updateDefaultOutput() {
  const first = state.mode === "convert" ? state.video : state.clips[0];
  if (first) $("out-path").value = await api.defaultOutputPath(first.path, state.mode === "join" ? "juncao" : undefined);
}

// ---------- 2. vídeo ----------
async function pickFile() {
  if (state.converting || state.loadingClips) return;
  if (state.mode === "join") {
    const paths = await api.openVideos(VIDEO_EXT);
    if (paths.length) addClips(paths);
    return;
  }
  const path = await api.openVideo(VIDEO_EXT);
  if (path) loadVideo(path);
}

// ---------- 2b. vídeos para juntar ----------
async function addClips(paths) {
  const valid = paths.filter(isVideo);
  if (valid.length < paths.length) toast("Alguns arquivos foram ignorados porque não parecem ser vídeos.");
  if (!valid.length) return;
  state.loadingClips = true;
  resetBench();
  const errors = [];
  for (const [i, path] of valid.entries()) {
    renderClips(`Analisando ${i + 1} de ${valid.length}: ${path.split(/[\\/]/).pop()}…`);
    try {
      state.clips.push(await api.analyzeVideo(path));
    } catch (e) {
      errors.push(`${path.split(/[\\/]/).pop()}: ${e}`);
    }
  }
  state.loadingClips = false;
  renderClips();
  if (errors.length) toast(`Não consegui ler: ${errors.join(" · ")}`);
  $("drop").classList.toggle("compact", state.clips.length > 0);
  refreshGoalCard();
  updateDefaultOutput();
}

function moveClip(i, delta) {
  const j = i + delta;
  if (j < 0 || j >= state.clips.length) return;
  [state.clips[i], state.clips[j]] = [state.clips[j], state.clips[i]];
  afterClipsChanged();
}

function removeClip(i) {
  state.clips.splice(i, 1);
  afterClipsChanged();
}

function afterClipsChanged() {
  resetBench();
  renderClips();
  refreshGoalCard();
  updateDefaultOutput();
  $("drop").classList.toggle("compact", state.clips.length > 0);
}

function renderClips(loading = "") {
  const body = $("join-body");
  body.hidden = !state.clips.length && !loading;
  const total = state.clips.reduce((s, c) => s + c.duration, 0);
  const locked = state.converting || state.loadingClips;
  const rows = state.clips.map((c, i) => {
    const facts = [
      `${c.width}×${c.height}`,
      `${dec(c.fps, c.fps % 1 ? 2 : 0)} fps`,
      c.codec.toUpperCase(),
      fmtDur(c.duration),
      c.audioCodec ? `áudio ${c.audioCodec.toUpperCase()}` : "sem áudio",
    ].join(" · ");
    return `
      <li class="clip">
        <span class="clip-n">${i + 1}</span>
        <div class="clip-info"><div class="clip-name">${esc(c.fileName)}</div><div class="muted">${esc(facts)}</div></div>
        <div class="clip-actions">
          <button class="icon" data-action="up" data-i="${i}" title="Subir" aria-label="Subir" ${i === 0 || locked ? "disabled" : ""}>↑</button>
          <button class="icon" data-action="down" data-i="${i}" title="Descer" aria-label="Descer" ${i === state.clips.length - 1 || locked ? "disabled" : ""}>↓</button>
          <button class="icon danger" data-action="remove" data-i="${i}" title="Remover" aria-label="Remover" ${locked ? "disabled" : ""}>✕</button>
        </div>
      </li>`;
  });
  const footer = loading
    ? `<div class="loading"><span class="spinner"></span> ${esc(loading)}</div>`
    : state.clips.length < 2
      ? `<p class="muted small">Adicione pelo menos mais um vídeo para juntar.</p>`
      : `<p class="muted small">${state.clips.length} vídeos · duração total ${fmtDur(total)}. Eles serão juntados nesta ordem; use ↑ ↓ para mudar.</p>`;
  body.innerHTML = `<ol class="clip-list">${rows.join("")}</ol>${footer}`;
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
  state.plan = null;
  state.selectedId = null;
  $("bench-card").hidden = true;
  $("conv-card").hidden = true;
  $("conv-result").innerHTML = "";
}

// ---------- 4. benchmark ----------
function startAnalysisUi(label) {
  resetBench();
  $("bench-card").hidden = false;
  $("bench-body").innerHTML = "";
  $("bench-progress").hidden = false;
  $("bench-bar").style.width = "3%";
  $("bench-label").textContent = label;
  $("analyze").disabled = true;
  $("bench-card").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function analyze() {
  if (!state.hw) return;
  if (state.mode === "join") return analyzeJoin();
  if (!state.video) return;
  startAnalysisUi("Preparando o teste…");
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

async function analyzeJoin() {
  if (state.clips.length < 2) return;
  startAnalysisUi("Comparando os formatos dos vídeos…");
  try {
    state.plan = await api.planJoin({ clips: state.clips, codec: state.codec, goal: state.goal });
    renderPlan();
    $("conv-card").hidden = false;
    $("convert-hint").textContent = `${state.plan.title} · ~${fmtDur(state.plan.estSeconds)} · ~${fmtBytes(state.plan.estBytes)}`;
  } catch (e) {
    $("bench-body").innerHTML = `<ul class="warnings"><li>${esc(e)}</li></ul>`;
  } finally {
    $("bench-progress").hidden = true;
    $("analyze").disabled = false;
  }
}

function renderPlan() {
  const p = state.plan;
  const o = p.option;
  const tag = p.mode === "copy"
    ? `<span class="tag gpu">Cópia direta</span>`
    : `<span class="tag ${o.kind}">${o.kind === "gpu" ? "GPU" : "CPU"}</span>`;
  const quality = p.mode === "copy"
    ? `<div class="value">Idêntica</div><div class="sub">sem recodificar</div>`
    : `<div class="value">${qualityLabel(o.ssim)}</div><div class="sub">SSIM ${dec(o.ssim, 4)}</div>`;
  const original = state.clips.reduce((s, c) => s + c.sizeBytes, 0);
  $("bench-body").innerHTML = `
    <div class="summary">${esc(p.summary)}</div>
    <div class="opt recommended selected">
      <div class="opt-head">
        <span class="opt-title">${esc(p.title)}</span>
        ${tag}
        <span class="tag rec">Recomendado</span>
        <div class="opt-detail plain">${o ? esc(o.detail) : "Os arquivos são emendados um depois do outro."}</div>
      </div>
      <div class="metrics">
        <div class="metric"><div class="label">Tempo estimado</div><div class="value">${fmtDur(p.estSeconds)}</div><div class="sub">${o ? `${dec(o.fps, 0)} quadros/s` : "só cópia"}</div></div>
        <div class="metric"><div class="label">Vídeo final</div><div class="value">${p.target.width}×${p.target.height}</div><div class="sub">${dec(p.target.fps, p.target.fps % 1 ? 2 : 0)} fps · ${fmtDur(p.totalDuration)}</div></div>
        <div class="metric"><div class="label">Qualidade</div>${quality}</div>
        <div class="metric"><div class="label">Tamanho estimado</div><div class="value">${fmtBytes(p.estBytes)}</div><div class="sub">${original ? `${dec((p.estBytes / original) * 100, 0)}% dos originais` : ""}</div></div>
      </div>
      <ul class="reasons">${p.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
    </div>`;
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
  const join = state.mode === "join";
  const option = selectedOption();
  const outPath = $("out-path").value.trim();
  if (!outPath || (join ? !state.plan : !option)) return;
  setConverting(true);
  $("conv-result").innerHTML = "";
  $("conv-bar").style.width = "0%";
  $("conv-pct").textContent = "0%";
  $("conv-stage").textContent = "Iniciando";
  $("conv-fps").textContent = "";
  $("conv-eta").textContent = "";
  try {
    if (join) await api.startJoin({ clips: state.clips, plan: state.plan, goal: state.goal, outPath });
    else await api.startConversion({ video: state.video, option, goal: state.goal, outPath });
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
  document.querySelectorAll(".mode").forEach((b) => (b.disabled = on));
  if (state.mode === "join") renderClips();
  renderFolders();
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
  const join = state.mode === "join";
  const original = join ? state.clips.reduce((s, c) => s + c.sizeBytes, 0) : state.video.sizeBytes;
  const diff = d.seconds / d.estSeconds - 1;
  // Trabalhos de poucos segundos variam muito em porcentagem; até 2 s de diferença conta como acerto.
  const close = Math.abs(diff) < 0.15 || Math.abs(d.seconds - d.estSeconds) < 2;
  const precision = close ? "a estimativa acertou" : diff > 0 ? `${dec(diff * 100, 0)}% mais lento que o estimado` : `${dec(-diff * 100, 0)}% mais rápido que o estimado`;
  $("conv-result").innerHTML = `
    <div class="result">
      <h3>✓ ${join ? `${state.clips.length} vídeos juntados` : "Vídeo convertido"}</h3>
      <div class="result-facts">
        <div><span>Tempo</span><strong>${fmtDur(d.seconds)}</strong></div>
        <div><span>Estimado</span><strong>${fmtDur(d.estSeconds)}</strong></div>
        <div><span>Tamanho final</span><strong>${fmtBytes(d.bytes)}</strong></div>
        <div><span>${join ? "Comparado aos originais" : "Comparado ao original"}</span><strong>${original ? dec((d.bytes / original) * 100, 0) + "%" : "—"}</strong></div>
      </div>
      <div class="muted">${esc(d.outPath)} · ${precision}</div>
      <div><button class="ghost" id="reveal">Mostrar na pasta</button></div>
    </div>`;
  $("reveal").onclick = () => api.revealInFolder(d.outPath);
  // Próxima conversão não sobrescreve esta.
  updateDefaultOutput();
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
  $("folders-body").addEventListener("click", onFoldersClick);
  $("bench-body").addEventListener("click", (e) => {
    const card = e.target.closest(".opt[data-id]");
    if (card && state.mode === "convert") selectOption(card.dataset.id);
  });
  document.querySelectorAll(".mode").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  // A versão Tauri (Rust) ainda não tem a junção: só mostra as abas se o backend oferecer.
  $("modes").hidden = !api.planJoin;
  $("join-body").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn || state.converting || state.loadingClips) return;
    const i = Number(btn.dataset.i);
    if (btn.dataset.action === "up") moveClip(i, -1);
    else if (btn.dataset.action === "down") moveClip(i, 1);
    else removeClip(i);
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
  const dropPaths = (paths) => {
    if (state.converting || state.loadingClips || !paths.length) return;
    if (state.mode === "join") return addClips(paths);
    if (isVideo(paths[0])) loadVideo(paths[0]);
    else toast("Esse arquivo não parece ser um vídeo.");
  };
  if (api.onFileDrop) {
    // Tauri: a própria janela entrega os caminhos dos arquivos.
    api.onFileDrop((type, paths) => {
      drop.classList.toggle("over", type === "over");
      if (type === "drop") dropPaths([].concat(paths));
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
    dropPaths([...e.dataTransfer.files].map((f) => api.pathForFile(f)));
  });
}

wire();
detectHardware();
loadSettings();
