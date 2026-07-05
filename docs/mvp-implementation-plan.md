# Memora Eterna - Plano de Implementacao do MVP

Este documento divide o MVP em etapas pequenas e sequenciais. A ideia e permitir pedir a implementacao de uma etapa por vez, com testes, validacao e criterio claro de conclusao antes de seguir para a proxima.

Este plano nao substitui `docs/initial.md`. Ele transforma o escopo do MVP em uma trilha executavel.

O plano e organizado em fases com marcos utilizaveis: primeiro a espinha dorsal (importar, converter, buscar), depois a camada de conhecimento (resumos, notas atomicas), e por ultimo as integracoes externas (extensao Chrome e Obsidian). Isso entrega valor cedo e valida os maiores riscos primeiro.

## Objetivo do MVP

Ao final da ultima etapa, o MVP deve permitir:

- rodar uma aplicacao Electron com renderer React;
- configurar provedores, perfis de IA por tarefa, vault Obsidian e pasta opcional de arquivos subidos;
- importar conteudo manualmente, por arquivo, pela extensao Chrome e por YouTube;
- converter conteudo para Markdown normalizado;
- persistir fontes, documentos, assets, chunks, embeddings, entidades basicas, resumos e notas atomicas;
- projetar Markdown no vault Obsidian;
- sincronizar mudancas essenciais entre Obsidian e banco;
- buscar fontes e notas por busca textual, vetorial e hibrida simples;
- gerar notas atomicas com fila de revisao e persistir relacoes iniciais entre notas;
- manter rastreabilidade ate a fonte original.

## Fora do MVP

Estas ideias continuam no projeto, mas nao fazem parte da implementacao inicial:

- AGE profundo e travessias complexas de grafo;
- grafo visual elaborado;
- OCR sofisticado;
- multimodal local em producao;
- transcricao robusta de audio/video;
- MOCs automaticos;
- wikis elaboradas;
- extracao avancada de entidades e relacoes;
- automacoes;
- features avancadas da extensao alem de captura de paginas web e YouTube;
- features avancadas do plugin Obsidian alem da sincronizacao bidirecional essencial;
- provedores OpenAI, Anthropic e OpenRouter (entram na fase seguinte como novos adaptadores);
- tipos de `SourceItem` alem dos 8 iniciais (`PersonalNote`, `DailyNote`, `WebArticle`, `Book`, `BookChapter`, `StandaloneArticle`, `Video`, `GenericDocument`);
- builds do Apache AGE para Windows e Linux (macOS primeiro).

## Regras Globais

- Nao escrever textos de produto hardcoded no codigo. Usar i18n.
- Criar e atualizar manifests, lockfiles, binarios sidecar e scripts de build conforme `docs/stack-versions.md`.
- Manter TypeScript-first em todos os pacotes.
- Renderer nao acessa banco, filesystem privilegiado ou `node-llama-cpp` diretamente.
- `node-llama-cpp` deve rodar apenas no main process ou em workers controlados pelo main process.
- Extensao Chrome e plugin Obsidian nao acessam o banco local diretamente.
- Todas as entradas/saidas entre processos e apps devem usar contratos Zod.
- Toda alteracao em schema Drizzle exige `npm run db:generate`.
- Depois de aplicar migration, verificar no banco real o historico e a estrutura alterada.
- Criar testes de regressao quando pertinente.
- Nao fazer commit final automaticamente.
- Antes de encerrar cada etapa, informar arquivos alterados, verificacoes feitas e pendencias.

## Criterio Global de Pronto

Uma etapa so esta pronta quando:

- compila;
- testes relevantes passam;
- migrations novas foram geradas e verificadas quando houver mudanca de schema;
- fluxos manuais minimos foram validados quando houver UI ou integracao;
- documentacao ou comentarios necessarios foram atualizados;
- nao ha regressao conhecida bloqueante.

## Fases e Marcos

```txt
Fase 1 - Fundacao
  Etapas 0 a 5

Fase 2 - Espinha Dorsal
  Etapas 6 a 14
  -> Marco 1: importar, converter e buscar com evidencias

Fase 3 - Camada de Conhecimento
  Etapas 15 a 19
  -> Marco 2: resumos, notas atomicas revisaveis e relacoes

Fase 4 - Integracoes Externas
  Etapas 20 a 28
  -> Marco 3: extensao Chrome, YouTube e Obsidian bidirecional

Fase 5 - Fechamento
  Etapas 29 a 30
```

---

# Fase 1 - Fundacao

## Etapa 0 - Preparacao do Repositorio

Objetivo: criar a base de monorepo e ferramentas comuns.

Implementar:

