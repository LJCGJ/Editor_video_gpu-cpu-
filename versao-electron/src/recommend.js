// Motor de recomendação: dá uma nota a cada opção conforme o objetivo do usuário
// e escreve, em português claro, por que ela foi (ou não foi) escolhida.

/** Diferença de SSIM abaixo da qual ninguém percebe a diferença a olho nu. */
const IMPERCEPTIBLE_SSIM = 0.002;
/** O modo híbrido só vale a pena se for pelo menos 15% mais rápido que a melhor opção sozinha. */
const MIN_HYBRID_GAIN = 0.15;

/** Pesos de velocidade, qualidade e tamanho para cada objetivo. */
const WEIGHTS = {
  speed: [0.7, 0.2, 0.1],
  quality: [0.15, 0.7, 0.15],
  size: [0.15, 0.25, 0.6],
};

function rank(opts, goal, integratedGpu) {
  const maxFps = Math.max(...opts.map((o) => o.fps));
  const bestSsim = Math.max(...opts.map((o) => o.ssim));
  const minBytes = Math.max(1, Math.min(...opts.map((o) => o.estBytes)));
  const bestSingleFps = Math.max(...opts.filter((o) => o.kind !== "hybrid").map((o) => o.fps));
  const [ws, wq, wz] = WEIGHTS[goal];

  for (const o of opts) {
    const sSpeed = o.fps / maxFps;
    // Perder 0,02 de SSIM já é uma perda bem visível, então vira nota zero.
    const sQuality = 1 - clamp((bestSsim - o.ssim) / 0.02, 0, 1);
    const sSize = minBytes / Math.max(1, o.estBytes);
    o.score = ws * sSpeed + wq * sQuality + wz * sSize;

    if (o.kind === "hybrid") {
      const gain = o.fps / bestSingleFps - 1;
      if (gain < MIN_HYBRID_GAIN) {
        o.eligible = false;
        o.reasons.push(
          gain < 0
            ? `Nesta máquina, usar as duas juntas fica ${Math.round(-gain * 100)}% mais lento que a melhor opção sozinha.`
            : `Usar as duas juntas renderia só ${signedPct(gain)}% de velocidade nesta máquina, então não compensa.`
        );
        if (integratedGpu) {
          o.reasons.push(
            "Em GPUs integradas (Intel Iris/UHD), a GPU divide energia e temperatura com o processador: quando os dois trabalham juntos, cada um fica mais lento."
          );
        }
      }
    }
  }

  const rec = opts.filter((o) => o.eligible).reduce((a, b) => (b.score > a.score ? b : a));
  rec.recommended = true;

  const cpu = opts.find((o) => o.kind === "cpu");
  const fastestGpu = opts.filter((o) => o.kind === "gpu").sort((a, b) => b.fps - a.fps)[0];

  const why = [`Termina em ~${fmtDur(rec.estSeconds)} (${dec(rec.speedX, 1)}× a velocidade de reprodução).`];
  if (rec.kind === "gpu") {
    if (cpu) {
      why.push(`${dec(rec.fps / cpu.fps, 1)}× mais rápido que codificar só na CPU.`);
      if (cpu.ssim - rec.ssim <= IMPERCEPTIBLE_SSIM) {
        why.push("Qualidade praticamente igual à da CPU (diferença imperceptível).");
      } else {
        why.push(
          `A CPU teria qualidade um pouco maior (SSIM ${dec(cpu.ssim, 4)} contra ${dec(rec.ssim, 4)}), mas para o seu objetivo a velocidade pesa mais.`
        );
      }
      const bigger = rec.estBytes / Math.max(1, cpu.estBytes) - 1;
      if (bigger > 0.1) why.push(`Em troca, o arquivo fica ~${Math.round(bigger * 100)}% maior que o da CPU.`);
    }
  } else if (rec.kind === "cpu") {
    if (fastestGpu) {
      const faster = dec(fastestGpu.fps / rec.fps, 1);
      why.push(
        {
          quality: `A GPU seria ${faster}× mais rápida, mas a CPU entrega a melhor qualidade (SSIM ${dec(rec.ssim, 4)} contra ${dec(fastestGpu.ssim, 4)}).`,
          size: `A GPU seria ${faster}× mais rápida, mas o arquivo da CPU fica ~${Math.round((1 - rec.estBytes / Math.max(1, fastestGpu.estBytes)) * 100)}% menor.`,
          speed: `Neste vídeo a CPU foi mais rápida que a GPU (${dec(rec.speedX, 1)}× contra ${dec(fastestGpu.speedX, 1)}×).`,
        }[goal]
      );
    } else {
      why.push("Nenhuma GPU com codificador para este formato foi encontrada.");
    }
  } else {
    why.push(
      `Divide o vídeo: ${Math.round(rec.gpuShare * 100)}% na GPU e ${Math.round((1 - rec.gpuShare) * 100)}% na CPU, ao mesmo tempo. ` +
        `Fica ${Math.round((rec.fps / bestSingleFps - 1) * 100)}% mais rápido que a melhor opção sozinha.`
    );
  }
  if (goal === "quality" && rec.ssim >= bestSsim && opts.length > 1) why.push("Melhor qualidade entre as opções testadas.");
  if (goal === "size" && rec.estBytes <= minBytes && opts.length > 1) why.push(`Gera o menor arquivo: ~${fmtBytes(rec.estBytes)}.`);
  why.push(
    rec.hwDecode
      ? "A GPU também faz a leitura (decodificação) do vídeo, aliviando a CPU."
      : "Sua GPU não lê este formato, então a leitura do vídeo fica com a CPU."
  );
  rec.reasons.push(...why);

  // Para as outras opções: uma linha comparando com a recomendada.
  for (const o of opts.filter((x) => !x.recommended && x.eligible)) {
    const diffs = [];
    if (o.fps < rec.fps * 0.9) diffs.push(`${dec(rec.fps / o.fps, 1)}× mais lenta`);
    else if (o.fps > rec.fps * 1.1) diffs.push(`${dec(o.fps / rec.fps, 1)}× mais rápida`);
    if (rec.ssim - o.ssim > IMPERCEPTIBLE_SSIM) diffs.push("qualidade menor");
    else if (o.ssim - rec.ssim > IMPERCEPTIBLE_SSIM) diffs.push("qualidade maior");
    const size = o.estBytes / Math.max(1, rec.estBytes) - 1;
    if (size > 0.1) diffs.push(`arquivo ${Math.round(size * 100)}% maior`);
    else if (size < -0.1) diffs.push(`arquivo ${Math.round(-size * 100)}% menor`);
    o.reasons.push(diffs.length ? `Comparada à recomendada: ${diffs.join(", ")}.` : "Resultado muito parecido com a recomendada.");
  }

  return `Recomendado: ${rec.title} · termina em ~${fmtDur(rec.estSeconds)} · arquivo de ~${fmtBytes(rec.estBytes)}`;
}

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** Número com vírgula decimal, no padrão brasileiro. */
const dec = (x, places) => x.toFixed(places).replace(".", ",");

const signedPct = (x) => `${x >= 0 ? "+" : ""}${Math.round(x * 100)}`;

function fmtDur(s) {
  s = Math.round(Math.max(1, s));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
  return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")} min`;
}

function fmtBytes(b) {
  const mb = b / 1048576;
  return mb >= 1024 ? `${dec(mb / 1024, 2)} GB` : `${dec(mb, 1)} MB`;
}

module.exports = { rank };
