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

  // Placas de vídeo pelo registro (classe "Display"), sem WMI: o WMI pode travar e deixar a
  // tela em "Detectando…" para sempre. O nome da CPU vem do próprio Node.
  const script = String.raw`[Console]::OutputEncoding=[Text.Encoding]::UTF8
$k = 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}'
$g = @(Get-ChildItem $k -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -match '^\d{4}$' } | ForEach-Object {
  $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
  if ($p.DriverDesc) { @{ Name = $p.DriverDesc; DriverVersion = $p.DriverVersion; Mem = $p.'HardwareInformation.qwMemorySize' } }
})
@{ gpus = $g } | ConvertTo-Json -Compress -Depth 3`;
  try {
    const r = await ffmpeg.run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { timeoutMs: 15000 });
    if (r.timedOut) return fallback;
    const v = JSON.parse(r.stdout);
    const list = Array.isArray(v.gpus) ? v.gpus : v.gpus ? [v.gpus] : [];
    const seen = new Set();
    const gpus = list
      .filter((g) => g.Name && !g.Name.startsWith("Microsoft")) // adaptadores virtuais não codificam vídeo
      .filter((g) => !seen.has(g.Name) && seen.add(g.Name))
      .map((g) => ({
        name: g.Name.trim(),
        vendor: vendorOf(g.Name),
        driver: g.DriverVersion || "",
        vramMb: Math.round((Number(g.Mem) || 0) / 1048576),
      }));
    return { cpuName: fallback.cpuName, gpus };
  } catch {
    return fallback;
  }
}

module.exports = { detect };