- configurar workspaces para `apps/*` e `packages/*`;
- definir package manager `npm@11.16.0`, `engines` e scripts raiz conforme `docs/stack-versions.md`;
- configurar TypeScript compartilhado;
- configurar Vitest para pacotes e apps;
- configurar lint/format se ainda nao existir;
- criar estrutura inicial de pastas:
  - `apps/desktop`;
  - `apps/chrome-extension`;
  - `apps/obsidian-plugin`;
  - `packages/domain`;
  - `packages/integration-contracts`;
  - `packages/i18n`;
  - `packages/db`;
  - `packages/ai`;
  - `packages/conversion`.

Testes e validacao:

- `npm install`;
- `npm run build` ou script equivalente;
- `npm test` ou script equivalente;
- confirmar que cada pacote tem TypeScript compilavel.

Criterio de pronto:

- estrutura do monorepo criada;
- scripts raiz funcionando;
- nenhum app ainda precisa ter produto funcional.

---

## Etapa 0.5 - Spike do Postgres Sidecar com AGE (macOS)

Objetivo: provar o banco sidecar antes de construir qualquer coisa sobre ele.

Implementar:

- validar o artefato sidecar de Postgres no macOS: initdb em diretorio temporario, start e stop controlados via Node;
- confirmar a versao major/minor do Postgres e `pgvector` conforme `docs/stack-versions.md`;
- compilar Apache AGE `PG18/v1.7.0-rc0` para macOS contra PostgreSQL 18;
- injetar os artefatos do AGE (biblioteca, arquivos `control` e `sql`) no diretorio de binarios do sidecar;
- `CREATE EXTENSION vector` e `CREATE EXTENSION age` em banco de teste;
- executar uma query Cypher trivial via AGE e uma busca vetorial trivial via pgvector;
- medir cold start: primeiro uso (initdb) e starts subsequentes;
- documentar o processo de build do AGE em `docs/` para reproducao futura em CI e nas demais plataformas.

Testes e validacao:

- script de spike reproduzivel com saida registrada;
- extensoes `vector` e `age` visiveis em `pg_extension`;
- ciclos repetidos de start/stop sem processos orfaos.

Criterio de pronto:

- sidecar sobe e desce de forma confiavel no macOS com pgvector e AGE `PG18/v1.7.0-rc0` disponiveis;
- processo de build do AGE documentado;
- riscos remanescentes registrados (builds de Windows e Linux ficam como pendencia explicita).

---

## Etapa 1 - Pacote `@app/i18n`

Objetivo: criar a base obrigatoria de i18n.

Implementar:

- `packages/i18n/src/locales/en.json`;
- `packages/i18n/src/locales/pt-BR.json`;
- `packages/i18n/src/locales/it.json`;
- `packages/i18n/src/locales/fr.json`;
- `packages/i18n/src/locales/es.json`;
- tipos para `LanguageCode` e chaves de mensagem;
- helper para resolver mensagem por chave e locale;
- fallback para `en`;
- mensagens iniciais para shell da aplicacao, erros comuns, jobs, settings e integracoes.

Testes e validacao:

- teste para fallback de locale;
- teste para chave ausente;
- teste para type-safety basico das chaves exportadas.

Criterio de pronto:

- pacote pode ser importado por desktop, extensao e plugin;
- nao ha texto de produto novo fora dos arquivos de i18n.

---

## Etapa 2 - Pacote `@app/domain`

Objetivo: definir a linguagem canonica do dominio.

Implementar:

- tipos e schemas Zod para:
  - `SourceItem`;
  - `Document`;
  - `DocumentAsset`;
  - `Chunk`;
  - `SourceSpan`;
  - `GraphEntity`;
  - `Relation`;
  - `BibliographicWork`;
  - `BibliographicInstance`;
  - `Claim`;
  - `Question`;
  - `AtomicNote`;
  - `AtomicNoteRelation`;
  - `SourceSummary`;
  - `IngestionRun`;
  - `EmbeddingJob`;
  - `IngestionJob`;
  - `AiTaskType`;
  - `AiCapability`;
  - `ObsidianSyncFile`;
  - `StorageSettings`;
  - `LanguageCode`.
- enum de tipos de `SourceItem` com os 8 tipos do MVP (`PersonalNote`, `DailyNote`, `WebArticle`, `Book`, `BookChapter`, `StandaloneArticle`, `Video`, `GenericDocument`), extensivel para os demais tipos documentados;
- tipos para origem de fonte, status de job, status de ingestion run e status de sync;
- status de nota atomica incluindo `pending_review`.

Testes e validacao:

- testes de parse Zod para payloads validos e invalidos;
- teste de serializacao/deserializacao para tipos principais.

Criterio de pronto:

- os tipos canonicos podem ser usados por todos os pacotes;
- nenhum pacote precisa duplicar enums de dominio.

