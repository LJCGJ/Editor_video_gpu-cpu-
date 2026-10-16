// Ponte entre a interface e o backend em Rust.
// Oferece a mesma `window.api` da versão Electron (preload.js), então o app.js é idêntico nas duas.
// Cada `invoke("nome")` chama a função `#[tauri::command] fn nome(...)` do src-tauri/src/main.rs.
// O Tauri converte os nomes dos argumentos: `outPath` aqui vira `out_path` no Rust.

(() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  window.api = {
    detectHardware: () => invoke("detect_hardware"),
    analyzeVideo: (path) => invoke("analyze_video", { path }),
    defaultOutputPath: (path) => invoke("default_output_path", { path }),
    runBenchmark: ({ video, codec, goal }) => invoke("run_benchmark", { video, codec, goal }),
    startConversion: ({ video, option, goal, outPath }) => invoke("start_conversion", { video, option, goal, outPath }),
    cancelConversion: () => invoke("cancel_conversion"),
    revealInFolder: (path) => invoke("reveal_in_folder", { path }),
    openVideo: (extensions) =>
      invoke("plugin:dialog|open", {
        options: { multiple: false, directory: false, filters: [{ name: "Vídeos", extensions }] },
      }),
    chooseOutput: (defaultPath) =>
      invoke("plugin:dialog|save", { options: { defaultPath, filters: [{ name: "Vídeo MP4", extensions: ["mp4"] }] } }),
    // Eventos enviados pelo Rust com `app.emit("nome", dados)`.
    on: (event, cb) => listen(event, (e) => cb(e.payload)),
    // No Tauri, a janela entrega o caminho dos arquivos arrastados direto (os eventos HTML de drop não disparam).
    onFileDrop: (cb) =>
      window.__TAURI__.webview.getCurrentWebview().onDragDropEvent(({ payload }) => {
        if (payload.type === "enter" || payload.type === "over") cb("over");
        else if (payload.type === "drop" && payload.paths?.length) cb("drop", payload.paths[0]);
        else cb("leave");
      }),
  };
})();
