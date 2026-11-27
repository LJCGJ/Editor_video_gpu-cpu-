// Preferências do usuário (pastas de trabalho e de saída), guardadas num JSON pequeno.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const paths = require("./paths");

let file = null;
let current = { workDir: null, outputDir: null };
let saved = false;

/** Lê as preferências e aplica as pastas. `dir` é a pasta de dados do app. */
function load(dir) {
  file = path.join(dir, "settings.json");
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    current = { workDir: data.workDir || null, outputDir: data.outputDir || null };
    saved = true;
  } catch {
    saved = false;
  }
  paths.configure(current);
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

function save(next) {
  const merged = { ...current, ...next };
  if (merged.workDir) assertWritable(merged.workDir, "pasta de trabalho");
  if (merged.outputDir) assertWritable(merged.outputDir, "pasta de saída");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(merged, null, 2));
  current = merged;
  saved = true;
  paths.configure(current);
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
    systemTemp: os.tmpdir(),
    outputDir: out,
    outputSpace: out ? paths.diskSpace(out) : null,
    drives: paths.listDrives(),
  };
}

module.exports = { load, save, describe };
