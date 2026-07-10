# Memora Eterna - Mapa do Projeto

Este arquivo e o mapa operacional inicial do repositorio para agentes de
codificacao. Ele deve ser atualizado quando a arquitetura, estrutura de pastas,
scripts ou fluxos centrais mudarem.

Leia tambem, antes de editar codigo:

- `RULES.md`
- `GUIDELINES_GTP.md`
- `docs/initial.md`
- `docs/mvp-implementation-plan.md`
- `docs/stack-versions.md`

## Estado Atual

Fase atual: Fase 5 - Fechamento implementada em codigo, migrations, runtimes e
testes automatizados. O pacote macOS arm64 sem instalador foi gerado; assinatura,
notarizacao e smoke tests manuais nos hosts Chrome/Obsidian continuam como
validacoes de distribuicao.

Implementado ate aqui:

- monorepo npm com workspaces em `apps/*` e `packages/*`;
- aplicacao Electron em `apps/desktop` com React 19, Tailwind 4,
  `electron-vite`, preload seguro e IPC validado por Zod;
- i18n inicial em `@app/i18n` para `en`, `pt-BR`, `it`, `fr` e `es`;
- schemas canonicos iniciais em `@app/domain`;
- contratos iniciais em `@app/integration-contracts`;
- pacote `@app/db` com schema Drizzle, migration inicial, repositorios,
  seed/baseline inicial, cliente `pg` e manager de PostgreSQL sidecar;
- sidecar DEV de PostgreSQL 18.4 com pgvector 0.8.4 e Apache AGE
  `PG18/v1.7.0-rc0`;
- runtime do banco no main process do desktop: safeStorage, data dir em
  `userData`, `MEMORA_DATABASE_PORT` com fallback dinamico, migrations no boot
  e shutdown controlado;
- UI de bootstrap que espera o banco local ficar pronto antes de liberar a
  shell principal;
- preferencias de UI persistidas via settings: idioma inicial vindo do desktop
  com fallback para `en`, e tema `dark` por padrao com alternancia para
  `light`;
- scripts de bootstrap DEV, validacao de sidecar, build, typecheck e testes;
- README raiz com instrucoes de desenvolvimento.
- fila Postgres com claim atomico via `FOR UPDATE SKIP LOCKED`, progresso,
  cancelamento, retry, recuperacao de workers e ingestion runs retomaveis;
- supervisor de `worker_threads` no main process e entradas de worker para
  ingestao, conversao, chunking, embedding, assets e shells das etapas futuras;
- `@app/conversion` com Defuddle, conversores nativos de formatos textuais,
  ZIP com limites, normalizacao, hashing, chunking e protocolo JSONL do sidecar
  Docling;
- armazenamento de assets por SHA-256, deduplicacao fisica e deteccao de
  arquivos ausentes;
- `@app/ai` com registry/capabilities e adapters Google Gemini e
  OpenAI-compatible, perfis por tarefa e credenciais via `safeStorage`;
- ingestao manual progressiva para os 8 tipos do MVP, source picker,
  deduplicacao, vinculo bibliografico e importacao de arquivo via dialog do
  main process;
- chunks e SourceSpans com pagina, bloco, bounding box, selector e
  reprocessamento idempotente;
- embeddings separados em 256/768 dimensoes, indices HNSW e busca textual com
  `simple`, `unaccent` e `pg_trgm`;
- busca hibrida com evidencias e UI funcional de Import, Search, Jobs e
  configuracao de IA.
- resumos rastreaveis com perfil/modelo/prompt registrados e map-reduce para
  fontes que excedem o limite de contexto configurado;
- notas atomicas geradas por resultado estruturado Zod, vinculadas a fonte,
  chunks e SourceSpans, sempre iniciando em `pending_review`;
- matching hibrido entre notas com sinais vetoriais e de metadados, reranking
  opcional, limiar configuravel e relacoes canonicas persistidas em SQL;
- auditoria das transicoes de revisao de notas atomicas;
- pipeline retomavel completo ate resumo, notas atomicas e matching;
- UI funcional de Library, detalhe da fonte, arquivos originais, checkpoints
  dos jobs e fila de revisao com aprovar, editar e descartar.
- contratos de integracao `1.x` completos e validados por Zod para handshake,
  captura web/selecao/YouTube, eventos Obsidian, reconciliacao, progresso e
  erros normalizados;
