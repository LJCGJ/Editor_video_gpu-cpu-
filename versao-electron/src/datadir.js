// Modo portátil: em vez de %APPDATA% (no C:), o app guarda preferências, cache do Chromium,
// logs e temporários numa pasta escolhida, por padrão "dados" ao lado do programa.
//
// Quem liga o modo é um arquivo "pasta-de-dados.txt" ao lado do executável (o instalador cria
// quando o usuário marca a opção, e a interface também consegue criar). Vazio = "<programa>\dados";
// com um caminho dentro = aquela pasta. A variável SMARTRENDER_DATA tem prioridade (útil em testes).
//
// Precisa rodar ANTES de o Electron ficar pronto, porque o caminho dos dados não muda depois.

const fs = require("node:fs");
const path = require("node:path");

const MARKER = "pasta-de-dados.txt";
let info = null;

/** Pasta do programa: a do .exe instalado, ou a do projeto durante o desenvolvimento. */
const baseDir = (app) => (app.isPackaged ? path.dirname(process.execPath) : app.getAppPath());
const markerPath = (app) => path.join(baseDir(app), MARKER);

function configuredDir(app) {
  if (process.env.SMARTRENDER_DATA) return path.resolve(process.env.SMARTRENDER_DATA);
  try {
    const text = fs.readFileSync(markerPath(app), "utf8").trim();
    return text ? path.resolve(baseDir(app), text) : path.join(baseDir(app), "dados");
  } catch {
    return null;
  }
}

/** Aplica o modo portátil (se ligado) e devolve onde os dados estão. */
function apply(app) {
  const defaultDir = app.getPath("userData");
  const dir = configuredDir(app);
  info = { portable: false, dataDir: defaultDir, defaultDir, baseDir: baseDir(app), marker: markerPath(app), error: null };
  if (!dir) return info;
  try {
    const temp = path.join(dir, "temp");
    fs.mkdirSync(temp, { recursive: true });
    app.setPath("userData", dir);
    app.setPath("sessionData", path.join(dir, "sessao"));
    app.setPath("logs", path.join(dir, "logs"));
    app.setPath("crashDumps", path.join(dir, "falhas"));
    app.setPath("temp", temp);
    // Processos abertos pelo app (FFmpeg, PowerShell) também passam a usar esta pasta.
    process.env.TEMP = process.env.TMP = temp;
    info = { ...info, portable: true, dataDir: dir };
  } catch (e) {
    // Pasta inacessível (disco desconectado): segue no padrão e avisa na interface.
    info.error = `Não consegui usar a pasta de dados ${dir}: ${e.code || e.message}`;
  }
  return info;
}

const current = () => info;

/** Copia as preferências da pasta de dados atual para a nova. */
function copySettings(from, to) {
  const src = path.join(from, "settings.json");
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(to, { recursive: true });
  fs.copyFileSync(src, path.join(to, "settings.json"));
}

/** Liga o modo portátil apontando para `dir` (vale a partir da próxima abertura). */
function enable(app, dir) {
  const target = path.resolve(dir);
  fs.mkdirSync(target, { recursive: true });
  const probe = path.join(target, `.teste-${process.pid}`);
  fs.writeFileSync(probe, "ok");
  fs.rmSync(probe, { force: true });
  copySettings(info.dataDir, target);
  fs.writeFileSync(markerPath(app), target);
}

/** Volta para %APPDATA% (vale a partir da próxima abertura). */
function disable(app) {
  copySettings(info.dataDir, info.defaultDir);
  fs.rmSync(markerPath(app), { force: true });
}

/**
 * Depois de mudar para o modo portátil, apaga o cache antigo que ficou em %APPDATA% (no C:).
 * São só dados do próprio SmartRender; as preferências já foram copiadas.
 */
function removeOldDefault() {
  if (!info?.portable || path.resolve(info.defaultDir) === path.resolve(info.dataDir)) return false;
  if (!fs.existsSync(info.defaultDir)) return false;
  try {
    fs.rmSync(info.defaultDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    return true;
  } catch {
    return false;
  }
}

module.exports = { apply, current, enable, disable, removeOldDefault, baseDir };
