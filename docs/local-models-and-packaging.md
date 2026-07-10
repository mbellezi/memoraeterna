# Modelos Locais e Empacotamento

## Runtimes

O desktop oferece dois runtimes locais, ambos restritos ao main process ou a
processos controlados por ele:

- GGUF via `node-llama-cpp 3.19.0`;
- MLX via o helper Swift `native/mlx-helper`, somente em macOS arm64, com
  `mlx-swift 0.31.6`, `mlx-swift-lm 3.31.4` e `swift-transformers 1.3.3`.

O helper MLX recebe uma requisicao JSONL versionada, carrega apenas o diretorio
local ja verificado e emite progresso e resultado em JSONL. Ele nao usa Python,
nao instala pacotes e nao baixa pesos. Cancelamento e timeout encerram o helper
controlado pelo desktop.

Build do helper:

```bash
npm run mlx:build
```

## Catalogo auditado

Auditoria realizada em 2026-07-10 usando a API do Hugging Face. O catalogo em
`packages/ai/src/local-model-catalog.ts` fixa todos os arquivos, tamanhos e
SHA-256.

| Id | Repositorio | Revision | Tamanho esperado | Licenca |
| --- | --- | --- | ---: | --- |
| `mlx-gemma-4-e4b-it-4bit` | `mlx-community/gemma-4-e4b-it-4bit` | `475b9088d29754a3379866cf5aeb6b41acd313c2` | 5.18 GB | Gemma, aceite explicito |
| `mlx-gemma-4-12b-it-4bit` | `mlx-community/gemma-4-12B-it-4bit` | `73bcf09092aa277861d5a191b989b666f7f32e8f` | 6.77 GB | Gemma, aceite explicito |
| `mlx-qwen3-4b-instruct-2507-4bit` | `mlx-community/Qwen3-4B-Instruct-2507-4bit` | `50d427756c6b1b2fe0c0a10f67fbda1fc8e82c1b` | 2.28 GB | Apache-2.0 |

Capabilities multimodais nao sao declaradas. Elas so devem entrar no catalogo
depois de validacao real do adapter e das modalidades correspondentes.

## Download e armazenamento

Os modelos ficam em `userData/local-models/<catalog-id>`. O downloader:

- faz preflight de plataforma, memoria e espaco livre;
- envia token opcional da Hugging Face somente no header de autorizacao;
- usa arquivos `.partial` e `Range` para retomada;
- persiste job, arquivo atual, bytes, velocidade, ETA e checkpoint;
- verifica tamanho e SHA-256 antes de promover cada arquivo por rename atomico;
- retoma jobs interrompidos ao reabrir o app;
- restringe remocao a pasta gerenciada e bloqueia modelos em uso ou usados por
  um perfil ativo.

O token fica no `safeStorage`; banco e logs guardam apenas sua referencia. Um
arquivo GGUF existente tambem pode ser importado para a pasta gerenciada. Seu
SHA-256 passa a ser a revision local imutavel.

## Backup e limites

Settings permite criar um backup contendo:

- dump custom do banco via `pg_dump`;
- pasta gerenciada do Obsidian, quando configurada;
- pasta de copias de uploads, quando habilitada.

Limites operacionais configuraveis:

| Variavel | Default |
| --- | ---: |
| `MEMORA_MAX_IMPORT_BYTES` | 512 MiB |
| `MEMORA_DOCLING_TIMEOUT_MS` | 300000 ms |
| `MEMORA_DOCLING_MAX_OUTPUT_BYTES` | 256 MiB |
| `MEMORA_DOCLING_MAX_PAGES` | 500 paginas |

## Pacote desktop

O staging reproduzivel dos recursos e criado com:

```bash
node scripts/prepare-desktop-resources.mjs
```

Ele copia migrations, baseline, PostgreSQL, o sidecar CPython/Docling offline e
o helper MLX para `apps/desktop/build-resources`, gerando
`runtime-manifest.json` com SHA-256 de cada arquivo e `sbom.spdx.json` com os
pacotes Python e modelos. Todos os artefatos da plataforma alvo sao
obrigatorios: o build falha, em vez de produzir um app parcialmente funcional,
quando algum deles nao foi materializado.

Antes de empacotar, materialize e valide o sidecar de conversao:

```bash
npm run docling:build
npm run docling:verify
npm run docling:smoke
```

Pacote sem instalador:

```bash
npm run package:desktop:dir
```

Smoke repetivel do `.app` contra um `userData` temporario:

```bash
npm run package:desktop:smoke
```

DMG/ZIP macOS:

```bash
npm run package:desktop:mac
```

O alvo de distribuicao materializado nesta fase e macOS arm64. Assinatura e
notarizacao usam as credenciais padrao suportadas pelo `electron-builder`; elas
nao ficam no repositorio. A publicacao so deve ocorrer depois de validar o
manifest, a assinatura, a notarizacao e uma instalacao limpa em uma maquina sem
Python do sistema.
