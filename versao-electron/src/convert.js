// Conversão do vídeo inteiro com a opção escolhida, com progresso e cancelamento.
//
// Modo híbrido: o vídeo é dividido em duas partes proporcionais à velocidade medida de cada
// codificador. GPU e CPU codificam suas partes ao mesmo tempo (em MPEG-TS, que carrega os
// parâmetros do codec em cada trecho), o áudio é extraído uma vez só, e no final tudo é
// juntado em um MP4 sem recodificar.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");
const ffmpeg = require("./ffmpeg");
const encoders = require("./encoders");

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
    if (this.busy) throw new Error("Já existe uma conversão em andamento.");
    if (path.resolve(outPath) === path.resolve(video.path)) {
      throw new Error("O arquivo de saída não pode ser o mesmo do original.");
    }
    this.busy = true;
    this.cancelled = false;
    const started = performance.now();
    const job = option.kind === "hybrid"
      ? this.hybrid(video, option, goal, outPath, started)
      : this.single(video, option, goal, outPath, started);

    job
      .then(() => {
        this.emit("conversion-done", {
          outPath,
          bytes: fs.statSync(outPath).size,
          seconds: (performance.now() - started) / 1000,
          estSeconds: option.estSeconds,
          estBytes: option.estBytes,
        });
      })
      .catch((e) => {
        fs.rmSync(outPath, { force: true });
        this.emit("conversion-error", e.message);
      })
      .finally(() => {
        this.running.clear();
        this.busy = false;
      });
  }

  cancel() {
    this.cancelled = true;
    for (const child of this.running) child.kill();
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
        "-movflags", "+faststart", out,
      ],
      (secs, fps) => t.update(0, secs, fps)
    );
  }

  async hybrid(video, option, goal, out, started) {
    const g = encoders.find(option.gpuEncoder);
    const c = encoders.find(option.cpuEncoder);
    if (!g || !c) throw new Error("Opção híbrida inválida.");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smartrender-conv-"));
    try {
      await this.hybridIn(video, option, goal, out, started, tmp, g, c);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
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
    await Promise.all([
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
      "-movflags", "+faststart", out,
    ]);
    t.send(1, 0, "Concluído");
  }
}

/** Sugere "<nome>_smartrender.mp4" na mesma pasta, sem sobrescrever nada que já exista. */
function defaultOutputPath(file) {
  const dir = path.dirname(file);
  const stem = path.parse(file).name || "video";
  for (let n = 1; ; n++) {
    const candidate = path.join(dir, `${stem}_smartrender${n === 1 ? "" : `_${n}`}.mp4`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

module.exports = { Converter, defaultOutputPath };
