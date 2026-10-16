// Helpers para executar ffmpeg/ffprobe sem abrir janelas de console no Windows.

const { spawn } = require("node:child_process");

/** Executa um programa e devolve { code, stdout, stderr } quando ele termina. */
function run(program, args) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(program, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return reject(new Error(`Não foi possível executar o ${program}: ${e.message}`));
    }
    const out = [];
    const err = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", (e) => reject(new Error(`Não foi possível executar o ${program}: ${e.message}`)));
    child.on("close", (code) =>
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") })
    );
  });
}

/** Versão do FFmpeg, ou erro amigável se ele não estiver instalado. */
async function version() {
  let r;
  try {
    r = await run("ffmpeg", ["-hide_banner", "-version"]);
  } catch {
    throw new Error("FFmpeg não encontrado. Instale com `winget install Gyan.FFmpeg` e reabra o app.");
  }
  const first = r.stdout.split(/\r?\n/)[0] || "";
  return first.split(/\s+/)[2] || "desconhecida";
}

/** Última linha útil do stderr, para mensagens de erro curtas. */
function lastErrorLine(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] || "erro desconhecido";
}

module.exports = { run, version, lastErrorLine };
