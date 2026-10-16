// Sem janela de console no Windows na versão final.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod benchmark;
mod convert;
mod encoders;
mod ffmpeg;
mod hardware;
mod probe;
mod recommend;

use benchmark::{BenchmarkResult, Opcao};
use encoders::{Codec, Goal};
use hardware::HardwareInfo;
use probe::VideoInfo;
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, State};

#[derive(Default)]
struct AppState {
    hw: Mutex<Option<HardwareInfo>>,
    conv: Arc<convert::Shared>,
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn detect_hardware(state: State<'_, AppState>) -> Result<HardwareInfo, String> {
    let hw = blocking(hardware::detect).await?;
    *state.hw.lock().unwrap() = Some(hw.clone());
    Ok(hw)
}

#[tauri::command]
async fn analyze_video(path: String) -> Result<VideoInfo, String> {
    blocking(move || probe::analyze(&path)).await
}

#[tauri::command]
async fn run_benchmark(
    app: AppHandle,
    state: State<'_, AppState>,
    video: VideoInfo,
    codec: Codec,
    goal: Goal,
) -> Result<BenchmarkResult, String> {
    let hw = state.hw.lock().unwrap().clone().ok_or("O hardware ainda não foi detectado.")?;
    blocking(move || benchmark::run(&app, &hw, &video, codec, goal)).await
}

#[tauri::command]
fn start_conversion(
    app: AppHandle,
    state: State<'_, AppState>,
    video: VideoInfo,
    option: Opcao,
    goal: Goal,
    out_path: String,
) -> Result<(), String> {
    if Path::new(&out_path) == Path::new(&video.path) {
        return Err("O arquivo de saída não pode ser o mesmo do original.".into());
    }
    convert::start(app, state.conv.clone(), video, option, goal, out_path)
}

#[tauri::command]
fn cancel_conversion(state: State<'_, AppState>) {
    convert::cancel(&state.conv);
}

/// Sugere "<nome>_smartrender.mp4" na mesma pasta, sem sobrescrever nada que já exista.
#[tauri::command]
fn default_output_path(path: String) -> String {
    let p = Path::new(&path);
    let dir = p.parent().unwrap_or(Path::new("."));
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or("video".into());
    let mut n = 1;
    loop {
        let suffix = if n == 1 { String::new() } else { format!("_{n}") };
        let candidate = dir.join(format!("{stem}_smartrender{suffix}.mp4"));
        if !candidate.exists() {
            return candidate.to_string_lossy().into_owned();
        }
        n += 1;
    }
}

#[tauri::command]
fn reveal_in_folder(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer")
            .raw_arg(format!("/select,\"{path}\""))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    let _ = path;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            detect_hardware,
            analyze_video,
            run_benchmark,
            start_conversion,
            cancel_conversion,
            default_output_path,
            reveal_in_folder
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o SmartRender");
}
