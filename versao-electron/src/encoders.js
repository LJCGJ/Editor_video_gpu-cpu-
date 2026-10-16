// Catálogo de codificadores (CPU e GPU) e os parâmetros usados para cada objetivo.

const enc = (name, codec, device, vendor, label) => ({ name, codec, device, vendor, label });

const ENCODERS = [
  enc("libx264", "h264", "cpu", "cpu", "CPU · x264"),
  enc("h264_qsv", "h264", "gpu", "intel", "GPU Intel · Quick Sync"),
  enc("h264_nvenc", "h264", "gpu", "nvidia", "GPU NVIDIA · NVENC"),
  enc("h264_amf", "h264", "gpu", "amd", "GPU AMD · AMF"),
  enc("libx265", "hevc", "cpu", "cpu", "CPU · x265"),
  enc("hevc_qsv", "hevc", "gpu", "intel", "GPU Intel · Quick Sync"),
  enc("hevc_nvenc", "hevc", "gpu", "nvidia", "GPU NVIDIA · NVENC"),
  enc("hevc_amf", "hevc", "gpu", "amd", "GPU AMD · AMF"),
  enc("libsvtav1", "av1", "cpu", "cpu", "CPU · SVT-AV1"),
  enc("av1_qsv", "av1", "gpu", "intel", "GPU Intel · Quick Sync"),
  enc("av1_nvenc", "av1", "gpu", "nvidia", "GPU NVIDIA · NVENC"),
  enc("av1_amf", "av1", "gpu", "amd", "GPU AMD · AMF"),
];

const find = (name) => ENCODERS.find((e) => e.name === name);

/**
 * Parâmetros de qualidade/velocidade de cada codificador para cada objetivo.
 * Os valores foram escolhidos para que CPU e GPU mirem em qualidades parecidas,
 * assim o teste compara "maçã com maçã".
 */
function tuning(e, goal) {
  const x265log = ["-x265-params", "log-level=error"];
  const table = {
    libx264: {
      speed: ["-preset", "veryfast", "-crf", "23"],
      quality: ["-preset", "slow", "-crf", "18"],
      size: ["-preset", "slow", "-crf", "26"],
    },
    libx265: {
      speed: ["-preset", "fast", "-crf", "26", ...x265log],
      quality: ["-preset", "medium", "-crf", "20", ...x265log],
      size: ["-preset", "slow", "-crf", "28", ...x265log],
    },
    libsvtav1: {
      speed: ["-preset", "10", "-crf", "32"],
      quality: ["-preset", "5", "-crf", "24"],
      size: ["-preset", "6", "-crf", "38"],
    },
  };
  if (table[e.name]) return table[e.name][goal];

  if (e.name.endsWith("_qsv")) {
    const q = e.codec === "h264" ? { speed: "23", quality: "18", size: "27" } : { speed: "25", quality: "20", size: "29" };
    return ["-preset", goal === "speed" ? "veryfast" : "veryslow", "-global_quality", q[goal]];
  }
  if (e.name.endsWith("_nvenc")) {
    return {
      speed: ["-preset", "p2", "-rc", "vbr", "-cq", "23", "-b:v", "0"],
      quality: ["-preset", "p7", "-tune", "hq", "-rc", "vbr", "-cq", "19", "-b:v", "0"],
      size: ["-preset", "p7", "-tune", "hq", "-rc", "vbr", "-cq", "28", "-b:v", "0"],
    }[goal];
  }
  if (e.name.endsWith("_amf")) {
    const [quality, qi, qp] = { speed: ["speed", "23", "25"], quality: ["quality", "18", "20"], size: ["quality", "27", "29"] }[goal];
    return ["-quality", quality, "-rc", "cqp", "-qp_i", qi, "-qp_p", qp];
  }
  return [];
}

/** Argumentos de decodificação (antes do `-i`). Usa a GPU para ler o vídeo quando ela suporta. */
function decodeArgs(hwDecode) {
  return hwDecode && process.platform === "win32" ? ["-hwaccel", "d3d11va"] : [];
}

/** Argumentos de vídeo (depois do `-i`). Sempre gera 8-bit 4:2:0 para tocar em qualquer aparelho. */
function videoArgs(e, goal, forMp4) {
  const fmt = e.device === "gpu" ? "format=nv12" : "format=yuv420p";
  const a = ["-vf", fmt, "-c:v", e.name, ...tuning(e, goal)];
  if (e.codec === "hevc" && forMp4) a.push("-tag:v", "hvc1");
  return a;
}

/** Áudio: copia quando o formato já é compatível com MP4, senão converte para AAC. */
function audioArgs(audioCodec) {
  return audioCodec === "aac" || audioCodec === "mp3" ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "192k"];
}

module.exports = { ENCODERS, find, decodeArgs, videoArgs, audioArgs };
