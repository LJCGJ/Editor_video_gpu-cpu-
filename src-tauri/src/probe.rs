//! Lê as características do vídeo (ffprobe) e testa se a GPU consegue decodificá-lo.

use crate::ffmpeg;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VideoInfo {
    pub path: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub duration: f64,
    pub bitrate_kbps: u64,
    pub codec: String,
    pub profile: String,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub pix_fmt: String,
    pub bit_depth: u32,
    pub chroma: String,
    pub audio_codec: Option<String>,
    pub hw_decode: bool,
    pub warnings: Vec<String>,
}

pub fn analyze(path: &str) -> Result<VideoInfo, String> {
    let out = ffmpeg::run(
        "ffprobe",
        &["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
    )?;
    if !out.status.success() {
        return Err(format!(
            "Não consegui ler este arquivo como vídeo: {}",
            ffmpeg::last_error_line(&ffmpeg::stderr(&out))
        ));
    }
    let v: Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    let streams = v["streams"].as_array().cloned().unwrap_or_default();
    let video = streams
        .iter()
        .find(|s| s["codec_type"] == "video" && s["disposition"]["attached_pic"] != 1)
        .ok_or("O arquivo não tem uma faixa de vídeo.")?;
    let audio = streams.iter().find(|s| s["codec_type"] == "audio");

    let num = |x: &Value| -> f64 {
        x.as_f64().or_else(|| x.as_str().and_then(|s| s.parse().ok())).unwrap_or(0.0)
    };
    let duration = Some(num(&v["format"]["duration"]))
        .filter(|d| *d > 0.0)
        .unwrap_or_else(|| num(&video["duration"]));
    if duration <= 0.0 {
        return Err("Não consegui descobrir a duração do vídeo.".into());
    }

    let pix_fmt = video["pix_fmt"].as_str().unwrap_or("desconhecido").to_string();
    let bit_depth = if pix_fmt.contains("12") {
        12
    } else if pix_fmt.contains("10") {
        10
    } else {
        8
    };
    let chroma = if pix_fmt.contains("444") {
        "4:4:4"
    } else if pix_fmt.contains("422") {
        "4:2:2"
    } else if pix_fmt.starts_with("gray") {
        "mono"
    } else {
        "4:2:0"
    }
    .to_string();

    let codec = video["codec_name"].as_str().unwrap_or("?").to_string();
    let width = video["width"].as_u64().unwrap_or(0) as u32;
    let height = video["height"].as_u64().unwrap_or(0) as u32;
    let hw_decode = test_hw_decode(path);

    let mut warnings = vec![];
    if !hw_decode {
        let mut w = format!(
            "Sua GPU não consegue ler (decodificar) este formato: {} {}-bit {}. A leitura será feita pela CPU, o que deixa edição e conversão mais pesadas.",
            codec.to_uppercase(), bit_depth, chroma
        );
        if chroma == "4:2:2" {
            w.push_str(" Isso é comum em vídeos de câmeras (Sony, Canon, Panasonic) gravados em 10-bit 4:2:2.");
        }
        warnings.push(w);
    }
    if bit_depth > 8 || chroma != "4:2:0" {
        warnings.push(
            "A saída será gerada em 8-bit 4:2:0 para tocar em qualquer aparelho (celular, TV, navegador).".into(),
        );
    }
    if width >= 3840 {
        warnings.push("Vídeo 4K: o teste e a conversão vão levar mais tempo.".into());
    }

    let fps_str = video["avg_frame_rate"].as_str().unwrap_or("0/1");
    Ok(VideoInfo {
        path: path.to_string(),
        file_name: Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        size_bytes: num(&v["format"]["size"]) as u64,
        duration,
        bitrate_kbps: (num(&v["format"]["bit_rate"]) / 1000.0) as u64,
        codec,
        profile: video["profile"].as_str().unwrap_or("").to_string(),
        width,
        height,
        fps: parse_rate(fps_str).filter(|f| *f > 0.0).unwrap_or(30.0),
        pix_fmt,
        bit_depth,
        chroma,
        audio_codec: audio.and_then(|a| a["codec_name"].as_str()).map(String::from),
        hw_decode,
        warnings,
    })
}

fn parse_rate(r: &str) -> Option<f64> {
    let (n, d) = r.split_once('/')?;
    let (n, d): (f64, f64) = (n.parse().ok()?, d.parse().ok()?);
    (d != 0.0).then(|| n / d)
}

/// Decodifica 1 segundo pedindo frames na memória da GPU (D3D11). Quando a GPU suporta o
/// formato, o FFmpeg registra "pix_fmt: d3d11"; quando não suporta, ele cai silenciosamente
/// para a CPU e essa linha não aparece.
#[cfg(windows)]
fn test_hw_decode(path: &str) -> bool {
    let args = [
        "-hide_banner", "-loglevel", "verbose", "-hwaccel", "d3d11va", "-hwaccel_output_format",
        "d3d11", "-t", "1", "-i", path, "-map", "0:v:0", "-f", "null", "-",
    ];
    ffmpeg::run("ffmpeg", &args)
        .map(|o| ffmpeg::stderr(&o).contains("pix_fmt: d3d11"))
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn test_hw_decode(_path: &str) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::parse_rate;

    #[test]
    fn le_taxas_de_quadros_do_ffprobe() {
        assert_eq!(parse_rate("30/1"), Some(30.0));
        let ntsc = parse_rate("30000/1001").unwrap();
        assert!((ntsc - 29.97).abs() < 0.01);
        assert_eq!(parse_rate("0/0"), None);
        assert_eq!(parse_rate("lixo"), None);
    }
}
