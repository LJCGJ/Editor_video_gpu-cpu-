//! Descobre CPU, GPUs e quais codificadores realmente funcionam nesta máquina.

use crate::encoders::{Codec, Device, EncoderDef, ENCODERS};
use crate::ffmpeg;
use serde::Serialize;
use std::thread;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    pub name: String,
    pub vendor: String,
    pub driver: String,
    pub vram_mb: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EncoderStatus {
    pub name: String,
    pub label: String,
    pub codec: Codec,
    pub device: Device,
    pub vendor: String,
    pub available: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HardwareInfo {
    pub cpu_name: String,
    pub cpu_threads: usize,
    pub gpus: Vec<GpuInfo>,
    pub encoders: Vec<EncoderStatus>,
    pub ffmpeg_version: String,
}

pub fn detect() -> Result<HardwareInfo, String> {
    let ffmpeg_version = ffmpeg::version()?;
    let system = thread::spawn(query_system);

    // Testa todos os codificadores em paralelo com um vídeo sintético de meio segundo.
    // Isso é mais confiável que olhar o nome da placa: o driver precisa funcionar de verdade.
    let probes: Vec<_> = ENCODERS
        .iter()
        .map(|e| thread::spawn(move || (e, probe_encoder(e))))
        .collect();
    let encoders = probes
        .into_iter()
        .map(|h| {
            let (e, available) = h.join().expect("thread de teste do codificador");
            EncoderStatus {
                name: e.name.into(),
                label: e.label.into(),
                codec: e.codec,
                device: e.device,
                vendor: e.vendor.into(),
                available,
            }
        })
        .collect();

    let (cpu_name, gpus) = system.join().unwrap_or_else(|_| ("CPU".into(), vec![]));
    Ok(HardwareInfo {
        cpu_name,
        cpu_threads: thread::available_parallelism().map(|n| n.get()).unwrap_or(1),
        gpus,
        encoders,
        ffmpeg_version,
    })
}

fn probe_encoder(e: &EncoderDef) -> bool {
    let fmt = if e.device == Device::Gpu { "format=nv12" } else { "format=yuv420p" };
    let args = [
        "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
        "testsrc2=size=640x360:rate=30", "-frames:v", "5", "-vf", fmt, "-c:v", e.name, "-f", "null", "-",
    ];
    ffmpeg::run("ffmpeg", &args).map(|o| o.status.success()).unwrap_or(false)
}

fn vendor_of(name: &str) -> &'static str {
    let n = name.to_lowercase();
    if n.contains("nvidia") || n.contains("geforce") || n.contains("quadro") {
        "nvidia"
    } else if n.contains("amd") || n.contains("radeon") {
        "amd"
    } else if n.contains("intel") {
        "intel"
    } else {
        "outro"
    }
}

#[cfg(windows)]
fn query_system() -> (String, Vec<GpuInfo>) {
    let script = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; \
        $g=@(Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,AdapterRAM); \
        $c=(Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty Name); \
        @{gpus=$g; cpu=$c} | ConvertTo-Json -Compress -Depth 3";
    let Ok(out) = ffmpeg::run("powershell", &["-NoProfile", "-NonInteractive", "-Command", script]) else {
        return ("CPU".into(), vec![]);
    };
    let v: serde_json::Value =
        serde_json::from_slice(&out.stdout).unwrap_or(serde_json::Value::Null);
    let cpu = v["cpu"].as_str().unwrap_or("CPU").trim().to_string();
    let list = match &v["gpus"] {
        serde_json::Value::Array(a) => a.clone(),
        serde_json::Value::Object(_) => vec![v["gpus"].clone()],
        _ => vec![],
    };
    let gpus = list
        .iter()
        .filter_map(|g| {
            let name = g["Name"].as_str()?.trim().to_string();
            // Adaptadores virtuais (área de trabalho remota, vídeo básico) não codificam vídeo.
            if name.starts_with("Microsoft") {
                return None;
            }
            Some(GpuInfo {
                vendor: vendor_of(&name).into(),
                driver: g["DriverVersion"].as_str().unwrap_or("").to_string(),
                vram_mb: g["AdapterRAM"].as_u64().unwrap_or(0) / (1024 * 1024),
                name,
            })
        })
        .collect();
    (cpu, gpus)
}

#[cfg(not(windows))]
fn query_system() -> (String, Vec<GpuInfo>) {
    ("CPU".into(), vec![])
}