- Integration Gateway HTTP/WebSocket em `127.0.0.1`, com porta configuravel,
  fallback em conflito, pareamento por token armazenado somente como hash,
  sessao efemera e autorizacao por capability;
- UI de Settings para criar pareamento, consultar/revogar clientes e copiar o
  client id/token exibido uma unica vez;
- extensao Chrome MV3 instalavel em `apps/chrome-extension/dist`, com popup,
  content script, service worker, captura de pagina/selecao/YouTube e
  reconexao ao despertar;
- pipeline YouTube via `youtubei.js`, com metadados e transcricao quando
  disponivel, normalizados para Markdown;
- plugin Obsidian instalavel em `apps/obsidian-plugin/dist`, com settings,
  comandos, status, monitoramento create/modify/rename/delete e scan de
  reconciliacao;
- projecao de fontes e notas atomicas em Markdown com frontmatter de identidade,
  paths humanos, tratamento de colisao e escrita atomica por worker;
- sync Obsidian bidirecional com `file_mtime`, hash, versao, tombstone,
  conflitos explicitos e reprocessamento do documento alterado;
- verificacao real da Fase 4 para migration, baseline, indices e repositorios
  de clientes/sync em PostgreSQL temporario.
- catalogo local versionado com tres modelos MLX auditados, revisions imutaveis,
  tamanhos, SHA-256, licencas, capabilities e requisitos de memoria;
- downloader Hugging Face direto, retomavel por Range, com `.partial`, preflight
  de disco/memoria/plataforma, progresso, cancelamento, retry, verificacao e
  promocao atomica;
- persistencia de `local_models`, arquivos, downloads/checkpoints e selecao por
  tarefa em perfis offline, com rastreabilidade ampliada em `ai_task_runs`;
- adapter GGUF real via `node-llama-cpp` e adapter MLX via helper Swift nativo,
  restritos ao main process/helper e cobertos por teste de fronteira;
- helper `native/mlx-helper` com `mlx-swift`, `mlx-swift-lm` e
  `swift-transformers` fixados, protocolo JSONL Zod, timeout, cancelamento,
  shaders `mlx.metallib` gerados por Xcode e smoke com modelo real instalado;
- Settings > Local models para catalogo/filtros, token seguro, aceite de
  licenca, downloads, retomada, teste, importacao GGUF e remocao protegida;
- backup basico via `pg_dump` e copias das pastas gerenciadas configuradas;
- limites de importacao e limites de paginas/tempo/memoria de saida/concorrencia
  do Docling;
- builder CPython 3.13.13 + Docling 2.111.0 para macOS arm64 com lock exato,
  modelos prebaixados em revisions fixadas e smoke real de PDF sem rede;
- staging Electron com PostgreSQL, Docling, helper MLX, migrations e baseline,
  `runtime-manifest.json` com hashes e SBOM SPDX incluindo wheels/modelos;
- migration `0005_fantastic_iceman`, baseline com 6 migrations e verificacao
  real da Fase 5 em banco vazio e existente;
- pacote `.app` macOS arm64 validado, com runtimes nativos e bindings GGUF
  presentes fora do ASAR.

Pendencias conhecidas:

- assinatura/notarizacao dos binarios nativos ainda nao foi configurada;
- builds AGE/Docling para Windows, Linux e macOS x64 estao fora do artefato
  inicial macOS arm64;
- o shell local foi validado com Node 24.18.0; o npm ainda emite apenas um
  warning sobre a chave legada `python` na configuracao do usuario.
- o corpus golden e os benchmarks completos dos formatos Docling continuam
  pendentes; o smoke offline automatizado cobre inicialmente um PDF com OCR;
- o smoke real do Gemma 4 12B MLX instalado foi validado; os demais modelos do
  catalogo ainda exigem download e validacao individual;
- smoke tests manuais da extensao carregada no Chrome e do plugin instalado no
  Obsidian ainda exigem os aplicativos host no ambiente local.

## Estrutura Raiz

```txt
.
  apps/
    desktop/
    chrome-extension/
    obsidian-plugin/
  packages/
    ai/
    conversion/
    db/
    domain/
    i18n/
    integration-contracts/
  native/
    mlx-helper/
  docs/
  scripts/
  RULES.md
  GUIDELINES_GTP.md
  MAPA.md
  README.md
```

