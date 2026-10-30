// Junção de vários vídeos em um só.
//
// Dois caminhos:
// - Cópia: se todos os vídeos têm o mesmo formato (codec, resolução, quadros por segundo, cor e áudio),
//   os arquivos são emendados sem recodificar. É quase instantâneo e não perde qualidade.
// - Recodificação: se algo difere, cada vídeo é ajustado para a resolução e a taxa de quadros do
//   primeiro (com tarjas pretas quando a proporção é diferente) e tudo é codificado de novo. Para isso,
//   o mesmo benchmark da conversão escolhe entre GPU e CPU, medindo no vídeo mais longo.

const fs = require("node:fs");
const benchmark = require("./benchmark");
const encoders = require("./encoders");

const COPYABLE_VIDEO = ["h264", "hevc", "av1"];
const COPYABLE_AUDIO = ["aac", "mp3"];
/** Velocidade aproximada de uma cópia de arquivo (bytes/s), só para a estimativa. */
const COPY_BYTES_PER_SECOND = 150 * 1048576;
const AUDIO_KBPS = 192;

const unique = (xs) => [...new Set(xs)];
const listOf = (xs) => unique(xs).join(", ");

/** Motivos que impedem a junção por cópia (lista vazia = dá para copiar). */
function copyBlockers(clips) {
  const a = clips[0];
  const blockers = [];
  const codecs = clips.map((c) => c.codec);
  if (unique(codecs).length > 1) blockers.push(`formatos de vídeo diferentes (${listOf(codecs.map((c) => c.toUpperCase()))})`);
  else if (!COPYABLE_VIDEO.includes(a.codec)) blockers.push(`o formato ${a.codec.toUpperCase()} não pode ser emendado direto em MP4`);
  const sizes = clips.map((c) => `${c.width}×${c.height}`);
  if (unique(sizes).length > 1) blockers.push(`resoluções diferentes (${listOf(sizes)})`);
  if (!clips.every((c) => Math.abs(c.fps - a.fps) < 0.01)) {
    blockers.push(`taxas de quadros diferentes (${listOf(clips.map((c) => `${+c.fps.toFixed(2)} fps`))})`);
  }
  if (unique(clips.map((c) => c.pixFmt)).length > 1) blockers.push("formatos de cor diferentes (bit depth ou subamostragem)");
  if (unique(clips.map((c) => c.profile)).length > 1) blockers.push("perfis de codificação diferentes");
  const audios = clips.map((c) => (c.audioCodec ? `${c.audioCodec}/${c.audioSampleRate}/${c.audioChannels}` : "sem áudio"));
  if (unique(audios).length > 1) blockers.push("áudios diferentes (ou algum vídeo sem áudio)");
  else if (a.audioCodec && !COPYABLE_AUDIO.includes(a.audioCodec)) {
    blockers.push(`o áudio ${a.audioCodec.toUpperCase()} não pode ser emendado direto em MP4`);
  }
  return blockers;
}

/**
 * Decide como juntar. Na recodificação, roda o benchmark no vídeo mais longo para escolher
 * GPU ou CPU, do mesmo jeito que na conversão de um vídeo só.
 */