---

## Etapa 3 - Desktop Shell Electron

Objetivo: criar aplicacao Electron minima com renderer React, preload seguro e i18n.

Implementar:

- `apps/desktop` com `electron-vite`;
- React 19 no renderer, nas versoes de `docs/stack-versions.md`;
- Tailwind CSS 4, nas versoes de `docs/stack-versions.md`;
- base para `shadcn/ui`;
- preload expondo API pequena:
  - `app.system.getInfo`;
  - `app.settings.get`;
  - `app.settings.update`;
- IPC main/preload/renderer com Zod;
- i18n no renderer e main;
- tela inicial simples com navegacao:
  - Library;
  - Import;
  - Search;
  - Jobs;
  - Settings.

Testes e validacao:

- build do desktop;
- teste unitario de contrato IPC;
- teste de render de componente principal;
- smoke test manual do app abrindo.

Criterio de pronto:

- app abre;
- renderer nao acessa Node diretamente;
- textos visiveis passam por i18n.

---

## Etapa 4 - Postgres Sidecar, `@app/db` e Drizzle Basico

Objetivo: criar persistencia local inicial sobre o sidecar validado na Etapa 0.5.

Implementar:

- lifecycle do sidecar no main process: initdb no primeiro uso, start, shutdown limpo, deteccao de `postmaster.pid` obsoleto e de processos orfaos;
- data dir no `userData` da aplicacao;
- senha local gerada por instalacao e guardada via `safeStorage`; conexao por loopback em porta dinamica;
- cliente `node-postgres` com pool de conexoes no pacote `@app/db`;
- pacote `@app/db`;
- schema Drizzle inicial para:
  - `source_items`;
  - `documents`;
  - `document_assets`;
  - `source_spans`;
  - `chunks`;
  - `jobs`;
  - `ingestion_runs`;
  - `settings`;
  - `storage_settings`;
  - `integration_clients`;
  - `obsidian_sync_files`.
- repositorios basicos:
  - `sourceItemRepository`;
  - `documentRepository`;
  - `documentAssetRepository`;
  - `jobRepository`;
  - `ingestionRunRepository`;
  - `settingsRepository`;
  - `storageSettingsRepository`;
  - `obsidianSyncRepository`.
- scripts:
  - `db:generate`;
  - `db:migrate`;
  - `db:verify`.

Testes e validacao:

- teste de start/stop/restart do sidecar com data dir temporario;
- gerar migration com `npm run db:generate`;
- aplicar migration;
- verificar `drizzle.__drizzle_migrations`;
- verificar tabelas/colunas via `information_schema` ou consulta equivalente;
- testes de repositorio com banco temporario.

Criterio de pronto:

- sidecar inicializa, encerra e reinicia de forma confiavel no desktop;
- migrations sao reproduziveis;
- repositorios basicos funcionam.

---

## Etapa 5 - Settings de Storage e Obsidian

Objetivo: permitir configurar vault Obsidian e pasta opcional de arquivos subidos.

Implementar:

- UI em Settings para:
  - caminho do vault Obsidian;
  - pasta raiz gerenciada dentro do vault, default `Memora`;
  - habilitar/pausar sync Obsidian;
  - politica de delecao;
  - pasta opcional de copias de arquivos subidos;
  - habilitar/desabilitar copia de arquivos subidos.
- validacao de paths no main process;
- persistencia em `storage_settings`;
- i18n de todos os labels e erros;
- testes de validacao de path.

Testes e validacao:

- teste unitario de validacao de path;
- teste de repositorio `storageSettingsRepository`;
- smoke test manual da tela de Settings.

Criterio de pronto:

- usuario consegue salvar e carregar configuracoes de storage;
- renderer nunca acessa filesystem diretamente.

---

# Fase 2 - Espinha Dorsal

## Etapa 6 - Jobs, Workers e Maquina de Estados de Ingestao

Objetivo: criar execucao assincrona persistida e retomavel.

Implementar:

- tabela `jobs` completa;
- tabela `ingestion_runs` como maquina de estados por importacao:
  - etapa atual (`current_stage`);
  - checkpoint por etapa concluida (`stages_checkpoint`);
  - retomada da etapa em que parou apos erro, cancelamento ou reinicio, sem refazer etapas concluidas.
- fila simples no Postgres com `SELECT ... FOR UPDATE SKIP LOCKED`;
- workers via `worker_threads`, com conexoes proprias ao banco quando necessario;
- worker supervisor no main process;
- cancelamento;
- progresso;
- retry simples;
- workers iniciais:
  - `ingestion.worker.ts`;
  - `markdown-conversion.worker.ts`;
  - `chunking.worker.ts`;
  - `embedding.worker.ts`;
  - `atomic-note-generation.worker.ts`;
  - `obsidian-sync.worker.ts`;
  - `asset-storage.worker.ts`.

