//! Mini-benchmark: codifica um trecho curto do próprio vídeo com cada opção disponível,
//! mede tempo, qualidade (SSIM) e tamanho, e testa GPU + CPU trabalhando ao mesmo tempo.
//! A recomendação nasce de medição real nesta máquina, não de uma tabela fixa.

use crate::encoders::{self, Codec, Device, EncoderDef, Goal};
use crate::ffmpeg;
use crate::hardware::HardwareInfo;
use crate::probe::VideoInfo;
use crate::recommend;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::thread;
use std::time::Instant;
use tauri::{AppHandle, Emitter};

/// Uma forma de processar o vídeo (só CPU, só GPU, ou as duas juntas).
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Opcao {
    pub id: String,
    /// "cpu", "gpu" ou "hybrid"
    pub kind: String,
    pub title: String,
    pub detail: String,
    pub gpu_encoder: Option<String>,
    pub cpu_encoder: Option<String>,
    /// Fração do vídeo processada pela GPU (1.0 = tudo na GPU).
    pub gpu_share: f64,
    pub hw_decode: bool,
    /// Quadros por segundo medidos no teste (em regime).
    pub fps: f64,
    /// Quantas vezes mais rápido que a duração do vídeo.
    pub speed_x: f64,
    pub ssim: f64,
    pub ssim_db: f64,
    pub est_seconds: f64,
    pub est_bytes: u64,
    pub score: f64,
    pub recommended: bool,
    pub eligible: bool,
    pub reasons: Vec<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkResult {
    pub sample_seconds: f64,
    pub options: Vec<Opcao>,
    pub summary: String,
    pub notes: Vec<String>,
}

#[derive(Serialize, Clone)]
struct Progress {
    step: usize,
    total: usize,
    label: String,
}

#[derive(Clone, Copy)]
struct Sample {
    start: f64,
    len: f64,
}

/// Resultado de uma codificação do trecho de teste.
struct Single {
    enc: &'static EncoderDef,
    /// Velocidade em regime, depois da inicialização.
    fps: f64,
    /// Custo fixo (abrir o arquivo, iniciar o codificador, finalizar).
    overhead: f64,
    ssim: f64,
    db: f64,
    bytes: u64,
}

const SAMPLE_SECONDS: f64 = 5.0;
const AUDIO_KBPS: f64 = 192.0;
/// Tempo para separar o áudio e juntar as duas partes no final (cópia, sem recodificar).
const HYBRID_MERGE_SECONDS: f64 = 0.5;

pub fn run(
    app: &AppHandle,
    hw: &HardwareInfo,
    video: &VideoInfo,
    codec: Codec,
    goal: Goal,
) -> Result<BenchmarkResult, String> {
    let candidates: Vec<&'static EncoderDef> = hw
        .encoders
        .iter()
        .filter(|e| e.available && e.codec == codec)
        .filter_map(|e| encoders::find(&e.name))
        .collect();
    if candidates.is_empty() {
        return Err("Nenhum codificador disponível para este formato nesta máquina.".into());
    }
    let tmp = std::env::temp_dir().join(format!("smartrender-teste-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let result = run_in(app, &tmp, &candidates, video, codec, goal);
    let _ = std::fs::remove_dir_all(&tmp);
    result
}

fn run_in(
    app: &AppHandle,
    tmp: &Path,
    candidates: &[&'static EncoderDef],
    video: &VideoInfo,
    codec: Codec,
    goal: Goal,
) -> Result<BenchmarkResult, String> {
    let wanted = video.duration.min(SAMPLE_SECONDS);
    // Trecho do meio do vídeo: o começo costuma ter tela preta ou vinheta, o que distorce o teste.
    let start = keyframe_near(video, ((video.duration - wanted) / 2.0).max(0.0), wanted);
    let sample = Sample { start, len: wanted.min(video.duration - start) };

    let has = |d: Device| candidates.iter().any(|e| e.device == d);
    // AV1 fica de fora do modo híbrido: juntar trechos AV1 de codificadores diferentes ainda não é confiável.
    let hybrid_possible = has(Device::Cpu) && has(Device::Gpu) && codec != Codec::Av1;
    let total = candidates.len() + hybrid_possible as usize;

    let mut notes = vec![];
    if !has(Device::Gpu) {
        notes.push("Nenhuma GPU com codificador para este formato foi encontrada: só a CPU foi testada.".into());
    }
    if codec == Codec::Av1 && has(Device::Gpu) && has(Device::Cpu) {
        notes.push("O modo GPU + CPU juntas ainda não está disponível para AV1.".into());
    }

    let mut singles = vec![];
    for (i, e) in candidates.iter().enumerate() {
        emit(app, i + 1, total, format!("Testando {} ({} de {})", e.label, i + 1, total));
        let out = tmp.join(format!("{}.mp4", e.name));
        match encode_sample(video, sample, e, goal, &out) {
            Ok(run) => {
                let fps = run.steady_fps();
                let (ssim, db) = measure_ssim(&out, video, sample).unwrap_or((0.0, 0.0));
                let bytes = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
                singles.push(Single { enc: e, fps, overhead: run.fixed_cost(fps), ssim, db, bytes });
            }
            Err(err) => notes.push(format!("{} falhou neste vídeo e foi descartado ({err}).", e.label)),
        }
    }
    if singles.is_empty() {
        return Err("Nenhum codificador conseguiu processar este vídeo.".into());
    }

    let audio_bytes = if video.audio_codec.is_some() {
        AUDIO_KBPS * 1000.0 / 8.0 * video.duration
    } else {
        0.0
    };
    let mut options: Vec<Opcao> =
        singles.iter().map(|s| single_option(s, video, sample, audio_bytes)).collect();

    if hybrid_possible {
        let gpu = singles
            .iter()
            .filter(|s| s.enc.device == Device::Gpu)
            .max_by(|a, b| a.fps.total_cmp(&b.fps));
        let cpu = singles.iter().find(|s| s.enc.device == Device::Cpu);
        if let (Some(g), Some(c)) = (gpu, cpu) {
            emit(app, total, total, "Testando GPU + CPU trabalhando ao mesmo tempo".into());
            match concurrent(video, sample, g.enc, c.enc, goal, tmp) {
                Ok((rg, rc)) => {
                    // Só vale a janela em que os dois estavam codificando ao mesmo tempo: quando um
                    // termina, o outro fica sozinho e acelera, o que inflaria o resultado.
                    let from = rg.first_frame_time().max(rc.first_frame_time());
                    let to = rg.secs.min(rc.secs);
                    let fg = rg.steady_fps_between(from, to);
                    let fc = rc.steady_fps_between(from, to);
                    let overhead = rg.fixed_cost(rg.steady_fps()).max(rc.fixed_cost(rc.steady_fps()));
                    options.push(hybrid_option(g, c, fg, fc, overhead, video, sample, audio_bytes));
                }
                Err(err) => notes.push(format!("O teste com GPU + CPU juntas falhou ({err}).")),
            }
        }
    }

    let integrated = options
        .iter()
        .any(|o| o.gpu_encoder.as_deref().is_some_and(|n| n.ends_with("_qsv")));
    let summary = recommend::rank(&mut options, goal, integrated);
    options.sort_by(|a, b| b.recommended.cmp(&a.recommended).then(b.score.total_cmp(&a.score)));
    Ok(BenchmarkResult { sample_seconds: sample.len, options, summary, notes })
}

fn emit(app: &AppHandle, step: usize, total: usize, label: String) {
    let _ = app.emit("benchmark-progress", Progress { step, total, label });
}

fn strs(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

/// Primeiro quadro-chave a partir de `t`. Começar o trecho num quadro-chave evita que o FFmpeg
/// decodifique (e descarte) vários segundos antes do ponto pedido — um custo que só existe no
/// teste e que deixaria a estimativa do vídeo inteiro errada.
fn keyframe_near(video: &VideoInfo, t: f64, len: f64) -> f64 {
    let interval = format!("{:.3}%+{}", t, (len * 4.0).max(20.0));
    let args = [
        "-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey",
        "-read_intervals", interval.as_str(),
        "-show_entries", "frame=pts_time", "-of", "csv=p=0", video.path.as_str(),
    ];
    let Ok(out) = ffmpeg::run("ffprobe", &args) else {
        return 0.0;
    };
    let keyframes: Vec<f64> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.trim().parse().ok())
        .collect();
    let fits = |k: f64| k + len.min(1.0) <= video.duration;
    keyframes
        .iter()
        .copied()
        .find(|&k| k >= t && fits(k))
        .or_else(|| keyframes.iter().copied().filter(|&k| k < t).last())
        .unwrap_or(0.0)
}

/// Linha do tempo de uma codificação: (segundos desde o início, quadros prontos).
struct Run {
    secs: f64,
    frames: f64,
    timeline: Vec<(f64, f64)>,
}

impl Run {
    /// Quadros prontos no instante `t`, interpolando entre dois relatórios do FFmpeg.
    fn frame_at(&self, t: f64) -> f64 {
        let mut prev = (0.0, 0.0);
        for &(pt, pf) in &self.timeline {
            if pt >= t {
                let span = pt - prev.0;
                return if span > 0.0 { prev.1 + (pf - prev.1) * (t - prev.0) / span } else { pf };
            }
            prev = (pt, pf);
        }
        prev.1
    }

    fn first_frame_time(&self) -> f64 {
        self.timeline.iter().find(|p| p.1 > 0.0).map(|p| p.0).unwrap_or(self.secs)
    }

    /// Velocidade em regime (quadros/s) dentro de uma janela de tempo.
    fn steady_fps_between(&self, from: f64, to: f64) -> f64 {
        let fps = if to - from < 0.4 {
            self.frames / self.secs
        } else {
            (self.frame_at(to) - self.frame_at(from)) / (to - from)
        };
        fps.max(1e-6)
    }

    fn steady_fps(&self) -> f64 {
        self.steady_fps_between(self.first_frame_time(), self.secs)
    }

    /// Custo fixo que não depende da duração do vídeo.
    fn fixed_cost(&self, fps: f64) -> f64 {
        (self.secs - self.frames / fps).max(0.0)
    }
}

/// Codifica o trecho registrando a linha do tempo. Num trecho curto, abrir o arquivo e
/// inicializar o codificador (principalmente o da GPU) pesa muito; separar esse custo fixo da
/// velocidade "em regime" é o que deixa a estimativa do vídeo inteiro correta.
fn encode_sample(
    video: &VideoInfo,
    sample: Sample,
    e: &EncoderDef,
    goal: Goal,
    out: &Path,
) -> Result<Run, String> {
    let mut a = strs(&[
        "-y", "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1", "-stats_period", "0.1",
    ]);
    a.extend(encoders::decode_args(video.hw_decode));
    a.extend([
        "-ss".into(), format!("{:.6}", sample.start),
        "-t".into(), format!("{:.3}", sample.len),
        "-i".into(), video.path.clone(),
    ]);
    a.extend(strs(&["-map", "0:v:0", "-an"]));
    a.extend(encoders::video_args(e, goal, true));
    a.push(out.to_string_lossy().into_owned());

    let t0 = Instant::now();
    let mut child = ffmpeg::cmd("ffmpeg")
        .args(&a)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Não foi possível iniciar o FFmpeg: {e}"))?;
    let stdout = child.stdout.take().expect("stdout");
    let mut stderr = child.stderr.take().expect("stderr");
    // O stderr é lido em outra thread para o FFmpeg nunca travar com o buffer cheio.
    let err_reader = thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });

    let mut timeline = vec![];
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        if let Some(v) = line.strip_prefix("frame=") {
            timeline.push((t0.elapsed().as_secs_f64(), v.trim().parse::<f64>().unwrap_or(0.0)));
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let err = err_reader.join().unwrap_or_default();
    if !status.success() {
        return Err(ffmpeg::last_error_line(&err));
    }
    let secs = t0.elapsed().as_secs_f64();
    let frames = timeline.last().map(|p| p.1).unwrap_or(0.0);
    timeline.push((secs, frames));
    Ok(Run { secs, frames, timeline })
}

/// SSIM entre o trecho codificado e o original (1,0 = idêntico).
fn measure_ssim(encoded: &Path, video: &VideoInfo, sample: Sample) -> Option<(f64, f64)> {
    let a = [
        "-hide_banner".to_string(), "-nostats".into(),
        "-i".into(), encoded.to_string_lossy().into_owned(),
        "-ss".into(), format!("{:.6}", sample.start),
        "-t".into(), format!("{:.3}", sample.len),
        "-i".into(), video.path.clone(),
        "-lavfi".into(),
        "[0:v]format=yuv420p,setpts=PTS-STARTPTS[a];[1:v]format=yuv420p,setpts=PTS-STARTPTS[b];[a][b]ssim".into(),
        "-f".into(), "null".into(), "-".into(),
    ];
    let o = ffmpeg::run("ffmpeg", &a).ok()?;
    parse_ssim(&ffmpeg::stderr(&o))
}

/// Extrai "All:0.995 (23.1)" da linha de resumo do filtro ssim.
fn parse_ssim(stderr: &str) -> Option<(f64, f64)> {
    let line = stderr.lines().find(|l| l.contains("SSIM Y:"))?;
    let all = line.split("All:").nth(1)?;
    let ssim: f64 = all.split_whitespace().next()?.parse().ok()?;
    let db = all
        .split('(')
        .nth(1)
        .map(|s| s.trim_end_matches(')').trim())
        .map(|s| if s == "inf" { 99.0 } else { s.parse().unwrap_or(0.0) })
        .unwrap_or(0.0);
    Some((ssim, db))
}

/// Roda o melhor codificador de GPU e o de CPU ao mesmo tempo, como no modo híbrido real.
/// O que importa é a velocidade de cada um *enquanto disputam* energia, memória e calor.
fn concurrent(
    video: &VideoInfo,
    sample: Sample,
    gpu: &'static EncoderDef,
    cpu: &'static EncoderDef,
    goal: Goal,
    tmp: &Path,
) -> Result<(Run, Run), String> {
    let (vg, vc) = (video.clone(), video.clone());
    let og: PathBuf = tmp.join("hibrido_gpu.mp4");
    let oc: PathBuf = tmp.join("hibrido_cpu.mp4");
    let hg = thread::spawn(move || encode_sample(&vg, sample, gpu, goal, &og));
    let hc = thread::spawn(move || encode_sample(&vc, sample, cpu, goal, &oc));
    let rg = hg.join().map_err(|_| "thread da GPU travou".to_string())??;
    let rc = hc.join().map_err(|_| "thread da CPU travou".to_string())??;
    Ok((rg, rc))
}

fn single_option(s: &Single, video: &VideoInfo, sample: Sample, audio_bytes: f64) -> Opcao {
    let gpu = s.enc.device == Device::Gpu;
    let detail = match (gpu, video.hw_decode) {
        (true, true) => "Leitura e codificação na GPU",
        (true, false) => "Leitura na CPU · codificação na GPU",
        (false, true) => "Leitura na GPU · codificação na CPU",
        (false, false) => "Tudo na CPU",
    };
    Opcao {
        id: s.enc.name.into(),
        kind: if gpu { "gpu" } else { "cpu" }.into(),
        title: s.enc.label.into(),
        detail: detail.into(),
        gpu_encoder: gpu.then(|| s.enc.name.to_string()),
        cpu_encoder: (!gpu).then(|| s.enc.name.to_string()),
        gpu_share: if gpu { 1.0 } else { 0.0 },
        hw_decode: video.hw_decode,
        fps: s.fps,
        speed_x: s.fps / video.fps,
        ssim: s.ssim,
        ssim_db: s.db,
        est_seconds: s.overhead + video.duration * video.fps / s.fps,
        est_bytes: (s.bytes as f64 / sample.len * video.duration + audio_bytes) as u64,
        score: 0.0,
        recommended: false,
        eligible: true,
        reasons: vec![],
    }
}

/// GPU e CPU rodaram ao mesmo tempo, então as velocidades `fg` e `fc` já incluem a disputa
/// por recursos — exatamente o que acontece no modo híbrido real.
#[allow(clippy::too_many_arguments)]
fn hybrid_option(
    g: &Single,
    c: &Single,
    fg: f64,
    fc: f64,
    overhead: f64,
    video: &VideoInfo,
    sample: Sample,
    audio_bytes: f64,
) -> Opcao {
    let fps = fg + fc;
    // Cada um recebe uma fatia proporcional à sua velocidade, para os dois terminarem juntos.
    let share = fg / fps;
    let mix = |a: f64, b: f64| share * a + (1.0 - share) * b;
    let bytes = mix(g.bytes as f64, c.bytes as f64) / sample.len * video.duration + audio_bytes;
    Opcao {
        id: "hybrid".into(),
        kind: "hybrid".into(),
        title: "GPU + CPU ao mesmo tempo".into(),
        detail: format!(
            "{:.0}% do vídeo em {} + {:.0}% em {}",
            share * 100.0, g.enc.label, (1.0 - share) * 100.0, c.enc.label
        ),
        gpu_encoder: Some(g.enc.name.into()),
        cpu_encoder: Some(c.enc.name.into()),
        gpu_share: share,
        hw_decode: video.hw_decode,
        fps,
        speed_x: fps / video.fps,
        ssim: mix(g.ssim, c.ssim),
        ssim_db: mix(g.db, c.db),
        est_seconds: overhead + video.duration * video.fps / fps + HYBRID_MERGE_SECONDS,
        est_bytes: bytes as u64,
        score: 0.0,
        recommended: false,
        eligible: true,
        reasons: vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(timeline: &[(f64, f64)]) -> Run {
        let &(secs, frames) = timeline.last().unwrap();
        Run { secs, frames, timeline: timeline.to_vec() }
    }

    #[test]
    fn interpola_quadros_entre_relatorios() {
        let r = run(&[(1.0, 0.0), (2.0, 100.0), (3.0, 200.0)]);
        assert_eq!(r.frame_at(1.5), 50.0);
        assert_eq!(r.frame_at(2.0), 100.0);
        assert_eq!(r.frame_at(10.0), 200.0);
    }

    #[test]
    fn separa_custo_fixo_da_velocidade_em_regime() {
        // 1 s de inicialização sem quadros, depois 100 quadros/s por 2 s.
        let r = run(&[(0.5, 0.0), (1.0, 0.0), (1.1, 10.0), (2.0, 100.0), (3.1, 210.0)]);
        let fps = r.steady_fps();
        assert!((fps - 100.0).abs() < 0.5, "fps = {fps}");
        let overhead = r.fixed_cost(fps);
        assert!((overhead - 1.0).abs() < 0.05, "custo fixo = {overhead}");
    }

    #[test]
    fn janela_curta_usa_a_media_da_execucao_inteira() {
        let r = run(&[(1.0, 10.0), (1.2, 30.0), (2.0, 100.0)]);
        assert_eq!(r.steady_fps_between(1.0, 1.2), 50.0);
    }

    #[test]
    fn le_o_resumo_do_filtro_ssim() {
        let log = "[Parsed_ssim_4 @ 0x1] SSIM Y:0.996 (24.0) U:0.99 (20.1) V:0.99 (20.2) All:0.995412 (23.381234)";
        assert_eq!(parse_ssim(log), Some((0.995412, 23.381234)));
        assert_eq!(parse_ssim("SSIM Y:1 (inf) All:1.000000 (inf)"), Some((1.0, 99.0)));
        assert_eq!(parse_ssim("nada aqui"), None);
    }
}