Arquivos e diretorios gerados/locais que nao devem ser tratados como fonte:

- `.env`, `.env.*`, `apps/*/.env`, exceto `.env.example`;
- `node_modules/`;
- `dist/`, `out/`, `coverage/`;
- `.cache/`;
- `vendor/sidecars/`;
- arquivos `*.tsbuildinfo`.

## Aplicacoes

### `apps/desktop`

Aplicacao desktop principal. E a unica app que pode falar diretamente com banco,
filesystem privilegiado, segredos, sidecars e futuros workers locais.

Arquivos principais:

- `src/main/index.ts`: lifecycle Electron, criacao da janela, registro de IPC,
  start/shutdown dos services.
- `src/main/ipc.ts`: handlers IPC do main process.
- `src/main/services/database-service.ts`: lifecycle runtime do PostgreSQL
  sidecar no desktop.
- `src/main/services/settings-service.ts`: settings de storage usando o banco
  quando o runtime esta pronto, alem de preferencias de UI em `settings`.
- `src/main/services/path-validation.ts`: validacao de paths e nomes gerenciados.
- `src/main/services/job-supervisor.ts`: claim, retry, cancelamento e despacho
  dos jobs persistidos.
- `src/main/services/worker-supervisor.ts`: lifecycle dos `worker_threads`.
- `src/main/services/ingestion-service.ts`: ingestao manual/arquivo e
  persistencia dos artefatos.
- `src/main/services/asset-storage-service.ts`: storage por hash.
- `src/main/services/ai-service.ts`: providers, perfis e execucao de tarefas.
- `src/main/services/local-model-service.ts`: catalogo, downloads persistidos,
  token seguro, importacao GGUF, teste e remocao de modelos locais.
- `src/main/services/backup-service.ts`: `pg_dump` e copia dos arquivos
  gerenciados configurados.
- `src/main/services/credential-service.ts`: segredos de IA via `safeStorage`.
- `src/main/services/search-service.ts`: busca textual/hibrida com fallback.
- `src/main/services/knowledge-service.ts`: resumos, notas atomicas, matching,
  biblioteca, detalhe de fonte e revisao.
- `src/main/services/knowledge-processing.ts`: prompts versionados, map-reduce,
  parsing estruturado e scoring puro/testavel.
- `src/main/services/integration-gateway.ts`: HTTP/WebSocket loopback,
  autenticacao, pareamento, capabilities e roteamento externo.
- `src/main/services/obsidian-sync-service.ts`: projecao, reconciliacao e sync
  bidirecional do vault.
- `src/main/services/obsidian-projection.ts`: frontmatter, paths e naming.
- `src/main/services/youtube-service.ts`: metadados e transcricao via
  `youtubei.js`.
- `src/main/workers/*`: entradas e contratos dos workers da fila.
- `src/preload/index.ts`: API segura exposta em `window.app`.
- `src/shared/ipc.ts`: canais, schemas Zod e tipos compartilhados do IPC.
- `src/renderer/App.tsx`: shell React, bootstrap do banco e navegacao inicial.
- `src/renderer/components/SettingsView.tsx`: UI inicial de settings.
- `src/renderer/components/LibraryView.tsx`: biblioteca e detalhe completo de
  fontes.
- `src/renderer/components/ReviewQueueView.tsx`: fila de revisao das notas
  atomicas.
- `electron.vite.config.ts`: build Electron/Vite.
- `electron-builder.yml`: pacote macOS arm64, ASAR/unpack nativo e recursos.

Fronteira obrigatoria:

```txt
Renderer
  -> window.app no preload
  -> IPC validado por Zod
  -> main service
  -> @app/db / filesystem / sidecar
```

O renderer nao deve importar `@app/db`, `node:fs`, `electron` ou segredos.

### `apps/chrome-extension`

Extensao Chrome MV3 isolada. `vite build` gera manifest, locales, popup,
background e content script em `dist/`. O service worker usa somente o gateway
e `@app/integration-contracts`; nunca acessa banco ou codigo do main process.

### `apps/obsidian-plugin`

Plugin Obsidian desktop isolado. `vite build` gera `main.js` e `manifest.json`
em `dist/`. Monitora somente arquivos Markdown gerenciados por frontmatter e se
comunica com o desktop pelos contratos versionados; nao acessa o banco local.

## Pacotes

### `packages/i18n`

Mensagens e helpers de traducao.

