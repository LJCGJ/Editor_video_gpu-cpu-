# SmartRender

Conversor de vídeo que **mede** GPU e CPU no seu próprio vídeo e escolhe a melhor forma de processar:
só GPU, só CPU, ou as duas ao mesmo tempo — e explica o porquê.

## Como rodar

Requisitos: Node.js 20+ e FFmpeg no PATH (`winget install Gyan.FFmpeg`).

```bash
npm install
npm start
```

## Gerar o instalador (Windows)

Requisito extra: [Inno Setup 6](https://jrsoftware.org/isinfo.php).

```bash
npm run installer
```

O instalador sai em `dist/SmartRender-Setup-0.2.0.exe`. Ele instala só para o usuário atual (sem pedir senha de
administrador), cria atalhos e desinstalador, e avisa no final se o FFmpeg não estiver instalado.
O FFmpeg não vai embutido: ocuparia mais de 400 MB e exigiria cumprir a licença GPL ao distribuir.

## Como funciona

1. **Hardware** (`src/hardware.js`): identifica CPU e GPUs e testa de verdade cada codificador
   (x264, x265, SVT-AV1, Quick Sync, NVENC, AMF) com 5 quadros sintéticos.
2. **Vídeo** (`src/probe.js`): lê formato, bit depth e subamostragem de cor, e testa se a GPU consegue
   decodificar o arquivo (vídeos 10-bit 4:2:2 de câmera geralmente não conseguem).
3. **Mini-benchmark** (`src/benchmark.js`): codifica 5 s do meio do vídeo (começando num quadro-chave)
   com cada opção, mede a velocidade em regime, o custo fixo de inicialização, a qualidade (SSIM) e o tamanho.
   Também roda GPU e CPU ao mesmo tempo para medir o ganho real do modo híbrido.
4. **Recomendação** (`src/recommend.js`): dá uma nota por objetivo (rápido / qualidade / arquivo menor)
   e gera as explicações. O híbrido só é sugerido se for pelo menos 15% mais rápido.
5. **Conversão** (`src/convert.js`): converte com progresso, tempo restante e cancelamento.
   No modo híbrido, divide o vídeo proporcionalmente à velocidade de cada um, codifica as duas partes
   em paralelo e junta tudo sem recodificar.

## Juntar vídeos (`src/join.js`)

Na aba **🔗 Juntar vídeos**, escolha ou arraste vários vídeos, ordene com ↑ ↓ e clique em **Planejar a junção**:

- **Mesmo formato** (codec, resolução, quadros por segundo, cor e áudio): os arquivos são emendados direto,
  sem recodificar. É quase instantâneo e não perde qualidade.
- **Formatos diferentes**: todos são ajustados para a resolução e a taxa de quadros do primeiro vídeo
  (com tarjas pretas quando a proporção muda, por exemplo um vídeo vertical no meio de horizontais).
  Os vídeos sem áudio ganham silêncio. O mesmo teste de 5 s escolhe entre GPU e CPU, medindo no vídeo mais longo.

## Limitações conhecidas

- A estimativa de tempo do modo híbrido é menos precisa que a das outras opções
  (a janela em que GPU e CPU rodam juntas no teste de 5 s é curta).
- Modo híbrido ainda não disponível para AV1.
- Funciona no Windows 10 e 11 (64 bits). O Electron 38 não roda no Windows 7/8.
- A versão em Rust (Tauri) está na raiz deste repositório e ainda não tem a junção de vídeos.
