//! Catálogo de codificadores (CPU e GPU) e os parâmetros usados para cada objetivo.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Codec {
    H264,
    Hevc,
    Av1,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Device {
    Cpu,
    Gpu,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Goal {
    Speed,
    Quality,
    Size,
}

pub struct EncoderDef {
    pub name: &'static str,
    pub codec: Codec,
    pub device: Device,
    /// "cpu", "intel", "nvidia" ou "amd"
    pub vendor: &'static str,
    pub label: &'static str,
}

const fn enc(
    name: &'static str,
    codec: Codec,
    device: Device,
    vendor: &'static str,
    label: &'static str,
) -> EncoderDef {
    EncoderDef { name, codec, device, vendor, label }
}

use Codec::*;
use Device::*;

pub const ENCODERS: &[EncoderDef] = &[
    enc("libx264", H264, Cpu, "cpu", "CPU · x264"),
    enc("h264_qsv", H264, Gpu, "intel", "GPU Intel · Quick Sync"),
    enc("h264_nvenc", H264, Gpu, "nvidia", "GPU NVIDIA · NVENC"),
    enc("h264_amf", H264, Gpu, "amd", "GPU AMD · AMF"),
    enc("libx265", Hevc, Cpu, "cpu", "CPU · x265"),
    enc("hevc_qsv", Hevc, Gpu, "intel", "GPU Intel · Quick Sync"),
    enc("hevc_nvenc", Hevc, Gpu, "nvidia", "GPU NVIDIA · NVENC"),
    enc("hevc_amf", Hevc, Gpu, "amd", "GPU AMD · AMF"),
    enc("libsvtav1", Av1, Cpu, "cpu", "CPU · SVT-AV1"),
    enc("av1_qsv", Av1, Gpu, "intel", "GPU Intel · Quick Sync"),
    enc("av1_nvenc", Av1, Gpu, "nvidia", "GPU NVIDIA · NVENC"),
    enc("av1_amf", Av1, Gpu, "amd", "GPU AMD · AMF"),
];

pub fn find(name: &str) -> Option<&'static EncoderDef> {
    ENCODERS.iter().find(|e| e.name == name)
}

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

/// Parâmetros de qualidade/velocidade de cada codificador para cada objetivo.
/// Os valores foram escolhidos para que CPU e GPU mirem em qualidades parecidas,
/// assim o teste compara "maçã com maçã".
fn tuning(e: &EncoderDef, goal: Goal) -> Vec<String> {
    use Goal::*;
    match (e.name, goal) {
        ("libx264", Speed) => s(&["-preset", "veryfast", "-crf", "23"]),
        ("libx264", Quality) => s(&["-preset", "slow", "-crf", "18"]),
        ("libx264", Size) => s(&["-preset", "slow", "-crf", "26"]),

        ("libx265", Speed) => s(&["-preset", "fast", "-crf", "26", "-x265-params", "log-level=error"]),
        ("libx265", Quality) => s(&["-preset", "medium", "-crf", "20", "-x265-params", "log-level=error"]),
        ("libx265", Size) => s(&["-preset", "slow", "-crf", "28", "-x265-params", "log-level=error"]),

        ("libsvtav1", Speed) => s(&["-preset", "10", "-crf", "32"]),
        ("libsvtav1", Quality) => s(&["-preset", "5", "-crf", "24"]),
        ("libsvtav1", Size) => s(&["-preset", "6", "-crf", "38"]),

        (n, g) if n.ends_with("_qsv") => {
            let q = match (e.codec, g) {
                (H264, Speed) => "23",
                (H264, Quality) => "18",
                (H264, Size) => "27",
                (_, Speed) => "25",
                (_, Quality) => "20",
                (_, Size) => "29",
            };
            let preset = if g == Speed { "veryfast" } else { "veryslow" };
            s(&["-preset", preset, "-global_quality", q])
        }

        (n, g) if n.ends_with("_nvenc") => match g {
            Speed => s(&["-preset", "p2", "-rc", "vbr", "-cq", "23", "-b:v", "0"]),
            Quality => s(&["-preset", "p7", "-tune", "hq", "-rc", "vbr", "-cq", "19", "-b:v", "0"]),
            Size => s(&["-preset", "p7", "-tune", "hq", "-rc", "vbr", "-cq", "28", "-b:v", "0"]),
        },

        (n, g) if n.ends_with("_amf") => {
            let (quality, qi, qp) = match g {
                Speed => ("speed", "23", "25"),
                Quality => ("quality", "18", "20"),
                Size => ("quality", "27", "29"),
            };
            s(&["-quality", quality, "-rc", "cqp", "-qp_i", qi, "-qp_p", qp])
        }

        _ => vec![],
    }
}

/// Argumentos de decodificação (antes do `-i`). Usa a GPU para ler o vídeo quando ela suporta.
pub fn decode_args(hw_decode: bool) -> Vec<String> {
    if hw_decode && cfg!(windows) {
        s(&["-hwaccel", "d3d11va"])
    } else {
        vec![]
    }
}

/// Argumentos de vídeo (depois do `-i`). Sempre gera 8-bit 4:2:0 para tocar em qualquer aparelho.
pub fn video_args(e: &EncoderDef, goal: Goal, for_mp4: bool) -> Vec<String> {
    let fmt = if e.device == Gpu { "format=nv12" } else { "format=yuv420p" };
    let mut a = s(&["-vf", fmt, "-c:v", e.name]);
    a.extend(tuning(e, goal));
    if e.codec == Hevc && for_mp4 {
        a.extend(s(&["-tag:v", "hvc1"]));
    }
    a
}

/// Áudio: copia quando o formato já é compatível com MP4, senão converte para AAC.
pub fn audio_args(audio_codec: Option<&str>) -> Vec<String> {
    match audio_codec {
        Some("aac") | Some("mp3") => s(&["-c:a", "copy"]),
        _ => s(&["-c:a", "aac", "-b:a", "192k"]),
    }
}