Testes e validacao:

- teste de criar job;
- teste de executar job;
- teste de cancelar job;
- teste de retomar job pendente apos reinicio simulado;
- teste de ingestion run retomada da etapa em que parou;
- teste de evento de progresso.

Criterio de pronto:

- jobs persistidos executam fora da UI;
- uma ingestao interrompida continua do checkpoint correto;
- UI consegue acompanhar estado basico.

---

## Etapa 7 - Conversao para Markdown

Objetivo: implementar `@app/conversion`.

Implementar:

- adaptador Defuddle para paginas web/DOM;
- adaptador `markitdown-ts` para arquivos locais;
- normalizador de Markdown;
- metadados de conversao;
- warnings de conversao;
- hashing de conteudo;
- fallback simples para texto puro/Markdown bruto;
- testes com fixtures pequenas:
  - HTML;
  - Markdown;
  - TXT;
  - DOCX/PDF apenas se fixtures forem viaveis no repo.

Testes e validacao:

- teste de conversao HTML -> Markdown;
- teste de arquivo texto -> Markdown;
- teste de erro recuperavel;
- teste de hash estavel.

Criterio de pronto:

- pipeline consegue receber conteudo e gerar Markdown normalizado;
- resultados carregam metadados de conversao.

---

## Etapa 8 - Assets e Copias de Arquivos Subidos

Objetivo: preservar originais e registrar caminhos.

Implementar:

- `document_assets` completo;
- copia opcional para pasta configurada;
- armazenamento por hash:
  - `sha256/ab/cd/hash.ext`;
- deduplicacao por hash;
- registro de:
  - `original_file_name`;
  - `sha256`;
  - `mime_type`;
  - `size_bytes`;
  - `storage_base`;
  - `relative_path`.
- deteccao de arquivo ausente na pasta externa.

Testes e validacao:

- teste de copia para storage configurado;
- teste de deduplicacao;
- teste de arquivo ausente;
- teste de path traversal rejeitado.

Criterio de pronto:

- uploads originais podem ser preservados opcionalmente;
- banco sabe onde cada original esta.

---

## Etapa 9 - IA: Abstracao, Perfis e Provedores Iniciais

Objetivo: criar registry de modelos, capabilities, perfis de IA e os dois provedores do MVP.

Implementar:

- interfaces:
  - `AiModelAdapter`;
  - `AiModelDescriptor`;
  - `AiTaskRequest`;
  - `AiTaskHandle`;
  - `AiTaskResult`;
  - `AiCapability`.
- registry de adapters;
- schema Drizzle para:
  - `ai_provider_configs`;
  - `ai_profile_sets`;
  - `ai_profile_tasks`;
  - `ai_model_capabilities`;
  - `ai_task_runs` (incluindo `input_tokens`, `output_tokens`, `cost_estimate`, `duration_ms`).
- repositorio `aiConfigRepository`;
- adapters do MVP:
  - Google (Gemini);
  - Generic OpenAI-compatible.
- armazenamento seguro de credenciais via `safeStorage`, com referencia no banco;
- teste de conexao por provedor;
- listagem dinamica de modelos quando suportada;
- execucao de tarefas:
  - `text-generation`;
  - `structured-output`;
  - `summarization`;
  - `atomic-note-generation`;
  - `embedding`.
- UI de Settings para:
  - provedores;
  - modelos;
  - perfis;
  - perfil padrao ativo;
  - tarefas por perfil.
- validacao de capabilities por tarefa;
- adapters stub/mock para testes;
- registro em `ai_task_runs` com tokens, duracao e custo estimado.

OpenAI, Anthropic e OpenRouter ficam para a fase seguinte, como novos adaptadores sobre a mesma interface.

Testes e validacao:

- gerar/aplicar/verificar migration;
- teste de registry;
- teste de negociacao de capabilities;
- teste de perfil sem modelo configurado;
- testes com mocks de API;
- teste de erro sem API key;
- teste de redacao de logs sem segredo;
- teste UI basico para criar/clonar perfil;
- smoke test com provedor real apenas se credencial estiver configurada.

Criterio de pronto:

- app consegue escolher um perfil ativo;
- pipeline consegue pedir modelo por tarefa sem conhecer provedor concreto;
- um perfil consegue executar resumo com provedor remoto;
- credenciais nao ficam em texto puro no banco.

---

## Etapa 10 - Ingestao Manual

Objetivo: permitir inserir conteudo por formulario.

Implementar:

