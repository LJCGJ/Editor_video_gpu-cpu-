// Conversão do vídeo inteiro com a opção escolhida, com progresso e cancelamento.
//
// Modo híbrido: o vídeo é dividido em duas partes proporcionais à velocidade medida de cada
// codificador. GPU e CPU codificam suas partes ao mesmo tempo (em MPEG-TS, que carrega os
// parâmetros do codec em cada trecho), o áudio é extraído uma vez só, e no final tudo é
// juntado em um MP4 sem recodificar.

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");
const ffmpeg = require("./ffmpeg");
const encoders = require("./encoders");
const join = require("./join");
const paths = require("./paths");

const CANCELLED = "Conversão cancelada.";
const BASE_ARGS = ["-y", "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1"];

class Converter {
  /** @param {(event: string, payload: any) => void} emit */
  constructor(emit) {
    this.emit = emit;
    this.running = new Set();
    this.cancelled = false;
    this.busy = false;
  }

  start(video, option, goal, outPath) {
    // No modo híbrido, as duas partes ficam na pasta de trabalho até serem juntadas.
    const tempBytes = option.kind === "hybrid" ? option.estBytes : 0;
    this.launch([video.path], outPath, option, tempBytes, (started, out) =>
      option.kind === "hybrid"
        ? this.hybrid(video, option, goal, out, started)
        : this.single(video, option, goal, out, started)
    );
  }

  /** Junta vários vídeos seguindo o plano de join.plan(). */
  startJoin(clips, plan, goal, outPath) {
    this.launch(clips.map((c) => c.path), outPath, plan, 0, (started, out) => this.join(clips, plan, goal, out, started));
  }

  /**
   * Roda um trabalho com controle de "ocupado", cancelamento e eventos de fim/erro.
   *
   * O FFmpeg grava em "<nome>.mp4.parcial" e o arquivo só ganha o nome final quando termina
   * com sucesso. Assim, se o processo for interrompido (app fechado, computador desligado),
   * o que sobra tem cara de incompleto, e nunca de vídeo pronto que não abre.
   */
  launch(inputs, outPath, estimate, tempBytes, job) {
    if (this.busy) throw new Error("Já existe uma conversão em andamento.");
    if (inputs.some((p) => path.resolve(outPath) === path.resolve(p))) {
      throw new Error("O arquivo de saída não pode ser o mesmo de um dos originais.");
    }
    this.checkSpace(outPath, estimate.estBytes, tempBytes);
    const partial = partialPath(outPath);
    this.busy = true;
    this.cancelled = false;
    const started = performance.now();

    job(started, partial)
      .then(() => {
        fs.renameSync(partial, outPath);
        this.emit("conversion-done", {
          outPath,
          bytes: fs.statSync(outPath).size,
          seconds: (performance.now() - started) / 1000,
          estSeconds: estimate.estSeconds,
          estBytes: estimate.estBytes,
        });
      })
      .catch((e) => {
        // Apaga o arquivo incompleto; se ele ainda estiver preso, não esconde o erro original.
        try {
          fs.rmSync(partial, { force: true, maxRetries: 5, retryDelay: 300 });
        } catch {
          // Fica para trás com a extensão .parcial, que já deixa claro que não é um vídeo pronto.
        }
        this.emit("conversion-error", e.message);
      })
      .finally(() => {
        this.running.clear();
        this.busy = false;
      });
  }

  /**
   * Confere o espaço livre antes de começar: o vídeo final (com 10% de folga) no disco de saída
   * e, no modo híbrido, as partes temporárias no disco de trabalho.
   */
  checkSpace(outPath, estBytes, tempBytes) {
    const outDir = path.dirname(path.resolve(outPath));
    fs.mkdirSync(outDir, { recursive: true });
    const margin = 100 * 1048576;
    const work = paths.workDir();
    const sameDrive = paths.driveOf(outDir) === paths.driveOf(work);
    paths.ensureSpace(outDir, estBytes * 1.1 + margin + (sameDrive ? tempBytes : 0), "salvar o vídeo");
    if (tempBytes && !sameDrive) paths.ensureSpace(work, tempBytes + margin, "os arquivos temporários");
  }

