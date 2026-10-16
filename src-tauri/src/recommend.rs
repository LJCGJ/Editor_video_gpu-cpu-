//! Motor de recomendação: dá uma nota a cada opção conforme o objetivo do usuário
//! e escreve, em português claro, por que ela foi (ou não foi) escolhida.

use crate::benchmark::Opcao;
use crate::encoders::Goal;

/// Diferença de SSIM abaixo da qual ninguém percebe a diferença a olho nu.
const IMPERCEPTIBLE_SSIM: f64 = 0.002;
/// O modo híbrido só vale a pena se for pelo menos 15% mais rápido que a melhor opção sozinha.
const MIN_HYBRID_GAIN: f64 = 0.15;

pub fn rank(opts: &mut [Opcao], goal: Goal, integrated_gpu: bool) -> String {
    let max_fps = opts.iter().map(|o| o.fps).fold(0.0, f64::max);
    let best_ssim = opts.iter().map(|o| o.ssim).fold(0.0, f64::max);
    let min_bytes = opts.iter().map(|o| o.est_bytes).min().unwrap_or(1).max(1) as f64;
    let best_single_fps = opts
        .iter()
        .filter(|o| o.kind != "hybrid")
        .map(|o| o.fps)
        .fold(0.0, f64::max);

    // Pesos: velocidade, qualidade, tamanho.
    let (ws, wq, wz) = match goal {
        Goal::Speed => (0.7, 0.2, 0.1),
        Goal::Quality => (0.15, 0.7, 0.15),
        Goal::Size => (0.15, 0.25, 0.6),
    };

    for o in opts.iter_mut() {
        let s_speed = o.fps / max_fps;
        // Perder 0,02 de SSIM já é uma perda bem visível, então vira nota zero.
        let s_quality = 1.0 - ((best_ssim - o.ssim) / 0.02).clamp(0.0, 1.0);
        let s_size = min_bytes / (o.est_bytes as f64).max(1.0);
        o.score = ws * s_speed + wq * s_quality + wz * s_size;

        if o.kind == "hybrid" {
            let gain = o.fps / best_single_fps - 1.0;
            if gain < MIN_HYBRID_GAIN {
                o.eligible = false;
                o.reasons.push(if gain < 0.0 {
                    format!(
                        "Nesta máquina, usar as duas juntas fica {:.0}% mais lento que a melhor opção sozinha.",
                        -gain * 100.0
                    )
                } else {
                    format!(
                        "Usar as duas juntas renderia só {}% de velocidade nesta máquina, então não compensa.",
                        signed_pct(gain)
                    )
                });
                if integrated_gpu {
                    o.reasons.push(
                        "Em GPUs integradas (Intel Iris/UHD), a GPU divide energia e temperatura com o processador: quando os dois trabalham juntos, cada um fica mais lento."
                            .into(),
                    );
                }
            }
        }
    }

    let rec_idx = opts
        .iter()
        .enumerate()
        .filter(|(_, o)| o.eligible)
        .max_by(|a, b| a.1.score.total_cmp(&b.1.score))
        .map(|(i, _)| i)
        .unwrap_or(0);
    opts[rec_idx].recommended = true;
    let rec = opts[rec_idx].clone();

    let cpu = opts.iter().find(|o| o.kind == "cpu").cloned();
    let fastest_gpu = opts
        .iter()
        .filter(|o| o.kind == "gpu")
        .max_by(|a, b| a.fps.total_cmp(&b.fps))
        .cloned();

    let mut why = vec![format!(
        "Termina em ~{} ({}× a velocidade de reprodução).",
        fmt_dur(rec.est_seconds),
        dec(rec.speed_x, 1)
    )];
    match rec.kind.as_str() {
        "gpu" => {
            if let Some(c) = &cpu {
                why.push(format!("{}× mais rápido que codificar só na CPU.", dec(rec.fps / c.fps, 1)));
                if c.ssim - rec.ssim <= IMPERCEPTIBLE_SSIM {
                    why.push("Qualidade praticamente igual à da CPU (diferença imperceptível).".into());
                } else {
                    why.push(format!(
                        "A CPU teria qualidade um pouco maior (SSIM {} contra {}), mas para o seu objetivo a velocidade pesa mais.",
                        dec(c.ssim, 4), dec(rec.ssim, 4)
                    ));
                }
                let bigger = rec.est_bytes as f64 / c.est_bytes.max(1) as f64 - 1.0;
                if bigger > 0.1 {
                    why.push(format!("Em troca, o arquivo fica ~{:.0}% maior que o da CPU.", bigger * 100.0));
                }
            }
        }
        "cpu" => match &fastest_gpu {
            Some(g) => {
                let faster = dec(g.fps / rec.fps, 1);
                why.push(match goal {
                    Goal::Quality => format!(
                        "A GPU seria {faster}× mais rápida, mas a CPU entrega a melhor qualidade (SSIM {} contra {}).",
                        dec(rec.ssim, 4), dec(g.ssim, 4)
                    ),
                    Goal::Size => format!(
                        "A GPU seria {faster}× mais rápida, mas o arquivo da CPU fica ~{:.0}% menor.",
                        (1.0 - rec.est_bytes as f64 / g.est_bytes.max(1) as f64) * 100.0
                    ),
                    Goal::Speed => format!(
                        "Neste vídeo a CPU foi mais rápida que a GPU ({}× contra {}×).",
                        dec(rec.speed_x, 1), dec(g.speed_x, 1)
                    ),
                });
            }
            None => why.push("Nenhuma GPU com codificador para este formato foi encontrada.".into()),
        },
        _ => {
            why.push(format!(
                "Divide o vídeo: {:.0}% na GPU e {:.0}% na CPU, ao mesmo tempo. Fica {:.0}% mais rápido que a melhor opção sozinha.",
                rec.gpu_share * 100.0,
                (1.0 - rec.gpu_share) * 100.0,
                (rec.fps / best_single_fps - 1.0) * 100.0
            ));
        }
    }
    if goal == Goal::Quality && rec.ssim >= best_ssim && opts.len() > 1 {
        why.push("Melhor qualidade entre as opções testadas.".into());
    }
    if goal == Goal::Size && rec.est_bytes as f64 <= min_bytes && opts.len() > 1 {
        why.push(format!("Gera o menor arquivo: ~{}.", fmt_bytes(rec.est_bytes)));
    }
    why.push(if rec.hw_decode {
        "A GPU também faz a leitura (decodificação) do vídeo, aliviando a CPU.".into()
    } else {
        "Sua GPU não lê este formato, então a leitura do vídeo fica com a CPU.".into()
    });
    opts[rec_idx].reasons.extend(why);

    // Para as outras opções: uma linha comparando com a recomendada.
    for o in opts.iter_mut().filter(|o| !o.recommended && o.eligible) {
        let mut diffs = vec![];
        if o.fps < rec.fps * 0.9 {
            diffs.push(format!("{}× mais lenta", dec(rec.fps / o.fps, 1)));
        } else if o.fps > rec.fps * 1.1 {
            diffs.push(format!("{}× mais rápida", dec(o.fps / rec.fps, 1)));
        }
        if rec.ssim - o.ssim > IMPERCEPTIBLE_SSIM {
            diffs.push("qualidade menor".into());
        } else if o.ssim - rec.ssim > IMPERCEPTIBLE_SSIM {
            diffs.push("qualidade maior".into());
        }
        let size = o.est_bytes as f64 / rec.est_bytes.max(1) as f64 - 1.0;
        if size > 0.1 {
            diffs.push(format!("arquivo {:.0}% maior", size * 100.0));
        } else if size < -0.1 {
            diffs.push(format!("arquivo {:.0}% menor", -size * 100.0));
        }
        o.reasons.push(if diffs.is_empty() {
            "Resultado muito parecido com a recomendada.".into()
        } else {
            format!("Comparada à recomendada: {}.", diffs.join(", "))
        });
    }

    format!(
        "Recomendado: {} · termina em ~{} · arquivo de ~{}",
        rec.title,
        fmt_dur(rec.est_seconds),
        fmt_bytes(rec.est_bytes)
    )
}

