// Onde o SmartRender trabalha (arquivos temporários) e onde salva os vídeos prontos,
// além de utilitários de espaço em disco.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TEMP_PREFIX = "smartrender-";
/**
 * Pasta temporária "de fábrica", lida uma vez ao carregar o módulo: a do Windows, ou a do modo
 * portátil (datadir.js troca o TEMP antes). Guardada porque depois o TEMP passa a apontar para a
 * pasta de trabalho, e é preciso saber para onde voltar quando o usuário escolhe "Usar o padrão".
 */
const DEFAULT_TEMP = os.tmpdir();

let settings = { workDir: null, outputDir: null };

function configure(next) {
  settings = { ...settings, ...next };
  // FFmpeg, PowerShell e o próprio Node passam a usar a pasta de trabalho como TEMP:
  // assim nada do processamento cai na pasta temporária do Windows (no C:).
  process.env.TEMP = process.env.TMP = workDir();
}

/** Pasta de trabalho escolhida pelo usuário, ou a temporária padrão. */
function workDir() {
  if (settings.workDir) {
    try {
      fs.mkdirSync(settings.workDir, { recursive: true });
      return settings.workDir;
    } catch {
      // Pasta inacessível (pendrive removido, disco desconectado): volta para o padrão.
    }
  }
  return DEFAULT_TEMP;
}

const defaultTemp = () => DEFAULT_TEMP;

/** Pasta onde salvar os vídeos prontos, ou null para "ao lado do vídeo original". */
function outputDir() {
  return settings.outputDir || null;
}

const OWNER_FILE = ".dono";
/** Pastas temporárias que este processo está usando agora. */
const active = new Set();

/** Cria uma pasta temporária marcada com o processo dono (para a limpeza não apagar pastas em uso). */
function makeTemp(name) {
  const dir = fs.mkdtempSync(path.join(workDir(), `${TEMP_PREFIX}${name}-`));
  active.add(path.resolve(dir));
  try {
    fs.writeFileSync(path.join(dir, OWNER_FILE), String(process.pid));
  } catch {
    // Sem a marca, a pasta só é apagada quando ficar velha (veja inUse).
  }
  return dir;
}

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

/**
 * Uma pasta está em uso se o processo dono ainda estiver rodando (por exemplo, outra janela do
 * SmartRender no meio de uma conversão). Pastas sem marca só são apagadas depois de 12 horas.
 */
function inUse(dir) {
  if (active.has(path.resolve(dir))) return true;
  try {
    const pid = Number(fs.readFileSync(path.join(dir, OWNER_FILE), "utf8"));
    return pid !== process.pid && Number.isInteger(pid) && pid > 0 && isAlive(pid);
  } catch {
    try {
      return Date.now() - fs.statSync(dir).mtimeMs < 12 * 3600 * 1000;
    } catch {
      return false;
    }
  }
}

/**
 * Apaga uma pasta temporária sem nunca derrubar o trabalho: um arquivo ainda preso
 * (FFmpeg terminando, antivírus examinando) não pode transformar um sucesso em erro.
 * O que sobrar é apagado na próxima abertura do app (cleanupLeftovers).
 */
function removeTemp(dir) {
  active.delete(path.resolve(dir));
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    // Fica para a próxima limpeza.
  }
}

/** Remove pastas temporárias esquecidas por execuções anteriores (nunca as que estão em uso). */
function cleanupLeftovers() {
  for (const base of new Set([workDir(), DEFAULT_TEMP, os.tmpdir()])) {
    let entries = [];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const dir = path.join(base, e.name);
      if (e.isDirectory() && e.name.startsWith(TEMP_PREFIX) && !inUse(dir)) removeTemp(dir);
    }
  }
}

/** Unidade (ex.: "D:\") de um caminho. */
const driveOf = (p) => path.parse(path.resolve(p)).root;

/** Espaço livre e total de uma unidade, ou null se não der para ler. */
function diskSpace(p) {
  try {
    const s = fs.statfsSync(driveOf(p));
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    return null;
  }
}

/** Unidades locais com espaço, para sugerir um disco com mais folga. */
function listDrives() {
  if (process.platform !== "win32") return [];
  const drives = [];
  for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
    const root = `${letter}:\\`;
    const space = fs.existsSync(root) ? diskSpace(root) : null;
    if (space && space.total > 0) drives.push({ root, ...space });
  }
  return drives;
}

/** Erro amigável se não houver espaço para `needBytes` na unidade de `dir`. */
function ensureSpace(dir, needBytes, what) {
  const space = diskSpace(dir);
  if (!space || space.free >= needBytes) return;
  const gb = (b) => `${(b / 1073741824).toFixed(1).replace(".", ",")} GB`;
  throw new Error(
    `Espaço insuficiente em ${driveOf(dir)} para ${what}: precisa de cerca de ${gb(needBytes)} e há ${gb(space.free)} livres. ` +
      `Libere espaço ou escolha outra pasta em "Onde processar e salvar".`
  );
}

module.exports = { configure, workDir, defaultTemp, outputDir, makeTemp, removeTemp, cleanupLeftovers, driveOf, diskSpace, listDrives, ensureSpace };
