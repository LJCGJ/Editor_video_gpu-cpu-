//! Conversão do vídeo inteiro com a opção escolhida, com progresso e cancelamento.
//!
//! Modo híbrido: o vídeo é dividido em duas partes proporcionais à velocidade medida de cada
//! codificador. GPU e CPU codificam suas partes ao mesmo tempo (em MPEG-TS, que carrega os
//! parâmetros do codec em cada trecho), o áudio é extraído uma vez só, e no final tudo é
//! juntado em um MP4 sem recodificar.

use crate::benchmark::Opcao;
use crate::encoders::{self, Codec, Goal};
use crate::ffmpeg;
use crate::probe::VideoInfo;
use serde::Serialize;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Instant;
use tauri::{AppHandle, Emitter};

const CANCELLED: &str = "Conversão cancelada.";

#[derive(Default)]
pub struct Shared {
    running: Mutex<Vec<Arc<Mutex<Child>>>>,
    cancelled: AtomicBool,
    busy: AtomicBool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    percent: f64,
    fps: f64,
    elapsed: f64,
    eta: f64,
    stage: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Done {
    out_path: String,
    bytes: u64,
    seconds: f64,
    est_seconds: f64,
    est_bytes: u64,
}

pub fn start(
    app: AppHandle,
    shared: Arc<Shared>,
    video: VideoInfo,
    option: Opcao,
    goal: Goal,
    out_path: String,
) -> Result<(), String> {
    if shared.busy.swap(true, SeqCst) {
        return Err("Já existe uma conversão em andamento.".into());
    }
    shared.cancelled.store(false, SeqCst);
    thread::spawn(move || {
        let started = Instant::now();
        let out = PathBuf::from(&out_path);
        let result = match option.kind.as_str() {
            "hybrid" => hybrid(&app, &shared, &video, &option, goal, &out, started),
            _ => single(&app, &shared, &video, &option, goal, &out, started),
        };
        shared.running.lock().unwrap().clear();
        shared.busy.store(false, SeqCst);
        match result {
            Ok(()) => {
                let _ = app.emit(
                    "conversion-done",
                    Done {
                        bytes: std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0),
                        seconds: started.elapsed().as_secs_f64(),
                        est_seconds: option.est_seconds,
                        est_bytes: option.est_bytes,
                        out_path,
                    },
                );
            }
            Err(e) => {
                let _ = std::fs::remove_file(&out);
                let _ = app.emit("conversion-error", e);
            }
        }
    });
    Ok(())
}

pub fn cancel(shared: &Shared) {
    shared.cancelled.store(true, SeqCst);
    for child in shared.running.lock().unwrap().iter() {
        let _ = child.lock().unwrap().kill();
    }
}

/// Soma o progresso de vários processos FFmpeg rodando em paralelo.
struct Tracker<'a> {
    app: &'a AppHandle,
    started: Instant,
    duration: f64,
    slots: Mutex<Vec<(f64, f64)>>,
}

impl<'a> Tracker<'a> {
    fn new(app: &'a AppHandle, started: Instant, duration: f64, jobs: usize) -> Self {
        Self { app, started, duration, slots: Mutex::new(vec![(0.0, 0.0); jobs]) }
    }

    fn update(&self, slot: usize, done_secs: f64, fps: f64) {
        let (done, total_fps) = {
            let mut s = self.slots.lock().unwrap();
            s[slot] = (done_secs.max(0.0), fps);
            s.iter().fold((0.0, 0.0), |acc, x| (acc.0 + x.0, acc.1 + x.1))
        };
        let frac = (done / self.duration).clamp(0.0, 1.0);
        self.emit(frac, total_fps, "Convertendo");
    }

    fn emit(&self, frac: f64, fps: f64, stage: &str) {
        let elapsed = self.started.elapsed().as_secs_f64();
        let eta = if frac > 0.01 { elapsed / frac - elapsed } else { -1.0 };
        let _ = self.app.emit(
            "conversion-progress",
            Progress { percent: frac * 100.0, fps, elapsed, eta, stage: stage.into() },
        );
    }
}

fn strs(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

fn base_args() -> Vec<String> {
    strs(&["-y", "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1"])
}

fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn run_job(shared: &Shared, args: &[String], tracker: Option<(&Tracker, usize)>) -> Result<(), String> {
    if shared.cancelled.load(SeqCst) {
        return Err(CANCELLED.into());
    }
    let mut child = ffmpeg::cmd("ffmpeg")
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Não foi possível iniciar o FFmpeg: {e}"))?;
    let stdout = child.stdout.take().expect("stdout");
    let mut stderr = child.stderr.take().expect("stderr");
    let child = Arc::new(Mutex::new(child));
    shared.running.lock().unwrap().push(child.clone());

    let err_reader = thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });

    let mut fps = 0.0;
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        if let Some(v) = line.strip_prefix("fps=") {
            fps = v.trim().parse().unwrap_or(fps);
        } else if let Some(v) = line.strip_prefix("out_time_us=") {
            if let (Ok(us), Some((t, slot))) = (v.trim().parse::<i64>(), tracker) {
                t.update(slot, us as f64 / 1e6, fps);
            }
        }
    }
    let status = child.lock().unwrap().wait().map_err(|e| e.to_string())?;
    let err = err_reader.join().unwrap_or_default();
    if shared.cancelled.load(SeqCst) {
        return Err(CANCELLED.into());
    }
    if !status.success() {
        return Err(format!("O FFmpeg falhou: {}", ffmpeg::last_error_line(&err)));
    }
    Ok(())
}