  cancel() {
    this.cancelled = true;
    this.killRunning();
  }

  /** Espera a conversão terminar de vez (inclusive apagar o arquivo parcial), por até `ms`. */
  async whenIdle(ms = 8000) {
    const end = Date.now() + ms;
    while (this.busy && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  }

  killRunning() {
    for (const child of this.running) child.kill();
  }

  /**
   * Roda vários FFmpeg ao mesmo tempo. Se um falhar, para os outros e espera todos saírem
   * antes de devolver o erro: assim ninguém fica gravando numa pasta que está sendo apagada.
   */
  async runParallel(jobs) {
    let firstError = null;
    await Promise.allSettled(
      jobs.map((p) =>
        p.catch((e) => {
          if (!firstError) {
            firstError = e;
            this.killRunning();
          }
        })
      )
    );
    if (firstError) throw firstError;
  }

  /** Soma o progresso de vários processos FFmpeg rodando em paralelo. */
  tracker(started, duration, jobs) {
    const slots = Array.from({ length: jobs }, () => ({ t: 0, fps: 0 }));
    const send = (frac, fps, stage) => {
      const elapsed = (performance.now() - started) / 1000;
      const eta = frac > 0.01 ? elapsed / frac - elapsed : -1;
      this.emit("conversion-progress", { percent: frac * 100, fps, elapsed, eta, stage });
    };
    return {
      send,
      update(slot, t, fps) {
        slots[slot] = { t: Math.max(0, t), fps };
        const done = slots.reduce((a, s) => a + s.t, 0);
        const totalFps = slots.reduce((a, s) => a + s.fps, 0);
        send(Math.min(1, done / duration), totalFps, "Convertendo");
      },
    };
  }

  runJob(args, onTime) {
    return new Promise((resolve, reject) => {
      if (this.cancelled) return reject(new Error(CANCELLED));
      const child = spawn("ffmpeg", args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      this.running.add(child);
      let stderr = "";
      let fps = 0;
      child.stderr.on("data", (d) => (stderr += d));
      readline.createInterface({ input: child.stdout }).on("line", (line) => {
        if (line.startsWith("fps=")) fps = parseFloat(line.slice(4)) || fps;
        else if (line.startsWith("out_time_us=") && onTime) {
          const us = parseInt(line.slice(12), 10);
          if (Number.isFinite(us)) onTime(us / 1e6, fps);
        }
      });
      child.on("error", (e) => reject(new Error(`Não foi possível iniciar o FFmpeg: ${e.message}`)));
      child.on("close", (code) => {
        this.running.delete(child);
        if (this.cancelled) reject(new Error(CANCELLED));
        else if (code !== 0) reject(new Error(`O FFmpeg falhou: ${ffmpeg.lastErrorLine(stderr)}`));
        else resolve();
      });
    });
  }

  async single(video, option, goal, out, started) {
    const e = encoders.find(option.gpuEncoder || option.cpuEncoder);
    if (!e) throw new Error("Codificador desconhecido.");
    const t = this.tracker(started, video.duration, 1);
    t.send(0, 0, "Iniciando");
    await this.runJob(
      [
        ...BASE_ARGS,
        ...encoders.decodeArgs(video.hwDecode),
        "-i", video.path,
        "-map", "0:v:0", "-map", "0:a:0?",
        ...encoders.videoArgs(e, goal, true),
        ...encoders.audioArgs(video.audioCodec),
        "-movflags", "+faststart", "-f", "mp4", out,
      ],
      (secs, fps) => t.update(0, secs, fps)
    );
  }

  async join(clips, plan, goal, out, started) {
    const t = this.tracker(started, plan.totalDuration, 1);
    t.send(0, 0, plan.mode === "copy" ? "Emendando os arquivos" : "Iniciando");
    const tmp = paths.makeTemp("juncao");
    try {
      const args = plan.mode === "copy"
        ? join.copyArgs(clips, path.join(tmp, "lista.txt"), out)
        : join.encodeArgs(clips, plan, goal, out);
      await this.runJob([...BASE_ARGS, ...args], (secs, fps) => t.update(0, secs, fps));
    } finally {
      paths.removeTemp(tmp);
    }
  }

  async hybrid(video, option, goal, out, started) {
    const g = encoders.find(option.gpuEncoder);
    const c = encoders.find(option.cpuEncoder);
    if (!g || !c) throw new Error("Opção híbrida inválida.");
    const tmp = paths.makeTemp("conv");
    try {
      await this.hybridIn(video, option, goal, out, started, tmp, g, c);
    } finally {
      paths.removeTemp(tmp);
    }
  }

  async hybridIn(video, option, goal, out, started, tmp, g, c) {
    // Ponto de corte alinhado a um frame exato.
    const frame = 1 / video.fps;
    const split = Math.min(Math.max(Math.round((video.duration * option.gpuShare) / frame) * frame, frame), video.duration - frame);
    const partGpu = path.join(tmp, "parte_gpu.ts");
    const partCpu = path.join(tmp, "parte_cpu.ts");
    const audio = path.join(tmp, "audio.m4a");
    const at = split.toFixed(6);

    const t = this.tracker(started, video.duration, 2);
    t.send(0, 0, "Iniciando GPU e CPU");
    await this.runParallel([
      this.runJob(
        [...BASE_ARGS, ...encoders.decodeArgs(video.hwDecode), "-i", video.path, "-t", at,
          "-map", "0:v:0", "-an", ...encoders.videoArgs(g, goal, false), "-f", "mpegts", partGpu],
        (secs, fps) => t.update(0, secs, fps)
      ),
      this.runJob(
        [...BASE_ARGS, ...encoders.decodeArgs(video.hwDecode), "-ss", at, "-i", video.path,
          "-map", "0:v:0", "-an", ...encoders.videoArgs(c, goal, false), "-f", "mpegts", partCpu],
        (secs, fps) => t.update(1, secs, fps)
      ),
      video.audioCodec
        ? this.runJob(["-y", "-hide_banner", "-loglevel", "error", "-i", video.path, "-vn", "-map", "0:a:0",
            ...encoders.audioArgs(video.audioCodec), audio])
        : Promise.resolve(),
    ]);

    t.send(0.995, 0, "Juntando as partes");
    const esc = (p) => p.replace(/\\/g, "/").replace(/'/g, "'\\''");
    const list = path.join(tmp, "partes.txt");
    fs.writeFileSync(list, `file '${esc(partGpu)}'\nfile '${esc(partCpu)}'\n`);
    await this.runJob([
      "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list,
      ...(video.audioCodec ? ["-i", audio] : []),
      "-map", "0:v:0",
      ...(video.audioCodec ? ["-map", "1:a:0"] : []),
      "-c", "copy",
      ...(g.codec === "hevc" ? ["-tag:v", "hvc1"] : []),
      "-movflags", "+faststart", "-f", "mp4", out,
    ]);
    t.send(1, 0, "Concluído");
  }
}

/** Nome usado enquanto o vídeo ainda está sendo gravado. */
const partialPath = (outPath) => `${outPath}.parcial`;

/**
 * Sugere "<nome>_smartrender.mp4" na pasta de saída escolhida (ou ao lado do original),
 * sem sobrescrever nada que já exista.
 */
function defaultOutputPath(file, suffix = "smartrender") {
  const dir = paths.outputDir() || path.dirname(file);
  const stem = path.parse(file).name || "video";
  for (let n = 1; ; n++) {
    const candidate = path.join(dir, `${stem}_${suffix}${n === 1 ? "" : `_${n}`}.mp4`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

module.exports = { Converter, defaultOutputPath };
