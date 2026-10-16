// Lê as características do vídeo (ffprobe) e testa se a GPU consegue decodificá-lo.

const path = require("node:path");
const ffmpeg = require("./ffmpeg");

const num = (x) => {
  const n = typeof x === "number" ? x : parseFloat(x);
  return Number.isFinite(n) ? n : 0;
};

function parseRate(r) {
  const [n, d] = String(r || "").split("/").map(Number);
  return d ? n / d : 0;
}

async function analyze(file) {
  const r = await ffmpeg.run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
  if (r.code !== 0) {
    throw new Error(`Não consegui ler este arquivo como vídeo: ${ffmpeg.lastErrorLine(r.stderr)}`);
  }
  const v = JSON.parse(r.stdout);
  const streams = v.streams || [];
  const video = streams.find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  if (!video) throw new Error("O arquivo não tem uma faixa de vídeo.");
  const audio = streams.find((s) => s.codec_type === "audio");

  const duration = num(v.format?.duration) || num(video.duration);
  if (duration <= 0) throw new Error("Não consegui descobrir a duração do vídeo.");

  const pixFmt = video.pix_fmt || "desconhecido";
  const bitDepth = pixFmt.includes("12") ? 12 : pixFmt.includes("10") ? 10 : 8;
  const chroma = pixFmt.includes("444") ? "4:4:4" : pixFmt.includes("422") ? "4:2:2" : pixFmt.startsWith("gray") ? "mono" : "4:2:0";
  const codec = video.codec_name || "?";
  const width = video.width || 0;
  const hwDecode = await testHwDecode(file);

  const warnings = [];
  if (!hwDecode) {
    let w = `Sua GPU não consegue ler (decodificar) este formato: ${codec.toUpperCase()} ${bitDepth}-bit ${chroma}. ` +
      "A leitura será feita pela CPU, o que deixa edição e conversão mais pesadas.";
    if (chroma === "4:2:2") w += " Isso é comum em vídeos de câmeras (Sony, Canon, Panasonic) gravados em 10-bit 4:2:2.";
    warnings.push(w);
  }
  if (bitDepth > 8 || chroma !== "4:2:0") {
    warnings.push("A saída será gerada em 8-bit 4:2:0 para tocar em qualquer aparelho (celular, TV, navegador).");
  }
  if (width >= 3840) warnings.push("Vídeo 4K: o teste e a conversão vão levar mais tempo.");

  return {
    path: file,
    fileName: path.basename(file),
    sizeBytes: num(v.format?.size),
    duration,
    bitrateKbps: Math.round(num(v.format?.bit_rate) / 1000),
    codec,
    profile: video.profile || "",
    width,
    height: video.height || 0,
    fps: parseRate(video.avg_frame_rate) || 30,
    pixFmt,
    bitDepth,
    chroma,
    audioCodec: audio?.codec_name || null,
    hwDecode,
    warnings,
  };
}

/**
 * Decodifica 1 segundo pedindo frames na memória da GPU (D3D11). Quando a GPU suporta o
 * formato, o FFmpeg registra "pix_fmt: d3d11"; quando não suporta, ele cai silenciosamente
 * para a CPU e essa linha não aparece.
 */
async function testHwDecode(file) {
  if (process.platform !== "win32") return false;
  const args = ["-hide_banner", "-loglevel", "verbose", "-hwaccel", "d3d11va", "-hwaccel_output_format", "d3d11",
    "-t", "1", "-i", file, "-map", "0:v:0", "-f", "null", "-"];
  try {
    return (await ffmpeg.run("ffmpeg", args)).stderr.includes("pix_fmt: d3d11");
  } catch {
    return false;
  }
}

module.exports = { analyze };