- UI `manual-ingestion`;
- escolha inicial de `SourceItem.type` entre os 8 tipos do MVP;
- formulario progressivo por tipo:
  - nota pessoal;
  - nota diaria;
  - artigo web;
  - livro;
  - capitulo de livro;
  - artigo avulso;
  - video;
  - documento generico.
- source picker com sugestoes conforme digita;
- lookup textual por titulo, alias, ISBN, ISSN, DOI e URL;
- alerta de possivel duplicata;
- deduplicacao por `original_uri`/`content_hash` com politica explicita;
- criacao/vinculo de `BibliographicWork` e `BibliographicInstance`;
- criacao de `SourceItem` e `Document`;
- disparo de ingestion run.

Testes e validacao:

- testes de composicao do formulario;
- teste de lookup;
- teste de deduplicacao simples;
- teste de criar capitulo vinculado a livro existente;
- smoke test manual.

Criterio de pronto:

- usuario consegue colar conteudo e criar fonte sem duplicar obra existente.

---

## Etapa 11 - Importacao de Arquivo Local

Objetivo: importar arquivos via app desktop.

Implementar:

- UI de importacao de arquivo;
- selecao de arquivo via dialog do main process;
- salvar asset bruto;
- converter com `markitdown-ts`;
- criar `SourceItem`, `Document` e `DocumentAsset`;
- iniciar ingestion run (conversao, chunking e etapas seguintes conforme disponiveis);
- preservar arquivo original na pasta opcional quando habilitado.

Testes e validacao:

- teste de import de TXT/MD;
- teste de import de HTML ou fixture suportada;
- teste de erro de arquivo invalido;
- teste de asset registrado.

Criterio de pronto:

- arquivo local vira fonte e documento Markdown.

---

## Etapa 12 - Chunking e SourceSpan

Objetivo: dividir documentos preservando proveniencia.

Implementar:

- chunker inicial para Markdown;
- chunks sempre gerados a partir do documento fonte normalizado, nunca do resumo;
- criacao de `chunks`;
- criacao de `SourceSpan`;
- estrategia basica por headings e tamanho;
- associar chunks a `source_item` e `document`;
- reprocessamento idempotente.

Testes e validacao:

- teste de chunking por headings;
- teste de offsets/spans;
- teste de reprocessamento sem duplicar chunks.

Criterio de pronto:

- cada documento tem chunks rastreaveis ate o Markdown original.

---

## Etapa 13 - Embeddings e pgvector

Objetivo: gerar embeddings para chunks e notas atomicas.

Implementar:

- habilitar extensao `pgvector` (`CREATE EXTENSION vector`), ja incluida nos binarios do sidecar;
- tabelas de embeddings separadas por dimensao (indices pgvector exigem dimensao fixa por coluna);
- adapter de embedding remoto conforme perfil (Gemini ou OpenAI-compatible);
- job de embedding;
- salvar modelo, dimensao, runtime e estrategia;
- busca vetorial basica.

Testes e validacao:

- gerar/aplicar/verificar migration;
- teste com adapter mock de embedding;
- teste de dimensao incorreta rejeitada;
- teste de busca vetorial em dataset pequeno.

Criterio de pronto:

- chunks podem ser encontrados por similaridade vetorial.

---

## Etapa 14 - Busca Textual, Vetorial e Hibrida Simples

Objetivo: permitir recuperar fontes, chunks e notas.

Implementar:

- busca textual em Markdown/metadados com configuracao `simple` + `unaccent` + `pg_trgm`;
- registro de idioma por documento preservado para evolucao futura;
- busca vetorial;
- combinacao simples de scores;
- filtros por tipo de fonte;
- resultados com evidencias:
  - source item;
  - document;
  - chunk;
  - SourceSpan;
  - score textual;
  - score vetorial;
  - score final.
- UI de busca.

Testes e validacao:

- teste de busca textual, incluindo termos com acento;
- teste de busca vetorial;
- teste de score combinado;
- teste de resultado com evidencia.

Criterio de pronto:

- usuario consegue buscar e abrir evidencias rastreaveis.

**Marco 1 atingido: importar (manual/arquivo), converter e buscar com evidencias.**

---

# Fase 3 - Camada de Conhecimento

## Etapa 15 - Resumos

Objetivo: gerar resumo para fontes longas.

Implementar:

- `source_summaries`;
- job de resumo;
- usar perfil ativo para tarefa `summarization`;
- para fontes que excedam o contexto do modelo, resumo por map-reduce sobre os chunks (os chunks ja existem desde a Etapa 12; o resumo nunca e insumo do chunking);
- registrar `ai_task_runs`;
- salvar `summary` em `source_items`;
- UI para ver resumo.

Testes e validacao:

- teste com adapter mock de IA;
- teste de resumo salvo;
- teste de caminho map-reduce com fonte longa simulada;
- teste de registro de perfil/modelo usado.