Arquivos principais:

- `src/index.ts`: `createTranslator`, fallback e tipos de chaves.
- `src/locales/*.json`: textos visiveis do produto.

Regra: qualquer texto visivel ao usuario deve passar por este pacote.

### `packages/domain`

Linguagem canonica do dominio. Deve manter schemas Zod e tipos sem dependencias
pesadas.

Inclui os 8 tipos de fonte do MVP:

- `PersonalNote`
- `DailyNote`
- `WebArticle`
- `Book`
- `BookChapter`
- `StandaloneArticle`
- `Video`
- `GenericDocument`

### `packages/integration-contracts`

Contratos externos seguros e versionados para extensao Chrome, plugin Obsidian
e desktop gateway. Contem apenas schemas, eventos e tipos seguros.

### `packages/db`

Persistencia local, schema, migrations, seed/baseline versionado, repositorios
e sidecar PostgreSQL.

Arquivos principais:

- `src/schema.ts`: schema Drizzle inicial.
- `drizzle/0000_sour_dust.sql`: migration inicial gerada.
- `src/client.ts`: pool `pg` e cliente Drizzle.
- `src/migrations.ts`: helper reutilizavel para rodar migrations.
- `src/seed.ts`: aplicacao e verificacao do seed/baseline para banco vazio.
- `src/repositories/*`: repositorios SQL basicos.
- `src/scripts/migrate.ts`: CLI de migration via `MEMORA_DATABASE_URL`.
- `src/scripts/verify.ts`: verificacao basica de migrations/tabelas.
- `src/scripts/verify-seed.ts`: verificacao de sincronizacao seed/migrations.
- `src/scripts/verify-phase3.ts`: verificacao real da migration, baseline,
  resumos, notas, matching, relacoes e revisao da Fase 3.
- `src/scripts/verify-phase4.ts`: verificacao real de migration/baseline,
  clientes autorizados e identidade de arquivos Obsidian.
- `src/scripts/verify-phase5.ts`: verificacao real das tabelas de modelos,
  checkpoints, perfis locais, tracing e baseline com 6 migrations.
- `src/sidecar/manager.ts`: initdb/start/stop/restart do Postgres sidecar.
- `src/sidecar/paths.ts`: resolucao de paths DEV/prod/env.
- `src/sidecar/nodeRunner.ts`: runner Node para comandos do sidecar.
- `seed/baseline.sql`: baseline SQL aplicado somente em banco totalmente vazio.
- `seed/manifest.json`: lista versionada de migrations cobertas pelo baseline.

Regras especificas:

- mudancas em `schema.ts` exigem `npm run db:generate`;
- migrations devem ser aplicadas e verificadas em banco real;
- banco totalmente vazio usa seed/baseline versionado antes de migrations
  pendentes, registrando no historico Drizzle as migrations cobertas pelo
  baseline;
- banco existente nao recebe seed/baseline; roda apenas migrations pendentes;
- seeds/baselines devem acompanhar as migrations que cobrem, mesmo quando o
  seed inicial contiver apenas estrutura;
- cada nova migration deve atualizar `seed/baseline.sql` e `seed/manifest.json`
  na mesma mudanca, depois validar com `npm run db:seed:verify`;
- AGE nao e fonte canonica no MVP;
- tabelas relacionais seguem como fonte canonica.

### `packages/ai`

Registry, contratos de task/handle, negociacao por capabilities e adapters
Google Gemini/OpenAI-compatible, GGUF e MLX. Contem o catalogo auditado, o
protocolo MLX e o downloader verificado. Segredos sao injetados pelo desktop e
nunca persistidos neste pacote.

### `packages/conversion`

Base inicial para conversao/normalizacao. Nao deve acessar banco diretamente;
services de aplicacao persistem resultados via `@app/db`.

Decisao para a Fase 2: formatos textuais simples usam conversores TypeScript
nativos; PDF e documentos complexos usam Docling em sidecar CPython local,
controlado pelo main process ou pelo worker de conversao. O resultado preserva
Markdown, blocos e proveniencia estruturada quando disponivel.

O pacote agora contem `ConversionRouter`, conversores nativos, Defuddle,
extracao ZIP limitada, normalizador, chunker e `DoclingClient`. O bridge Python,
o lock exato e a definicao de revisions ficam em
`packages/conversion/sidecar/`; o bundle CPython/Docling e gerado por plataforma
e nunca depende do Python do sistema.

