// Mini-benchmark: codifica um trecho curto do próprio vídeo com cada opção disponível,
// mede tempo, qualidade (SSIM) e tamanho, e testa GPU + CPU trabalhando ao mesmo tempo.
// A recomendação nasce de medição real nesta máquina, não de uma tabela fixa.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");
const ffmpeg = require("./ffmpeg");
const encoders = require("./encoders");
const recommend = require("./recommend");

const SAMPLE_SECONDS = 5;
const AUDIO_KBPS = 192;

async function run(hw, video, codec, goal, onProgress = () => {}) {
  const candidates = hw.encoders
    .filter((e) => e.available && e.codec === codec)
    .map((e) => encoders.find(e.name))
    .filter(Boolean);
  if (!candidates.length) throw new Error("Nenhum codificador disponível para este formato nesta máquina.");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smartrender-teste-"));
  try {
    return await runIn(tmp, candidates, video, codec, goal, onProgress);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function runIn(tmp, candidates, video, codec, goal, onProgress) {
  const wanted = Math.min(video.duration, SAMPLE_SECONDS);
  // Trecho do meio do vídeo: o começo costuma ter tela preta ou vinheta, o que distorce o teste.
  const start = await keyframeNear(video, Math.max(0, (video.duration - wanted) / 2), wanted);
  const sample = { start, len: Math.min(wanted, video.duration - start) };
  const len = sample.len;
  const has = (d) => candidates.some((e) => e.device === d);
  // AV1 fica de fora do modo híbrido: juntar trechos AV1 de codificadores diferentes ainda não é confiável.
  const hybridPossible = has("cpu") && has("gpu") && codec !== "av1";
  const total = candidates.length + (hybridPossible ? 1 : 0);

  const notes = [];
  if (!has("gpu")) notes.push("Nenhuma GPU com codificador para este formato foi encontrada: só a CPU foi testada.");
  if (codec === "av1" && has("gpu") && has("cpu")) notes.push("O modo GPU + CPU juntas ainda não está disponível para AV1.");

  const singles = [];
  for (const [i, e] of candidates.entries()) {
    onProgress({ step: i + 1, total, label: `Testando ${e.label} (${i + 1} de ${total})` });
    const out = path.join(tmp, `${e.name}.mp4`);
    try {
      const run = await encodeSample(video, sample, e, goal, out);
      const fps = steadyFps(run);
      const { ssim, db } = (await measureSsim(out, video, sample)) || { ssim: 0, db: 0 };
      singles.push({ enc: e, fps, overhead: fixedCost(run, fps), ssim, db, bytes: fs.statSync(out).size });
    } catch (err) {
      notes.push(`${e.label} falhou neste vídeo e foi descartado (${err.message}).`);
    }
  }
  if (!singles.length) throw new Error("Nenhum codificador conseguiu processar este vídeo.");

  const audioBytes = video.audioCodec ? ((AUDIO_KBPS * 1000) / 8) * video.duration : 0;
  const options = singles.map((s) => singleOption(s, video, sample, audioBytes));

  if (hybridPossible) {
    const gpu = singles.filter((s) => s.enc.device === "gpu").sort((a, b) => b.fps - a.fps)[0];
    const cpu = singles.find((s) => s.enc.device === "cpu");
    if (gpu && cpu) {
      onProgress({ step: total, total, label: "Testando GPU + CPU trabalhando ao mesmo tempo" });
      try {
        const [rg, rc] = await Promise.all([
          encodeSample(video, sample, gpu.enc, goal, path.join(tmp, "hibrido_gpu.mp4")),
          encodeSample(video, sample, cpu.enc, goal, path.join(tmp, "hibrido_cpu.mp4")),
        ]);
        // Só vale a janela em que os dois estavam codificando ao mesmo tempo: quando um termina,
        // o outro fica sozinho e acelera, o que inflaria o resultado.
        const from = Math.max(firstFrameTime(rg), firstFrameTime(rc));
        const to = Math.min(rg.secs, rc.secs);
        const fg = steadyFps(rg, from, to);
        const fc = steadyFps(rc, from, to);
        const overhead = Math.max(fixedCost(rg, steadyFps(rg)), fixedCost(rc, steadyFps(rc)));
        options.push(hybridOption(gpu, cpu, fg, fc, overhead, video, sample, audioBytes));
      } catch (err) {
        notes.push(`O teste com GPU + CPU juntas falhou (${err.message}).`);
      }
    }
  }

  const integrated = options.some((o) => o.gpuEncoder?.endsWith("_qsv"));
  const summary = recommend.rank(options, goal, integrated);
  options.sort((a, b) => b.recommended - a.recommended || b.score - a.score);
  return { sampleSeconds: len, options, summary, notes };
}

/**
 * Primeiro quadro-chave a partir de `t`. Começar o trecho num quadro-chave evita que o FFmpeg
 * decodifique (e descarte) vários segundos antes do ponto pedido — um custo que só existe no
 * teste e que deixaria a estimativa do vídeo inteiro errada.
 */
async function keyframeNear(video, t, len) {
  const r = await ffmpeg.run("ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey",
    "-read_intervals", `${t.toFixed(3)}%+${Math.max(20, len * 4)}`,
    "-show_entries", "frame=pts_time", "-of", "csv=p=0", video.path,
  ]);
  const kfs = r.stdout.split(/\r?\n/).map(parseFloat).filter(Number.isFinite);
  const fits = (k) => k + Math.min(len, 1) <= video.duration;
  return kfs.find((k) => k >= t && fits(k)) ?? kfs.filter((k) => k < t).pop() ?? 0;
}

/**
 * Codifica o trecho registrando a linha do tempo (segundos desde o início → quadros prontos).
 * Num trecho curto, abrir o arquivo e inicializar o codificador (principalmente o da GPU)
 * pesa muito; separar esse custo fixo da velocidade "em regime" é o que deixa a estimativa
 * do vídeo inteiro correta.
 */
function encodeSample(video, sample, e, goal, out) {
  const a = [
    "-y", "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1", "-stats_period", "0.1",
    ...encoders.decodeArgs(video.hwDecode),
    "-ss", sample.start.toFixed(3), "-t", sample.len.toFixed(3), "-i", video.path,
    "-map", "0:v:0", "-an",
    ...encoders.videoArgs(e, goal, true),
    out,
  ];
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const now = () => (performance.now() - t0) / 1000;
    const timeline = [];
    const child = spawn("ffmpeg", a, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      if (line.startsWith("frame=")) timeline.push({ t: now(), frame: parseInt(line.slice(6), 10) || 0 });
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(ffmpeg.lastErrorLine(stderr)));
      const secs = now();
      const frames = timeline.length ? timeline[timeline.length - 1].frame : 0;
      timeline.push({ t: secs, frame: frames });
      resolve({ secs, frames, timeline });
    });
  });
}