Criterio de pronto:

- fonte longa ganha resumo rastreavel.

---

## Etapa 16 - Geracao de Notas Atomicas

Objetivo: gerar notas atomicas a partir de fonte.

Implementar:

- `atomic_notes`;
- `atomic_note_source_links`;
- job de geracao;
- usar perfil ativo para `atomic-note-generation`;
- prompt versionado;
- resultado estruturado com Zod;
- notas geradas automaticamente nascem com status `pending_review`;
- vincular nota a source/chunk/SourceSpan;
- UI para listar notas atomicas de uma fonte, distinguindo pendentes de revisadas.

A projecao das notas no vault Obsidian acontece na Fase 4 (Etapa 25).

Testes e validacao:

- teste com adapter mock de IA;
- teste de parse estruturado;
- teste de vinculo com fonte;
- teste de status inicial `pending_review`.

Criterio de pronto:

- uma fonte gera notas atomicas rastreaveis e revisaveis.

---

## Etapa 17 - Matching Inicial entre Notas Atomicas

Objetivo: conectar novas notas com notas existentes.

Implementar:

- busca hibrida de candidatos;
- score vetorial;
- score por entidades/metadados simples;
- reranking simples via perfil ativo quando configurado;
- persistencia em `atomic_note_relations`;
- limiar de relevancia configuravel;
- explicacao curta da relacao;
- UI deve distinguir relacoes envolvendo notas ainda pendentes de revisao.

Testes e validacao:

- teste de candidatos por embedding;
- teste de score final;
- teste de nao persistir relacao abaixo do limiar;
- teste de relacao persistida.

Criterio de pronto:

- novas notas podem se relacionar com notas existentes.

---

## Etapa 18 - UI de Biblioteca, Fonte, Jobs e Revisao de Notas

Objetivo: permitir usar o MVP sem inspecionar banco.

Implementar:

- Library:
  - lista de fontes;
  - filtros por tipo;
  - status de processamento.
- Source detail:
  - metadados;
  - Markdown;
  - resumo;
  - chunks;
  - notas atomicas;
  - links para original quando existirem.
- Jobs:
  - lista;
  - progresso;
  - erro;
  - retry/cancel quando permitido;
  - estado da ingestion run por etapa.
- Fila de revisao de notas atomicas:
  - listar notas `pending_review`;
  - aprovar, editar ou descartar;
  - transicao de status registrada.

Testes e validacao:

- testes de componentes;
- teste de estados vazios;
- teste de erro;
- teste de aprovacao/descarte de nota pendente;
- smoke test manual end-to-end.

Criterio de pronto:

- usuario consegue acompanhar importacao, navegar resultados e revisar notas geradas.

---

## Etapa 19 - Fluxo End-to-End 1: Manual e Arquivo

Objetivo: validar o primeiro caminho completo.

Implementar ajustes necessarios para o fluxo:

```txt
conteudo manual ou arquivo
  -> SourceItem
  -> Document Markdown
  -> asset opcional
  -> chunks
  -> embeddings
  -> resumo
  -> notas atomicas (pending_review)
  -> relacoes iniciais
  -> busca
```

A projecao no Obsidian sera validada no Marco 3.

Testes e validacao:

- teste de integracao do pipeline com mocks;
- teste de retomada da ingestion run apos falha simulada no meio do fluxo;
- smoke test manual com nota colada;
- smoke test manual com arquivo simples;
- verificar busca por trecho.

Criterio de pronto:

- fluxo manual/arquivo funciona de ponta a ponta.

**Marco 2 atingido: pipeline de conhecimento completo com notas atomicas revisaveis.**

---

# Fase 4 - Integracoes Externas

## Etapa 20 - Contratos de Integracao

Objetivo: definir contratos versionados para desktop, extensao e plugin.

Implementar em `@app/integration-contracts`:

- `IntegrationHandshake`;
- `IntegrationClientCapabilities`;
- `CaptureWebPageRequest`;
- `CaptureSelectionRequest`;
- `CaptureYouTubeVideoRequest`;
- `ImportObsidianNoteRequest`;
- `ObsidianFileChangedEvent`;
- `ObsidianFileMovedEvent`;
- `ObsidianFileDeletedEvent`;
- `JobProgressEvent`;
- `IntegrationError`;
- versionamento de contrato;
- schemas Zod para todos os payloads.

Testes e validacao:

- testes de parse para contratos validos/invalidos;
- teste de compatibilidade de versao;
- teste de erro normalizado.

Criterio de pronto:

- desktop, extensao e plugin podem depender dos mesmos contratos;
- contratos nao importam Electron, DB ou Node APIs privilegiadas.

---

## Etapa 21 - Integration Gateway

