//! Helpers para executar ffmpeg/ffprobe sem abrir janelas de console no Windows.

use std::process::{Command, Output, Stdio};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn cmd(program: &str) -> Command {
    let mut c = Command::new(program);
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    c.stdin(Stdio::null());
    c
}

pub fn run<S: AsRef<std::ffi::OsStr>>(program: &str, args: &[S]) -> Result<Output, String> {
    cmd(program)
        .args(args)
        .output()
        .map_err(|e| format!("Não foi possível executar o {program}: {e}"))
}

/// Versão do FFmpeg, ou erro amigável se ele não estiver instalado.
pub fn version() -> Result<String, String> {
    let out = run("ffmpeg", &["-hide_banner", "-version"]).map_err(|_| {
        "FFmpeg não encontrado. Instale com `winget install Gyan.FFmpeg` e reabra o app.".to_string()
    })?;
    let text = String::from_utf8_lossy(&out.stdout);
    let first = text.lines().next().unwrap_or_default();
    Ok(first.split_whitespace().nth(2).unwrap_or("desconhecida").to_string())
}

pub fn stderr(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).into_owned()
}

/// Última linha útil do stderr, para mensagens de erro curtas.
pub fn last_error_line(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .last()
        .unwrap_or("erro desconhecido")
        .to_string()
}