/// Número com vírgula decimal, no padrão brasileiro.
pub fn dec(x: f64, places: usize) -> String {
    format!("{x:.places$}").replace('.', ",")
}

fn signed_pct(x: f64) -> String {
    format!("{:+.0}", x * 100.0)
}

pub fn fmt_dur(s: f64) -> String {
    let s = s.max(1.0).round() as u64;
    if s < 60 {
        format!("{s} s")
    } else if s < 3600 {
        format!("{} min {:02} s", s / 60, s % 60)
    } else {
        format!("{} h {:02} min", s / 3600, (s % 3600) / 60)
    }
}

pub fn fmt_bytes(b: u64) -> String {
    let mb = b as f64 / 1_048_576.0;
    if mb >= 1024.0 {
        format!("{} GB", dec(mb / 1024.0, 2))
    } else {
        format!("{} MB", dec(mb, 1))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Opção fictícia com só o que importa para a nota.
    fn opt(kind: &str, fps: f64, ssim: f64, mb: u64) -> Opcao {
        Opcao {
            id: kind.into(),
            kind: kind.into(),
            title: kind.to_uppercase(),
            detail: String::new(),
            gpu_encoder: (kind != "cpu").then(|| "h264_qsv".into()),
            cpu_encoder: (kind != "gpu").then(|| "libx264".into()),
            gpu_share: if kind == "gpu" { 1.0 } else { 0.5 },
            hw_decode: true,
            fps,
            speed_x: fps / 30.0,
            ssim,
            ssim_db: 0.0,
            est_seconds: 900.0 / fps,
            est_bytes: mb * 1_048_576,
            score: 0.0,
            recommended: false,
            eligible: true,
            reasons: vec![],
        }
    }

    fn recommended(opts: &[Opcao]) -> &str {
        &opts.iter().find(|o| o.recommended).unwrap().kind
    }

    #[test]
    fn formata_no_padrao_brasileiro() {
        assert_eq!(dec(3.14159, 2), "3,14");
        assert_eq!(fmt_dur(42.4), "42 s");
        assert_eq!(fmt_dur(125.0), "2 min 05 s");
        assert_eq!(fmt_dur(3725.0), "1 h 02 min");
        assert_eq!(fmt_bytes(5 * 1_048_576), "5,0 MB");
        assert_eq!(fmt_bytes(2 * 1_073_741_824), "2,00 GB");
    }

    #[test]
    fn hibrido_com_pouco_ganho_nao_e_recomendado() {
        let mut opts = vec![opt("gpu", 200.0, 0.995, 120), opt("cpu", 100.0, 0.996, 100), opt("hybrid", 210.0, 0.995, 110)];
        rank(&mut opts, Goal::Speed, true);
        assert_eq!(recommended(&opts), "gpu");
        let hybrid = opts.iter().find(|o| o.kind == "hybrid").unwrap();
        assert!(!hybrid.eligible);
        assert!(hybrid.reasons.iter().any(|r| r.contains("não compensa")));
    }

    #[test]
    fn hibrido_com_ganho_real_e_recomendado_para_velocidade() {
        let mut opts = vec![opt("gpu", 200.0, 0.995, 120), opt("cpu", 100.0, 0.996, 100), opt("hybrid", 260.0, 0.995, 110)];
        rank(&mut opts, Goal::Speed, false);
        assert_eq!(recommended(&opts), "hybrid");
    }

    #[test]
    fn qualidade_escolhe_a_cpu_quando_a_gpu_perde_nitidez() {
        let mut opts = vec![opt("gpu", 200.0, 0.970, 100), opt("cpu", 50.0, 0.999, 100)];
        rank(&mut opts, Goal::Quality, false);
        assert_eq!(recommended(&opts), "cpu");
    }

    #[test]
    fn velocidade_escolhe_a_gpu_quando_a_qualidade_empata() {
        let mut opts = vec![opt("gpu", 200.0, 0.995, 100), opt("cpu", 50.0, 0.996, 100)];
        let summary = rank(&mut opts, Goal::Speed, false);
        assert_eq!(recommended(&opts), "gpu");
        assert!(summary.starts_with("Recomendado: GPU"));
    }
}