Objetivo: criar ponto local de entrada para extensao e plugin.

Implementar:

- gateway no main process;
- transporte: servidor HTTP local em loopback com WebSocket para eventos (decisao ja tomada; Native Messaging nao sera usado);
- porta padrao configuravel com deteccao de conflito;
- handshake;
- registro de cliente em `integration_clients`;
- pareamento por token exibido no desktop e informado no cliente externo;
- eventos de progresso;
- roteamento para application services;
- logs sem dados sensiveis.

Testes e validacao:

- teste de handshake;
- teste de cliente autorizado e rejeitado;
- teste de envio de evento;
- teste de contrato com payload invalido;
- teste de reconexao apos queda do WebSocket.

Criterio de pronto:

- clientes externos conseguem se conectar e enviar comando simples;
- gateway nao expoe banco nem filesystem diretamente.

---

## Etapa 22 - Extensao Chrome - Captura de Paginas

Objetivo: capturar paginas reais pela extensao.

Implementar:

- manifest da extensao com `host_permissions` para o endereco local do gateway;
- background/content script/popup;
- conexao com Integration Gateway, com reconexao apos hibernacao do service worker MV3;
- captura de:
  - URL;
  - titulo;
  - selecao;
  - DOM/HTML quando permitido;
  - metadados basicos;
  - conteudo principal via Defuddle no contexto da pagina quando viavel.
- envio `CaptureWebPageRequest`;
- deduplicacao no desktop por `original_uri`/`content_hash` antes de criar nova fonte;
- feedback de status no popup, incluindo desktop fechado/desconectado;
- tratamento de erro localizado.

Testes e validacao:

- testes de contrato;
- teste unitario de payload;
- teste de captura repetida da mesma URL sem duplicar fonte;
- smoke test manual em pagina simples;
- verificar que desktop cria fonte a partir da captura.

Criterio de pronto:

- usuario consegue capturar pagina real e ela entra no pipeline.

---

## Etapa 23 - Extensao Chrome - Captura de YouTube

Objetivo: capturar paginas YouTube reais.

Implementar:

- detectar URL de YouTube;
- extrair video id;
- capturar titulo/metadados visiveis quando disponiveis;
- enviar `CaptureYouTubeVideoRequest`;
- worker no desktop usa `youtubei.js` para metadados;
- tentar obter transcricao quando disponivel;
- normalizar transcricao para Markdown;
- criar `SourceItem` de tipo `Video`;
- sem promessa de transcricao robusta.

Testes e validacao:

- teste de parse de URL/video id;
- teste de contrato;
- teste com mock de `youtubei.js`;
- smoke test manual com video publico que tenha transcricao disponivel.

Criterio de pronto:

- usuario consegue capturar YouTube real e criar fonte com metadados/transcricao quando disponivel.

---

## Etapa 24 - Obsidian Plugin - Fundacao

Objetivo: criar plugin funcional e conectado ao desktop.

Implementar:

- scaffold do plugin;
- manifest;
- comandos iniciais;
- settings do plugin;
- integration client;
- handshake com desktop;
- registro de capacidades;
- i18n do plugin;
- exibicao de status de conexao.

Testes e validacao:

- build do plugin;
- testes de contratos;
- smoke test manual no Obsidian;
- handshake com desktop.

Criterio de pronto:

- plugin conecta no desktop e mostra status.

---

## Etapa 25 - Projecao Markdown no Obsidian

Objetivo: gerar arquivos `.md` gerenciados no vault.

Implementar:

- service de Obsidian projection no desktop;
- projecao de fontes e das notas atomicas geradas na Fase 3;
- frontmatter minimo:
  - `memora_id`;
  - `memora_type`;
  - `memora_source_id`;
  - `memora_document_id`;
  - `memora_managed`;
  - `memora_sync_version`;
  - `memora_content_hash`.
- estrutura de pastas `Memora/`;
- naming humano sem short id por padrao;
- sufixo por colisao:
  - data curta;
  - contador;
  - fallback id curto.
- tabela `obsidian_sync_files`, incluindo `file_mtime`;
- job `obsidian-sync.worker.ts`.

Testes e validacao:

- teste de path gerado por tipo;
- teste de colisao;
- teste de frontmatter;
- teste de criar arquivo no vault temporario;
- teste de atualizar path no banco.

Criterio de pronto:

- fontes e notas atomicas podem ser projetadas como Markdown no vault.

---

## Etapa 26 - Obsidian Plugin - Sync Bidirecional Essencial

Objetivo: manter ligacao viva entre arquivo e banco.

Implementar:

- plugin monitora arquivos gerenciados por frontmatter;
- eventos:
  - created;
  - modified;
  - moved/renamed;
  - deleted.