async function plan(hw, clips, codec, goal, onProgress = () => {}) {
  if (clips.length < 2) throw new Error("Escolha pelo menos dois vídeos para juntar.");
  const totalDuration = clips.reduce((s, c) => s + c.duration, 0);
  const totalBytes = clips.reduce((s, c) => s + c.sizeBytes, 0);
  const target = { width: clips[0].width, height: clips[0].height, fps: clips[0].fps };
  const blockers = copyBlockers(clips);

  if (!blockers.length) {
    return {
      mode: "copy",
      title: "Junção direta, sem recodificar",
      summary: "Todos os vídeos têm o mesmo formato: dá para emendar direto, sem perder qualidade.",
      reasons: [
        "Os arquivos são emendados como estão: nenhum quadro é recodificado.",
        "Por isso é muito rápido e a qualidade fica idêntica à dos originais.",
        "Nem a GPU nem a CPU precisam trabalhar pesado.",
        `O vídeo final mantém o formato original (${clips[0].codec.toUpperCase()}); a escolha de formato de saída só vale quando é preciso recodificar.`,
      ],
      target,
      totalDuration,
      estSeconds: Math.max(1, totalBytes / COPY_BYTES_PER_SECOND),
      estBytes: totalBytes,
      option: null,
    };
  }

  const longest = clips.reduce((a, b) => (b.duration > a.duration ? b : a));
  const bench = await benchmark.run(hw, longest, codec, goal, onProgress);
  // O modo híbrido divide um vídeo em partes; numa junção ele não se aplica.
  const singles = bench.options.filter((o) => o.kind !== "hybrid" && o.eligible);
  const option = singles.find((o) => o.recommended) || singles.sort((a, b) => b.score - a.score)[0];
  const totalFrames = totalDuration * target.fps;
  const fixedCost = Math.max(0, option.estSeconds - (longest.duration * longest.fps) / option.fps);
  const videoBytes = (option.estBytes - ((AUDIO_KBPS * 1000) / 8) * (longest.audioCodec ? longest.duration : 0)) / longest.duration;
  const anyAudio = clips.some((c) => c.audioCodec);

  return {
    mode: "encode",
    title: `Recodificar com ${option.title}`,
    summary: `Os vídeos têm formatos diferentes, então precisam ser recodificados. Melhor opção nesta máquina: ${option.title}.`,
    reasons: [
      `Por que não dá para emendar direto: ${blockers.join("; ")}.`,
      `Todos os vídeos serão ajustados para ${target.width}×${target.height} a ${+target.fps.toFixed(2)} quadros/s (o formato do primeiro), com tarjas pretas se a proporção for diferente.`,
      // O tempo do benchmark é de um vídeo só; o total da junção aparece no resumo.
      ...option.reasons.filter((r) => !r.startsWith("Termina em")),
    ],
    target,
    totalDuration,
    estSeconds: fixedCost + totalFrames / option.fps,
    estBytes: Math.round(videoBytes * totalDuration + (anyAudio ? ((AUDIO_KBPS * 1000) / 8) * totalDuration : 0)),
    option,
  };
}

/** Argumentos do FFmpeg para a junção por cópia (usa uma lista de arquivos). */
function copyArgs(clips, listFile, out) {
  const esc = (p) => p.replace(/\\/g, "/").replace(/'/g, "'\\''");
  fs.writeFileSync(listFile, clips.map((c) => `file '${esc(c.path)}'`).join("\n") + "\n");
  return [
    "-f", "concat", "-safe", "0", "-i", listFile,
    "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy",
    ...(clips[0].codec === "hevc" ? ["-tag:v", "hvc1"] : []),
    "-movflags", "+faststart", out,
  ];
}

/** Argumentos do FFmpeg para a junção com recodificação (um único filtro "concat"). */
function encodeArgs(clips, p, goal, out) {
  const e = encoders.find(p.option.gpuEncoder || p.option.cpuEncoder);
  const { width: w, height: h, fps } = p.target;
  const anyAudio = clips.some((c) => c.audioCodec);
  const inputs = clips.flatMap((c) => [...encoders.decodeArgs(c.hwDecode), "-i", c.path]);

  const parts = clips.map((c, i) => {
    const v = `[${i}:v:0]scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
      `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v${i}]`;
    if (!anyAudio) return v;
    // Áudio sempre com a mesma duração do vídeo; quem não tem áudio ganha silêncio.
    const a = c.audioCodec
      ? `[${i}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${c.duration.toFixed(3)}[a${i}]`
      : `anullsrc=r=48000:cl=stereo,atrim=duration=${c.duration.toFixed(3)}[a${i}]`;
    return `${v};${a}`;
  });
  const order = clips.map((_, i) => (anyAudio ? `[v${i}][a${i}]` : `[v${i}]`)).join("");
  const graph = `${parts.join(";")};${order}concat=n=${clips.length}:v=1:a=${anyAudio ? 1 : 0}` +
    `${anyAudio ? "[vj][aout]" : "[vj]"};[vj]${encoders.pixelFormat(e)}[vout]`;

  return [
    ...inputs,
    "-filter_complex", graph,
    "-map", "[vout]",
    ...(anyAudio ? ["-map", "[aout]", "-c:a", "aac", "-b:a", `${AUDIO_KBPS}k`] : []),
    ...encoders.codecArgs(e, goal, true),
    "-movflags", "+faststart", out,
  ];
}

module.exports = { plan, copyBlockers, copyArgs, encodeArgs };
