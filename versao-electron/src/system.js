// Memória virtual do Windows e o relatório "o que ainda usa o C:".

const os = require("node:os");
const path = require("node:path");
const ffmpeg = require("./ffmpeg");
const paths = require("./paths");

const GB = 1073741824;
/** Abaixo disso, os codificadores de CPU passam a usar configurações mais econômicas. */
const LOW_VIRTUAL_MEMORY = 3 * GB;

/**
 * Memória física e virtual livres e onde fica o arquivo de paginação. A memória virtual é o que
 * importa: com o disco do pagefile.sys cheio, o Windows não consegue aumentá-la e programas
 * pesados (como o x264 no modo "Melhor qualidade") falham ao pedir memória.
 */
async function memory() {
  const base = {
    freePhysical: os.freemem(),
    totalPhysical: os.totalmem(),
    freeVirtual: null,
    totalVirtual: null,
    pagefiles: [],
    automatic: null,
    low: false,
  };
  if (process.platform !== "win32") return base;
  // Sem WMI (que pode travar): a memória vem da API GlobalMemoryStatusEx e o arquivo de paginação,
  // do registro. ullAvailPageFile = quanto ainda dá para alocar antes de bater no limite.
  const script = String.raw`[Console]::OutputEncoding=[Text.Encoding]::UTF8
$src = @'
using System; using System.Runtime.InteropServices;
public static class Mem {
  [StructLayout(LayoutKind.Sequential)] public class MS { public uint len = 64; public uint load;
    public ulong totalPhys, availPhys, totalPage, availPage, totalVirt, availVirt, availExt; }
  [DllImport("kernel32.dll")] public static extern bool GlobalMemoryStatusEx([In, Out] MS m);
}
'@
Add-Type -TypeDefinition $src
$m = New-Object Mem+MS; [void][Mem]::GlobalMemoryStatusEx($m)
$pf = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management' -Name PagingFiles -ErrorAction SilentlyContinue).PagingFiles
@{ freeV = $m.availPage; totalV = $m.totalPage; pf = @($pf) } | ConvertTo-Json -Compress`;
  try {
    const r = await ffmpeg.run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { timeoutMs: 20000 });
    if (r.timedOut) return base;
    const v = JSON.parse(r.stdout);
    const freeVirtual = Number(v.freeV) || 0;
    // Cada linha: "C:\pagefile.sys 0 0", ou "?:\pagefile.sys" quando o Windows gerencia sozinho.
    const entries = (Array.isArray(v.pf) ? v.pf : []).filter(Boolean).map((line) => String(line).trim().split(/\s+/)[0]);
    const automatic = entries.some((e) => e.startsWith("?"));
    const systemDrive = (process.env.SystemDrive || "C:") + "\\";
    const pagefiles = entries.map((e) => {
      const p = e.startsWith("?") ? systemDrive + e.slice(3) : e;
      return { path: p, diskFree: paths.diskSpace(p)?.free ?? null };
    });
    return {
      ...base,
      freeVirtual,
      totalVirtual: Number(v.totalV) || 0,
      automatic,
      pagefiles,
      // SMARTRENDER_LOW_MEMORY=1 força o modo econômico (para testar sem esgotar a memória de verdade).
      low: process.env.SMARTRENDER_LOW_MEMORY === "1" || (freeVirtual > 0 && freeVirtual < LOW_VIRTUAL_MEMORY),
    };
  } catch {
    return base;
  }
}

const isOnC = (p) => !!p && paths.driveOf(p).toUpperCase().startsWith("C:");

/**
 * Lista cada coisa que o SmartRender grava (ou usa) e em que disco está, para a pessoa conferir
 * se conseguiu tirar tudo do C:. `ctx` traz o que só o processo principal sabe (pastas do Electron).
 */
function usage(ctx, mem) {
  const item = (label, where, note, movable = true) => ({ label, where, onC: isOnC(where), note, movable });
  const items = [
    item("Programa SmartRender", ctx.programDir, "Escolhido na instalação. Para mudar, reinstale em outra pasta."),
    item("Preferências, cache e logs do app", ctx.dataDir, ctx.portable ? "Modo portátil ligado." : "Padrão do Windows (%APPDATA%)."),
    item("Arquivos temporários do processamento", paths.workDir(), "Também usada como TEMP pelo FFmpeg."),
    item("Vídeos prontos", paths.outputDir() || ctx.lastVideoDir, paths.outputDir() ? "Pasta fixa." : "Ao lado do vídeo original."),
    item("FFmpeg", ffmpeg.location(), "Só é lido, não grava nada. Mudar é opcional."),
  ];
  for (const p of mem?.pagefiles || []) {
    items.push(item("Memória virtual do Windows (pagefile.sys)", p.path, "Configuração do Windows: o app não pode mudar, mas pode mostrar como.", false));
  }
  return items.filter((i) => i.where);
}

module.exports = { memory, usage, LOW_VIRTUAL_MEMORY };
