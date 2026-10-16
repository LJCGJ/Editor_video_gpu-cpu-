// Descobre CPU, GPUs e quais codificadores realmente funcionam nesta máquina.

const os = require("node:os");
const ffmpeg = require("./ffmpeg");
const { ENCODERS } = require("./encoders");

async function detect() {
  const ffmpegVersion = await ffmpeg.version();

  // Testa todos os codificadores em paralelo com um vídeo sintético de meio segundo.
  // Isso é mais confiável que olhar o nome da placa: o driver precisa funcionar de verdade.
  const [system, ...probes] = await Promise.all([querySystem(), ...ENCODERS.map(probeEncoder)]);

  return {
    cpuName: system.cpuName,
    cpuThreads: os.availableParallelism ? os.availableParallelism() : os.cpus().length,
    gpus: system.gpus,
    encoders: ENCODERS.map((e, i) => ({ ...e, available: probes[i] })),
    ffmpegVersion,
  };
}

async function probeEncoder(e) {
  const fmt = e.device === "gpu" ? "format=nv12" : "format=yuv420p";
  const args = ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
    "-frames:v", "5", "-vf", fmt, "-c:v", e.name, "-f", "null", "-"];
  try {
    return (await ffmpeg.run("ffmpeg", args)).code === 0;
  } catch {
    return false;
  }
}

function vendorOf(name) {
  const n = name.toLowerCase();
  if (/nvidia|geforce|quadro/.test(n)) return "nvidia";
  if (/amd|radeon/.test(n)) return "amd";
  if (n.includes("intel")) return "intel";
  return "outro";
}

async function querySystem() {
  const fallback = { cpuName: os.cpus()[0]?.model?.trim() || "CPU", gpus: [] };
  if (process.platform !== "win32") return fallback;

  const script = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; " +
    "$g=@(Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,AdapterRAM); " +
    "$c=(Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty Name); " +
    "@{gpus=$g; cpu=$c} | ConvertTo-Json -Compress -Depth 3";
  try {
    const r = await ffmpeg.run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
    const v = JSON.parse(r.stdout);
    const list = Array.isArray(v.gpus) ? v.gpus : v.gpus ? [v.gpus] : [];
    const gpus = list
      .filter((g) => g.Name && !g.Name.startsWith("Microsoft")) // adaptadores virtuais não codificam vídeo
      .map((g) => ({
        name: g.Name.trim(),
        vendor: vendorOf(g.Name),
        driver: g.DriverVersion || "",
        vramMb: Math.round((g.AdapterRAM || 0) / 1048576),
      }));
    return { cpuName: (v.cpu || fallback.cpuName).trim(), gpus };
  } catch {
    return fallback;
  }
}

module.exports = { detect };