- scan de reconciliacao na abertura da aplicacao e na reconexao do plugin: comparar `file_mtime` e hash armazenados no banco com o estado atual do vault, detectando arquivos criados, modificados, movidos ou removidos enquanto o desktop esteve fechado;
- desktop reconcilia eventos;
- rename/move atualiza path relativo;
- edit atualiza Markdown/hash/sync version;
- delete segue politica configurada;
- tombstone antes de remocao fisica quando aplicavel;
- conflito explicito quando versoes divergem.

Testes e validacao:

- teste de parse de frontmatter;
- teste de update por edit;
- teste de rename/move;
- teste de delete;
- teste de conflito;
- teste de scan de reconciliacao com mudancas feitas "offline" em vault temporario;
- smoke test manual no Obsidian.

Criterio de pronto:

- mudancas essenciais no Obsidian refletem no banco e vice versa, incluindo mudancas feitas com o desktop fechado.

---

## Etapa 27 - Fluxo End-to-End 2: Extensao e YouTube

Objetivo: validar captura real externa.

Implementar ajustes necessarios para:

```txt
Chrome Extension
  -> pagina web
  -> desktop
  -> pipeline
  -> Obsidian
  -> busca

Chrome Extension
  -> YouTube
  -> desktop
  -> youtubei.js
  -> pipeline
  -> Obsidian
  -> busca
```

Testes e validacao:

- smoke test manual com pagina web;
- smoke test manual com selecao;
- smoke test manual com video YouTube publico;
- verificar contratos e jobs;
- verificar Markdown no Obsidian.

Criterio de pronto:

- extensao captura paginas e YouTube em uso real minimo.

---

## Etapa 28 - Fluxo End-to-End 3: Obsidian Bidirecional

Objetivo: validar sincronizacao essencial.

Implementar ajustes necessarios para:

```txt
banco cria/atualiza Markdown
  -> arquivo aparece no vault
  -> usuario edita no Obsidian
  -> plugin detecta
  -> desktop atualiza banco
  -> busca reflete mudanca
```

Validar tambem:

- rename/move;
- delete conforme politica configurada;
- conflito simples;
- tombstone quando aplicavel;
- edicao com desktop fechado, capturada pelo scan de reconciliacao na abertura.

Testes e validacao:

- teste de integracao com vault temporario;
- smoke test manual no Obsidian;
- verificar `obsidian_sync_files`.

Criterio de pronto:

- ligacao banco <-> Obsidian permanece viva nos eventos essenciais.

**Marco 3 atingido: captura externa e Obsidian bidirecional funcionando.**

---

# Fase 5 - Fechamento

## Etapa 29 - Preparacao de Runtime Local GGUF

Objetivo: preparar suporte local sem exigir multimodal local no MVP.

Implementar:

- adapter `node-llama-cpp` no `@app/ai`;
- garantir que so roda no main process ou worker controlado;
- registro de modelos locais em `local_models`;
- UI para cadastrar modelo local existente ou baixado futuramente;
- capabilities para modelo local;
- smoke test de carregamento quando arquivo GGUF for configurado;
- nao implementar multimodal local como requisito.

Testes e validacao:

- teste de fronteira para impedir import no renderer;
- teste com mock de adapter local;
- smoke test opcional com GGUF pequeno se disponivel no ambiente.

Criterio de pronto:

- arquitetura suporta modelo local GGUF;
- MVP nao depende de modelo local para funcionar.

---

## Etapa 30 - Hardening, Performance e Pacote MVP

Objetivo: fechar o MVP para uso continuado.

Implementar:

- revisar logs e redacao de segredos;
- revisar i18n;
- revisar erros de jobs;
- melhorar mensagens de falha;
- garantir que migrations sobem de banco vazio;
- validar reabertura da aplicacao com jobs e ingestion runs existentes;
- validar backup basico dos arquivos configurados e do banco (`pg_dump`);
- revisar limites de tamanho de importacao;
- revisar transparencia de custo de IA (tokens/custo em `ai_task_runs`, confirmacao para lotes);
- preparar build desktop (incluindo binarios do sidecar e AGE para macOS);
- preparar build extensao;
- preparar build plugin Obsidian;
- atualizar README com instrucoes de desenvolvimento.

Testes e validacao:

- `npm run build`;
- `npm test`;
- testes de migracao em banco limpo;
- smoke test dos tres fluxos end-to-end;
- validar app reiniciando sem perder estado.

Criterio de pronto:

- MVP implementado;
- fluxos principais funcionam;
- pendencias futuras estao documentadas (builds AGE Windows/Linux, provedores adicionais, tipos de SourceItem restantes, upgrade de major do Postgres);
- pronto para commit final quando o usuario pedir.