fn single(
    app: &AppHandle,
    shared: &Shared,
    video: &VideoInfo,
    option: &Opcao,
    goal: Goal,
    out: &Path,
    started: Instant,
) -> Result<(), String> {
    let name = option.gpu_encoder.as_ref().or(option.cpu_encoder.as_ref()).ok_or("Opção inválida.")?;
    let e = encoders::find(name).ok_or("Codificador desconhecido.")?;
    let tracker = Tracker::new(app, started, video.duration, 1);
    tracker.emit(0.0, 0.0, "Iniciando");

    let mut a = base_args();
    a.extend(encoders::decode_args(video.hw_decode));
    a.extend(["-i".into(), video.path.clone()]);
    a.extend(strs(&["-map", "0:v:0", "-map", "0:a:0?"]));
    a.extend(encoders::video_args(e, goal, true));
    a.extend(encoders::audio_args(video.audio_codec.as_deref()));
    a.extend(["-movflags".into(), "+faststart".into(), path_str(out)]);
    run_job(shared, &a, Some((&tracker, 0)))
}

fn hybrid(
    app: &AppHandle,
    shared: &Shared,
    video: &VideoInfo,
    option: &Opcao,
    goal: Goal,
    out: &Path,
    started: Instant,
) -> Result<(), String> {
    let g = option.gpu_encoder.as_deref().and_then(encoders::find).ok_or("Codificador de GPU ausente.")?;
    let c = option.cpu_encoder.as_deref().and_then(encoders::find).ok_or("Codificador de CPU ausente.")?;
    let tmp = std::env::temp_dir().join(format!(
        "smartrender-conv-{}-{}",
        std::process::id(),
        started.elapsed().as_nanos()
    ));
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let result = hybrid_in(app, shared, video, option, goal, out, started, &tmp, g, c);
    let _ = std::fs::remove_dir_all(&tmp);
    result
}

#[allow(clippy::too_many_arguments)]
fn hybrid_in(
    app: &AppHandle,
    shared: &Shared,
    video: &VideoInfo,
    option: &Opcao,
    goal: Goal,
    out: &Path,
    started: Instant,
    tmp: &Path,
    g: &encoders::EncoderDef,
    c: &encoders::EncoderDef,
) -> Result<(), String> {
    // Ponto de corte alinhado a um frame exato.
    let frame = 1.0 / video.fps;
    let split = ((video.duration * option.gpu_share / frame).round() * frame)
        .clamp(frame, (video.duration - frame).max(frame));
    let part_gpu = tmp.join("parte_gpu.ts");
    let part_cpu = tmp.join("parte_cpu.ts");
    let audio = tmp.join("audio.m4a");

    let mut ja = base_args();
    ja.extend(encoders::decode_args(video.hw_decode));
    ja.extend(["-i".into(), video.path.clone(), "-t".into(), format!("{split:.6}")]);
    ja.extend(strs(&["-map", "0:v:0", "-an"]));
    ja.extend(encoders::video_args(g, goal, false));
    ja.extend(["-f".into(), "mpegts".into(), path_str(&part_gpu)]);

    let mut jb = base_args();
    jb.extend(encoders::decode_args(video.hw_decode));
    jb.extend(["-ss".into(), format!("{split:.6}"), "-i".into(), video.path.clone()]);
    jb.extend(strs(&["-map", "0:v:0", "-an"]));
    jb.extend(encoders::video_args(c, goal, false));
    jb.extend(["-f".into(), "mpegts".into(), path_str(&part_cpu)]);

    let jc = video.audio_codec.as_ref().map(|_| {
        let mut a = strs(&["-y", "-hide_banner", "-loglevel", "error", "-i"]);
        a.push(video.path.clone());
        a.extend(strs(&["-vn", "-map", "0:a:0"]));
        a.extend(encoders::audio_args(video.audio_codec.as_deref()));
        a.push(path_str(&audio));
        a
    });

    let tracker = Tracker::new(app, started, video.duration, 2);
    tracker.emit(0.0, 0.0, "Iniciando GPU e CPU");
    let results = thread::scope(|s| {
        let ha = s.spawn(|| run_job(shared, &ja, Some((&tracker, 0))));
        let hb = s.spawn(|| run_job(shared, &jb, Some((&tracker, 1))));
        let hc = s.spawn(|| jc.as_ref().map_or(Ok(()), |j| run_job(shared, j, None)));
        [ha.join(), hb.join(), hc.join()]
    });
    for r in results {
        r.map_err(|_| "Uma das tarefas travou.".to_string())??;
    }

    tracker.emit(0.995, 0.0, "Juntando as partes");
    let esc = |p: &Path| path_str(p).replace('\\', "/").replace('\'', "'\\''");
    let list = tmp.join("partes.txt");
    std::fs::write(&list, format!("file '{}'\nfile '{}'\n", esc(&part_gpu), esc(&part_cpu)))
        .map_err(|e| e.to_string())?;

    let mut j = strs(&["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i"]);
    j.push(path_str(&list));
    if jc.is_some() {
        j.extend(["-i".into(), path_str(&audio)]);
    }
    j.extend(strs(&["-map", "0:v:0"]));
    if jc.is_some() {
        j.extend(strs(&["-map", "1:a:0"]));
    }
    j.extend(strs(&["-c", "copy"]));
    if g.codec == Codec::Hevc {
        j.extend(strs(&["-tag:v", "hvc1"]));
    }
    j.extend(["-movflags".into(), "+faststart".into(), path_str(out)]);
    run_job(shared, &j, None)?;
    tracker.emit(1.0, 0.0, "Concluído");
    Ok(())
}
