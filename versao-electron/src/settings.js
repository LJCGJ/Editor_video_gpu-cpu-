// Preferências do usuário (pastas de trabalho, de saída e do FFmpeg), guardadas num JSON pequeno
// dentro da pasta de dados do app (%APPDATA% ou, no modo portátil, a pasta escolhida).

const fs = require("node:fs");
const path = require("node:path");
const paths = require("./paths");
const ffmpeg = require("./ffmpeg");

let file = null;
let current = { workDir: null, outputDir: null, ffmpegDir: null };
let saved = false;
/** FFmpeg levado junto com o programa (ex.: D:\SmartRender\ffmpeg), usado se nenhum for escolhido. */
let bundledFfmpeg = null;

function applyAll() {
  paths.configure(current);
  ffmpeg.configure({ ffmpegDir: current.ffmpegDir || bundledFfmpeg });
}

/** Lê as preferências e aplica as pastas. `dir` é a pasta de dados do app. */
function load(dir, programDir) {
  file = path.join(dir, "settings.json");
  const candidate = programDir && path.join(programDir, "ffmpeg");
  bundledFfmpeg = candidate && fs.existsSync(path.join(candidate, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg")) ? candidate : null;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    current = { workDir: data.workDir || null, outputDir: data.outputDir || null, ffmpegDir: data.ffmpegDir || null };
    saved = true;
  } catch {
    saved = false;
  }
  applyAll();
  return current;
}

/** Garante que dá para criar e gravar arquivos na pasta. */
function assertWritable(dir, label) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.smartrender-teste-${process.pid}`);
    fs.writeFileSync(probe, "ok");
    fs.rmSync(probe, { force: true });
  } catch (e) {
    throw new Error(`Não consigo gravar na ${label} (${dir}): ${e.code || e.message}`);
  }
}

async function save(next) {
  const merged = { ...current, ...next };
  if (merged.workDir) assertWritable(merged.workDir, "pasta de trabalho");
  if (merged.outputDir) assertWritable(merged.outputDir, "pasta de saída");
  if (next.ffmpegDir) await ffmpeg.validateDir(next.ffmpegDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(merged, null, 2));
  current = merged;
  saved = true;
  applyAll();
  return current;
}

/** Tudo o que a interface precisa para mostrar e sugerir as pastas. */
function describe() {
  const work = paths.workDir();
  const out = paths.outputDir();
  return {
    firstRun: !saved,
    workDir: work,
    workDirCustom: !!current.workDir,
    workSpace: paths.diskSpace(work),
    systemTemp: paths.defaultTemp(),
    outputDir: out,
    outputSpace: out ? paths.diskSpace(out) : null,
    ffmpegPath: ffmpeg.location(),
    ffmpegCustom: !!current.ffmpegDir,
    ffmpegBundled: !current.ffmpegDir && !!bundledFfmpeg,
    drives: paths.listDrives(),
  };
}

module.exports = { load, save, describe };
