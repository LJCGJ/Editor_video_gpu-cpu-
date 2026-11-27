// Helpers para executar ffmpeg/ffprobe sem abrir janelas de console no Windows.
// O FFmpeg pode vir de uma pasta escolhida pelo usuário (por exemplo, uma cópia no D:)
// ou do PATH do sistema.

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const TOOLS = ["ffmpeg", "ffprobe"];
const exeName = (name) => (process.platform === "win32" ? `${name}.exe` : name);
let customDir = null;

/** Usa o FFmpeg desta pasta (ou null para o do sistema). */
function configure({ ffmpegDir }) {
  customDir = ffmpegDir || null;
}

/** Caminho do executável a usar: o da pasta escolhida, se existir; senão, o nome (resolvido pelo PATH). */
function bin(name) {
  if (customDir && TOOLS.includes(name)) {
    const p = path.join(customDir, exeName(name));
    if (fs.existsSync(p)) return p;
  }
  return name;
}

/** Onde está o ffmpeg que será usado (para mostrar na interface). */
function location() {
  const chosen = bin("ffmpeg");
  if (chosen !== "ffmpeg") return chosen;
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    const p = path.join(dir, exeName("ffmpeg"));
    if (dir && fs.existsSync(p)) return p;
  }
  return null;
}

/** Confere se a pasta tem ffmpeg e ffprobe que funcionam. Devolve a versão. */
async function validateDir(dir) {
  for (const t of TOOLS) {
    if (!fs.existsSync(path.join(dir, exeName(t)))) {
      throw new Error(`A pasta ${dir} não tem o ${exeName(t)}. Escolha a pasta "bin" do FFmpeg, onde ficam ffmpeg.exe e ffprobe.exe.`);
    }
  }
  const r = await run(path.join(dir, exeName("ffmpeg")), ["-hide_banner", "-version"]);
  return (r.stdout.split(/\r?\n/)[0] || "").split(/\s+/)[2] || "desconhecida";
}

/**
 * Executa um programa e devolve { code, stdout, stderr, timedOut } quando ele termina.
 * Com `timeoutMs`, o processo é encerrado se demorar demais (ex.: o WMI do Windows travado faz
 * o PowerShell esperar para sempre) e a resposta volta com timedOut = true.
 */
function run(program, args, { timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin(program), args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return reject(new Error(`Não foi possível executar o ${program}: ${e.message}`));
    }
    const out = [];
    const err = [];
    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, timeoutMs)
      : null;
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`Não foi possível executar o ${program}: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
  });
}

/** Versão do FFmpeg, ou erro amigável se ele não estiver instalado. */
async function version() {
  let r;
  try {
    r = await run("ffmpeg", ["-hide_banner", "-version"]);
  } catch {
    throw new Error(
      "FFmpeg não encontrado. Instale com `winget install Gyan.FFmpeg` ou escolha a pasta do FFmpeg em \"Onde processar e salvar\" e reabra o app."
    );
  }
  const first = r.stdout.split(/\r?\n/)[0] || "";
  return first.split(/\s+/)[2] || "desconhecida";
}

/** Última linha útil do stderr, para mensagens de erro curtas. */
function lastErrorLine(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] || "erro desconhecido";
}

module.exports = { configure, bin, location, validateDir, run, version, lastErrorLine };
