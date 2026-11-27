const path = require("node:path");
const { spawn } = require("node:child_process");
const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
// O modo portátil precisa ser aplicado antes de tudo: a pasta de dados (e o TEMP) não muda depois.
const datadir = require("./src/datadir");
const dataInfo = datadir.apply(app);
const hardware = require("./src/hardware");
const probe = require("./src/probe");
const benchmark = require("./src/benchmark");
const join = require("./src/join");
const { Converter, defaultOutputPath } = require("./src/convert");
const settings = require("./src/settings");
const paths = require("./src/paths");
const system = require("./src/system");

let win;
let hw = null;
let lastVideoDir = null;
let oldDataRemoved = false;
const send = (event, payload) => win?.webContents.send(event, payload);
const converter = new Converter(send);

/** Os handlers devolvem { ok, data } ou { ok: false, error } para a interface mostrar só a mensagem. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });
}

handle("detect-hardware", async () => (hw = await hardware.detect()));
/** Hardware já detectado, ou detecta agora (ex.: logo depois de trocar o FFmpeg). */
const ensureHardware = async () => hw || (hw = await hardware.detect());
handle("analyze-video", (file) => {
  lastVideoDir = path.dirname(file);
  return probe.analyze(file);
});
handle("default-output-path", (file, suffix) => defaultOutputPath(file, suffix));
handle("plan-join", async ({ clips, codec, goal }) => {
  return join.plan(await ensureHardware(), clips, codec, goal, (p) => send("benchmark-progress", p));
});
handle("start-join", ({ clips, plan, goal, outPath }) => converter.startJoin(clips, plan, goal, outPath));
handle("open-videos", async (extensions) => {
  const r = await dialog.showOpenDialog(win, {
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Vídeos", extensions }],
  });
  return r.canceled ? [] : r.filePaths;
});
handle("run-benchmark", async ({ video, codec, goal }) => {
  return benchmark.run(await ensureHardware(), video, codec, goal, (p) => send("benchmark-progress", p));
});
handle("start-conversion", ({ video, option, goal, outPath }) => converter.start(video, option, goal, outPath));
handle("cancel-conversion", () => converter.cancel());
handle("reveal-in-folder", (file) => shell.showItemInFolder(file));
handle("open-video", async (extensions) => {
  const r = await dialog.showOpenDialog(win, { properties: ["openFile"], filters: [{ name: "Vídeos", extensions }] });
  return r.canceled ? null : r.filePaths[0];
});
handle("choose-output", async (defaultPath) => {
  const r = await dialog.showSaveDialog(win, { defaultPath, filters: [{ name: "Vídeo MP4", extensions: ["mp4"] }] });
  return r.canceled ? null : r.filePath;
});
/** Pastas, FFmpeg, modo portátil, memória virtual e o relatório do que ainda usa o C:. */
async function describeAll() {
  const mem = await system.memory();
  const programDir = app.isPackaged ? path.dirname(process.execPath) : null;
  return {
    ...settings.describe(),
    data: { ...dataInfo, oldDataRemoved, packaged: app.isPackaged, programDir },
    memory: mem,
    usage: system.usage(
      { programDir, dataDir: dataInfo.dataDir, portable: dataInfo.portable, lastVideoDir },
      mem
    ),
  };
}

handle("get-settings", describeAll);
handle("set-settings", async (next) => {
  await settings.save(next);
  // Trocar o FFmpeg muda quais codificadores existem: a interface detecta o hardware de novo.
  if ("ffmpegDir" in next) hw = null;
  paths.cleanupLeftovers();
  return describeAll();
});
/** Liga (dir) ou desliga (null) o modo portátil e reinicia o app para valer. */
handle("move-data", (dir) => {
  if (converter.busy) throw new Error("Espere a conversão terminar antes de mover os dados do app.");
  if (dir) datadir.enable(app, dir);
  else datadir.disable(app);
  setTimeout(() => {
    app.relaunch();
    app.exit(0);
  }, 400);
  return true;
});
handle("open-memory-settings", () => {
  // Abre "Opções de desempenho" do Windows; a aba "Avançado" tem o botão da memória virtual.
  spawn("SystemPropertiesPerformance.exe", [], { detached: true, stdio: "ignore" }).unref();
});
handle("choose-folder", async (defaultPath) => {
  const r = await dialog.showOpenDialog(win, { defaultPath, properties: ["openDirectory", "createDirectory"] });
  return r.canceled ? null : r.filePaths[0];
});

/**
 * Fechar a janela no meio de uma conversão perde o vídeo que está sendo gerado. Pergunta antes;
 * se o usuário confirmar, cancela, espera o FFmpeg sair e o arquivo parcial ser apagado, e fecha.
 */
let closingAfterCancel = false;
function confirmCloseDuringConversion(e) {
  if (!converter.busy || closingAfterCancel) return;
  e.preventDefault();
  const choice = dialog.showMessageBoxSync(win, {
    type: "warning",
    title: "Conversão em andamento",
    message: "Há um vídeo sendo gerado agora.",
    detail: "Se fechar o SmartRender, a conversão é cancelada e o vídeo incompleto é descartado.",
    buttons: ["Continuar convertendo", "Cancelar e fechar"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (choice !== 1) return;
  closingAfterCancel = true;
  converter.cancel();
  converter.whenIdle().then(() => win?.close());
}

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 860,
    minWidth: 760,
    minHeight: 600,
    title: "SmartRender — conversão inteligente GPU + CPU",
    icon: path.join(__dirname, "build", "icon.png"),
    autoHideMenuBar: true,
    backgroundColor: "#f4f4f8",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, "ui", "index.html"));
  win.on("close", confirmCloseDuringConversion);
  // Links externos abrem no navegador, nunca dentro do app.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
}

app.whenReady().then(() => {
  settings.load(app.getPath("userData"), datadir.baseDir(app));
  // No modo portátil, o cache antigo em %APPDATA% (no C:) não serve mais: libera o espaço.
  oldDataRemoved = datadir.removeOldDefault();
  // Apaga pastas temporárias que ficaram presas em execuções anteriores.
  paths.cleanupLeftovers();
  createWindow();
});
app.on("window-all-closed", () => {
  converter.cancel();
  app.quit();
});