## Fluxo do Banco no Desktop

No desenvolvimento:

- o sidecar fica em `vendor/sidecars/postgres/darwin-{arch}/postgresql-18.4`;
- `.env` e `apps/desktop/.env` sao gerados para scripts locais;
- o runtime Electron gera credenciais proprias por instalacao via `safeStorage`.

No runtime Electron:

1. `apps/desktop/src/main/index.ts` cria `DatabaseService`.
2. `DatabaseService` resolve o sidecar:
   - `MEMORA_POSTGRES_SIDECAR_ROOT`;
   - `MEMORA_POSTGRES_BIN_DIR`;
   - `resourcesPath/sidecars/...` quando empacotado;
   - `vendor/sidecars/...` em DEV.
3. O data dir fica em:

```txt
app.getPath("userData")/database/postgres-data
```

4. O sidecar sobe em `127.0.0.1`, tentando `MEMORA_DATABASE_PORT` primeiro e
   fazendo fallback com warning para porta dinamica livre quando a porta
   configurada estiver invalida ou indisponivel.
5. Drizzle migrations rodam antes da shell principal ser liberada.
   - Em banco totalmente vazio, o runtime aplica antes o seed/baseline
     versionado, registra as migrations cobertas em
     `drizzle.__drizzle_migrations` e depois roda migrations pendentes.
   - Em banco existente, o runtime nao aplica seed/baseline e roda apenas
     migrations pendentes.
6. O renderer observa status via `window.app.database`.
7. Preferencias de UI usam `window.app.settings.getApp/updateApp`; quando ainda
   nao ha idioma salvo, o default vem de `app.getLocale()` normalizado com
   fallback para `en`. O tema default e `dark`.
8. Ao encerrar, o main fecha settings, pool e sidecar.

Estados IPC do banco:

- `starting`
- `migrating`
- `ready`
- `failed`
- `stopping`
- `stopped`

## Scripts Principais

Bootstrap:

```bash
npm install
npm run setup:dev
```

Sidecar:

```bash
npm run sidecar:install:postgres
npm run sidecar:spike
```

Banco:

```bash
npm run db:generate
npm run db:seed:verify
npm run db:migrate
npm run db:verify
npm run db:phase2:verify
npm run db:phase3:verify
npm run db:phase4:verify
npm run db:phase5:verify
npm run db:seed:sync
npm run phase4:e2e
```

Validacao:

```bash
npm run typecheck
npm test
npm run build
npm run format:check
npm run docling:verify
npm run docling:smoke
npm run mlx:smoke
npm run package:desktop:dir
npm run package:desktop:smoke
```

Desktop DEV:

```bash
npm run dev -w @app/desktop
```

Runtimes e pacote:

```bash
npm run mlx:build
npm run mlx:smoke
npm run docling:build
npm run docling:verify
npm run docling:smoke
npm run package:desktop:dir
```

## Documentacao de Referencia

- `docs/initial.md`: especificacao ampla do produto e arquitetura.
- `docs/mvp-implementation-plan.md`: fases e criterios de pronto.
- `docs/stack-versions.md`: matriz canonica de versoes.
- `docs/postgres-sidecar-age-spike.md`: reproducao e status do sidecar
  Postgres/pgvector/AGE.
- `docs/docling-sidecar.md`: build fixado, verificacao e smoke offline Docling.
- `docs/local-models-and-packaging.md`: catalogo local, downloads e pacote.
- `README.md`: instrucoes para pessoas desenvolvedoras.

## Cuidados Para Proximas Edicoes

- Antes de editar, confira `git status --short`; o repo pode estar sujo.
- Nao reverta alteracoes que voce nao fez.
- Use `rg`/`rg --files` para localizar codigo.
- Use `apply_patch` para edicoes manuais.
- Mantenha as fronteiras de arquitetura: renderer nao toca banco/fs/segredos.
- Ao adicionar texto visivel, atualize todos os locales em `packages/i18n`.
- Ao alterar schema, gere migration, aplique e verifique em banco real.
- Ao criar ou alterar migration, atualize tambem o seed/baseline versionado,
  rode `npm run db:seed:verify` e valide os fluxos de banco vazio e banco
  existente.
- Ao mexer no sidecar, valide start/stop e confirme que nao sobrou processo
  Postgres orfao.
