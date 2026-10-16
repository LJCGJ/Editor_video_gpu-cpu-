const path = require("node:path");
const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const hardware = require("./src/hardware");
const probe = require("./src/probe");
const benchmark = require("./src/benchmark");
const { Converter, defaultOutputPath } = require("./src/convert");

let win;
let hw = null;
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
handle("analyze-video", (file) => probe.analyze(file));
handle("default-output-path", (file) => defaultOutputPath(file));
handle("run-benchmark", ({ video, codec, goal }) => {
  if (!hw) throw new Error("O hardware ainda não foi detectado.");
  return benchmark.run(hw, video, codec, goal, (p) => send("benchmark-progress", p));
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
  // Links externos abrem no navegador, nunca dentro do app.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  converter.cancel();
  app.quit();
});
