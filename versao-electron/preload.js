// Ponte segura entre a interface e o processo principal: só estas funções ficam expostas.

const { contextBridge, ipcRenderer, webUtils } = require("electron");

async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw r.error;
  return r.data;
}

const EVENTS = ["benchmark-progress", "conversion-progress", "conversion-done", "conversion-error"];

contextBridge.exposeInMainWorld("api", {
  detectHardware: () => call("detect-hardware"),
  analyzeVideo: (file) => call("analyze-video", file),
  defaultOutputPath: (file) => call("default-output-path", file),
  runBenchmark: (req) => call("run-benchmark", req),
  startConversion: (req) => call("start-conversion", req),
  cancelConversion: () => call("cancel-conversion"),
  revealInFolder: (file) => call("reveal-in-folder", file),
  openVideo: (extensions) => call("open-video", extensions),
  chooseOutput: (defaultPath) => call("choose-output", defaultPath),
  /** Caminho real de um arquivo arrastado para a janela. */
  pathForFile: (file) => webUtils.getPathForFile(file),
  on(event, cb) {
    if (EVENTS.includes(event)) ipcRenderer.on(event, (_e, payload) => cb(payload));
  },
});