/** Quadros prontos no instante t (interpolando entre dois relatórios do FFmpeg). */
function frameAt(timeline, t) {
  let prev = { t: 0, frame: 0 };
  for (const p of timeline) {
    if (p.t >= t) {
      const span = p.t - prev.t;
      return span > 0 ? prev.frame + ((p.frame - prev.frame) * (t - prev.t)) / span : p.frame;
    }
    prev = p;
  }
  return prev.frame;
}

const firstFrameTime = (run) => (run.timeline.find((p) => p.frame > 0) || { t: run.secs }).t;

/** Velocidade em regime (quadros/s) dentro de uma janela de tempo, ou da execução inteira. */
function steadyFps(run, from = firstFrameTime(run), to = run.secs) {
  if (to - from < 0.4) return run.frames / run.secs;
  return (frameAt(run.timeline, to) - frameAt(run.timeline, from)) / (to - from);
}

/** Custo fixo (abrir arquivo, iniciar o codificador, finalizar) que não depende da duração. */
const fixedCost = (run, fps) => Math.max(0, run.secs - run.frames / fps);

/** SSIM entre o trecho codificado e o original (1,0 = idêntico). */
async function measureSsim(encoded, video, sample) {
  const a = [
    "-hide_banner", "-nostats",
    "-i", encoded,
    "-ss", sample.start.toFixed(3), "-t", sample.len.toFixed(3), "-i", video.path,
    "-lavfi", "[0:v]format=yuv420p,setpts=PTS-STARTPTS[a];[1:v]format=yuv420p,setpts=PTS-STARTPTS[b];[a][b]ssim",
    "-f", "null", "-",
  ];
  const r = await ffmpeg.run("ffmpeg", a);
  const m = r.stderr.match(/SSIM Y:.*All:([\d.]+)\s*\(([\d.]+|inf)\)/);
  if (!m) return null;
  return { ssim: parseFloat(m[1]), db: m[2] === "inf" ? 99 : parseFloat(m[2]) };
}

function singleOption(s, video, sample, audioBytes) {
  const gpu = s.enc.device === "gpu";
  const fps = s.fps;
  const detail = gpu
    ? video.hwDecode ? "Leitura e codificação na GPU" : "Leitura na CPU · codificação na GPU"
    : video.hwDecode ? "Leitura na GPU · codificação na CPU" : "Tudo na CPU";
  return {
    id: s.enc.name,
    kind: gpu ? "gpu" : "cpu",
    title: s.enc.label,
    detail,
    gpuEncoder: gpu ? s.enc.name : null,
    cpuEncoder: gpu ? null : s.enc.name,
    gpuShare: gpu ? 1 : 0,
    hwDecode: video.hwDecode,
    fps,
    speedX: fps / video.fps,
    ssim: s.ssim,
    ssimDb: s.db,
    estSeconds: s.overhead + (video.duration * video.fps) / fps,
    estBytes: Math.round((s.bytes / sample.len) * video.duration + audioBytes),
    score: 0,
    recommended: false,
    eligible: true,
    reasons: [],
  };
}

/** Tempo para separar o áudio e juntar as duas partes no final (cópia, sem recodificar). */
const HYBRID_MERGE_SECONDS = 0.5;

/**
 * GPU e CPU rodaram ao mesmo tempo, então as velocidades medidas já incluem a disputa
 * por energia, memória e temperatura — exatamente o que acontece no modo híbrido real.
 */
function hybridOption(g, c, fg, fc, overhead, video, sample, audioBytes) {
  const fps = fg + fc;
  // Cada um recebe uma fatia proporcional à sua velocidade, para os dois terminarem juntos.
  const share = fg / fps;
  const mix = (a, b) => share * a + (1 - share) * b;
  return {
    id: "hybrid",
    kind: "hybrid",
    title: "GPU + CPU ao mesmo tempo",
    detail: `${Math.round(share * 100)}% do vídeo em ${g.enc.label} + ${Math.round((1 - share) * 100)}% em ${c.enc.label}`,
    gpuEncoder: g.enc.name,
    cpuEncoder: c.enc.name,
    gpuShare: share,
    hwDecode: video.hwDecode,
    fps,
    speedX: fps / video.fps,
    ssim: mix(g.ssim, c.ssim),
    ssimDb: mix(g.db, c.db),
    estSeconds: overhead + (video.duration * video.fps) / fps + HYBRID_MERGE_SECONDS,
    estBytes: Math.round((mix(g.bytes, c.bytes) / sample.len) * video.duration + audioBytes),
    score: 0,
    recommended: false,
    eligible: true,
    reasons: [],
  };
}

module.exports = { run };
