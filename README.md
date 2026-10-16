# SmartRender (versão Rust + Tauri)

Conversor de vídeo que **mede** GPU e CPU no seu próprio vídeo e escolhe a melhor forma de processar:
só GPU, só CPU, ou as duas ao mesmo tempo, e explica o porquê.

É a mesma aplicação da versão Electron, com o backend reescrito em **Rust**. A interface (`ui/`) é a mesma;
só muda a ponte `ui/bridge-tauri.js`, que conversa com o Rust em vez do Node.

> ⚠️ Este código **não foi compilado na máquina onde foi escrito**: o antivírus corporativo (Panda) bloqueia
> os executáveis que o `cargo` gera durante a compilação. A lógica é a mesma da versão Electron, que foi testada
> de ponta a ponta. Se aparecer algum erro de compilação, é uma ótima primeira lição: leia a mensagem do
> `rustc` com calma, porque ela costuma dizer exatamente o que corrigir.

---

## 1. Preparar a máquina (Windows)

| O quê | Como instalar | Para quê |
|---|---|---|
| **Rust** | <https://rustup.rs> → `rustup-init.exe` (perfil padrão) | Compilador, `cargo`, `clippy`, `rustfmt` |
| **Ferramentas C++ da Microsoft** | Visual Studio Installer → *Desenvolvimento para desktop com C++* (ou "Build Tools for Visual Studio") | O Rust no Windows usa o linker da Microsoft |
| **WebView2** | Já vem no Windows 11 | Onde a interface é desenhada |
| **Node.js 20+** | <https://nodejs.org> | Só para a CLI do Tauri (`npm run dev`) |
| **FFmpeg** | `winget install Gyan.FFmpeg` | Quem faz o trabalho pesado com o vídeo |

Confira no terminal:

```bash
cargo --version
node --version
ffmpeg -version
```

## 2. Abrir no VS Code

1. **Arquivo → Abrir Pasta…** e escolha esta pasta (`smartrender-tauri`).
2. Aceite instalar as **extensões recomendadas** (rust-analyzer, Tauri, CodeLLDB, TOML).
3. Espere o rust-analyzer terminar de indexar (barra de status, embaixo). Na primeira vez, demora alguns minutos.

## 3. Rodar, testar e gerar o instalador

No terminal do VS Code (**Terminal → Novo Terminal**):

```bash
npm install
npm run dev
```

A primeira compilação leva de 3 a 8 minutos (o Rust compila todas as dependências). As seguintes levam segundos.

Também dá para usar **Terminal → Executar Tarefa…**:

| Tarefa | O que faz |
|---|---|
| Rodar o app (tauri dev) | Compila e abre o app (atalho: `Ctrl+Shift+B`) |
| Rodar os testes (cargo test) | Roda os testes automáticos (não precisa de FFmpeg) |
| Verificar o código (cargo clippy) | Revisor oficial do Rust: aponta código que pode melhorar |
| Gerar instalador (tauri build) | Cria o instalador `.exe` em `src-tauri/target/release/bundle/nsis/` |

**Depurar:** coloque um ponto de parada (clique à esquerda do número da linha num `.rs`) e aperte **F5**.

---

## 4. Guia para aprender Rust com este projeto

### Antes de começar
- **O Livro** (oficial e gratuito): <https://doc.rust-lang.org/book/>. Leia os capítulos 1 a 9 antes de mexer no código.
- **Rustlings** (exercícios pequenos no terminal): <https://rustlings.rust-lang.org>.
- **Rust by Example**: <https://doc.rust-lang.org/rust-by-example/>.

### Ordem sugerida de leitura do código

Do mais simples ao mais avançado:

| # | Arquivo | O que ele faz | Conceitos de Rust que aparecem |
|---|---|---|---|
| 1 | [`ffmpeg.rs`](src-tauri/src/ffmpeg.rs) | Roda o FFmpeg sem abrir janela | `fn`, `Result<T, E>`, `?`, `map_err`, `#[cfg(windows)]`, genéricos (`<S: AsRef<OsStr>>`) |
| 2 | [`encoders.rs`](src-tauri/src/encoders.rs) | Lista de codificadores e parâmetros | `enum`, `struct`, `const`, `match` com guardas (`if`), `#[derive]`, `serde` |
| 3 | [`recommend.rs`](src-tauri/src/recommend.rs) | Dá nota às opções e escreve os motivos | iteradores (`iter`, `filter`, `map`, `fold`), closures, `&mut`, `Option`, testes (`#[test]`) |
| 4 | [`probe.rs`](src-tauri/src/probe.rs) | Lê as informações do vídeo | `serde_json::Value`, `if let`, `let ... else`, `Option` encadeado (`and_then`, `unwrap_or`) |
| 5 | [`hardware.rs`](src-tauri/src/hardware.rs) | Descobre CPU, GPU e codificadores | **threads** (`thread::spawn`, `join`), `move`, referências `'static` |
| 6 | [`benchmark.rs`](src-tauri/src/benchmark.rs) | Teste de 5 segundos | `impl` (métodos), processos com `Stdio::piped`, `BufReader`, leitura linha a linha |
| 7 | [`convert.rs`](src-tauri/src/convert.rs) | Conversão com progresso e cancelamento | `Arc<Mutex<T>>`, `AtomicBool`, `thread::scope`, tempo de vida (`<'a>`) |
| 8 | [`main.rs`](src-tauri/src/main.rs) | Liga tudo ao Tauri | `async fn`, `#[tauri::command]`, estado compartilhado (`State`) |

### Os 3 conceitos que mais vão aparecer

1. **Posse e empréstimo (ownership/borrowing).** Cada valor tem um único dono. `&x` empresta para leitura e
   `&mut x` empresta para alteração. É por isso que em `convert.rs` o progresso compartilhado fica dentro de um
   `Mutex`: várias threads querem alterar o mesmo dado.
2. **Erros sem exceções.** As funções devolvem `Result<Ok, Erro>`, e o `?` repassa o erro para quem chamou.
   Veja `probe::analyze`: cada `?` é um ponto onde a análise pode falhar com uma mensagem amigável.
3. **`Option` em vez de `null`.** Se pode não existir, é `Option<T>` (`Some(valor)` ou `None`). Em `probe.rs`,
   `audio_codec: Option<String>` diz que o vídeo pode não ter áudio, e o compilador obriga você a tratar esse caso.

### Exercícios (do mais fácil ao mais difícil)

1. **Rode os testes** (`cargo test`) e depois quebre um de propósito, por exemplo mudando `"5,0 MB"` para `"5 MB"`
   em `recommend.rs`. Veja como o Rust mostra a diferença.
2. **Mude o tamanho do teste**: em `benchmark.rs`, troque `SAMPLE_SECONDS` de `5.0` para `8.0`. As estimativas
   ficam mais precisas? A análise demora quanto a mais?
3. **Novo objetivo "Equilibrado"**: acrescente `Balanced` ao `enum Goal` em `encoders.rs`. O compilador vai apontar
   todos os `match` que precisam tratar o novo caso, um ótimo jeito de ver o Rust te guiando. Depois, crie o botão
   no `ui/index.html`.
4. **Escreva um teste** em `recommend.rs` provando que, com o objetivo `Size`, a opção de menor arquivo vence.
5. **Novo codificador**: acrescente o `h264_mf` (Media Foundation, que vem no Windows) em `ENCODERS`, com seus
   parâmetros em `tuning`.
6. **Desafio**: guarde os resultados de cada análise num arquivo JSON (`serde_json::to_writer`) e use o histórico
   para pular o benchmark quando o mesmo tipo de vídeo aparecer de novo.

---

## 5. Como o app funciona

1. **Hardware**: identifica CPU e GPUs e testa de verdade cada codificador (x264, x265, SVT-AV1, Quick Sync,
   NVENC, AMF) com 5 quadros sintéticos.
2. **Vídeo**: lê formato, bit depth e subamostragem de cor, e testa se a GPU consegue decodificar o arquivo.
   Vídeos 10-bit 4:2:2 de câmera geralmente não conseguem.
3. **Mini-benchmark**: codifica 5 s do meio do vídeo, começando num quadro-chave, com cada opção. Mede a
   velocidade em regime, o custo fixo de inicialização, a qualidade (SSIM) e o tamanho. Também roda GPU e CPU
   ao mesmo tempo para medir o ganho real do modo híbrido.
4. **Recomendação**: dá uma nota por objetivo (rápido, qualidade ou arquivo menor) e gera as explicações.
   O híbrido só é sugerido se for pelo menos 15% mais rápido.
5. **Conversão**: mostra progresso, tempo restante e permite cancelar. No modo híbrido, divide o vídeo
   proporcionalmente à velocidade de cada um, codifica as duas partes em paralelo e junta tudo sem recodificar.

## Problemas comuns

| Erro | Solução |
|---|---|
| `linker 'link.exe' not found` | Instale as ferramentas C++ (passo 1) e reabra o VS Code |
| `Acesso negado (os error 5)` ao compilar | Antivírus bloqueando. Peça uma exclusão para esta pasta e para `%USERPROFILE%\.cargo` |
| "FFmpeg não encontrado" no app | `winget install Gyan.FFmpeg` e reabra o terminal |
| rust-analyzer reclama de `clippy` | Rode `rustup component add clippy` |

O `Cargo.toml` fixa `idna_adapter = "=1.1.0"` para contornar o antivírus da máquina original. Em outras
máquinas, essa linha é opcional e pode ser removida.
# Editor_video_gpu-cpu-
