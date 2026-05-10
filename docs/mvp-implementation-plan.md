# Memora Eterna - Plano de Implementacao do MVP

Este documento divide o MVP em etapas pequenas e sequenciais. A ideia e permitir pedir a implementacao de uma etapa por vez, com testes, validacao e criterio claro de conclusao antes de seguir para a proxima.

Este plano nao substitui `docs/initial.md`. Ele transforma o escopo do MVP em uma trilha executavel.

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
- gerar notas atomicas e persistir relacoes iniciais entre notas;
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
- features avancadas do plugin Obsidian alem da sincronizacao bidirecional essencial.

## Regras Globais

- Nao escrever textos de produto hardcoded no codigo. Usar i18n.
- Manter TypeScript-first em todos os pacotes.
- Renderer nao acessa banco, filesystem privilegiado ou `node-llama-cpp` diretamente.
- `node-llama-cpp` deve rodar apenas no main process ou em workers controlados pelo main process.
- Extensao Chrome e plugin Obsidian nao acessam PGlite diretamente.
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

---

## Etapa 0 - Preparacao do Repositorio

Objetivo: criar a base de monorepo e ferramentas comuns.

Implementar:

- configurar workspaces para `apps/*` e `packages/*`;
- definir package manager e scripts raiz;
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
  - `EmbeddingJob`;
  - `IngestionJob`;
  - `AiTaskType`;
  - `AiCapability`;
  - `ObsidianSyncFile`;
  - `StorageSettings`;
  - `LanguageCode`.
- enums iniciais para tipos de `SourceItem`;
- tipos para origem de fonte, status de job e status de sync.

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
- React 19 no renderer;
- Tailwind CSS 4;
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

## Etapa 4 - `@app/db` com PGlite e Drizzle Basico

Objetivo: criar persistencia local inicial.

Implementar:

- cliente PGlite no main process;
- pacote `@app/db`;
- schema Drizzle inicial para:
  - `source_items`;
  - `documents`;
  - `document_assets`;
  - `source_spans`;
  - `chunks`;
  - `jobs`;
  - `settings`;
  - `storage_settings`;
  - `integration_clients`;
  - `obsidian_sync_files`.
- repositorios basicos:
  - `sourceItemRepository`;
  - `documentRepository`;
  - `documentAssetRepository`;
  - `jobRepository`;
  - `settingsRepository`;
  - `storageSettingsRepository`;
  - `obsidianSyncRepository`.
- scripts:
  - `db:generate`;
  - `db:migrate`;
  - `db:verify`.

Testes e validacao:

- gerar migration com `npm run db:generate`;
- aplicar migration;
- verificar `drizzle.__drizzle_migrations`;
- verificar tabelas/colunas via `information_schema` ou consulta equivalente;
- testes de repositorio com banco temporario.

Criterio de pronto:

- banco inicializa no desktop;
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

## Etapa 6 - Contratos de Integracao

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

## Etapa 7 - Integration Gateway Minimo

Objetivo: criar ponto local de entrada para extensao e plugin.

Implementar:

- gateway no main process;
- transporte inicial escolhido:
  - HTTP loopback + WebSocket; ou
  - Native Messaging para Chrome e adaptador separado para Obsidian.
- handshake;
- registro de cliente em `integration_clients`;
- autorizacao simples por token/pareamento local;
- eventos de progresso;
- roteamento para application services;
- logs sem dados sensiveis.

Testes e validacao:

- teste de handshake;
- teste de cliente autorizado e rejeitado;
- teste de envio de evento;
- teste de contrato com payload invalido.

Criterio de pronto:

- clientes externos conseguem se conectar e enviar comando simples;
- gateway nao expoe banco nem filesystem diretamente.

---

## Etapa 8 - Abstracao de IA e Perfis por Tarefa

Objetivo: criar registry de modelos, capabilities e perfis de IA.

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
  - `ai_task_runs`.
- repositorio `aiConfigRepository`;
- UI de Settings para:
  - provedores;
  - modelos;
  - perfis;
  - perfil padrao ativo;
  - tarefas por perfil.
- validacao de capabilities por tarefa;
- adapters iniciais stub/mock para testes.

Testes e validacao:

- gerar/aplicar/verificar migration;
- teste de registry;
- teste de negociacao de capabilities;
- teste de perfil sem modelo configurado;
- teste UI basico para criar/clonar perfil.

Criterio de pronto:

- app consegue escolher um perfil ativo;
- pipeline consegue pedir modelo por tarefa sem conhecer provedor concreto.

---

## Etapa 9 - Provedores Remotos e OpenAI-compatible

Objetivo: permitir usar modelos remotos no MVP.

Implementar:

- adapters para:
  - OpenAI;
  - Google;
  - Anthropic;
  - OpenRouter;
  - Generic OpenAI-compatible.
- armazenamento seguro de credenciais por referencia;
- teste de conexao por provedor;
- listagem dinamica de modelos quando suportada;
- execucao de tarefas:
  - `text-generation`;
  - `structured-output`;
  - `summarization`;
  - `atomic-note-generation`.
- registro em `ai_task_runs`.

Testes e validacao:

- testes com mocks de API;
- teste de erro sem API key;
- teste de redacao de logs sem segredo;
- smoke test com provedor real apenas se credencial estiver configurada.

Criterio de pronto:

- um perfil consegue executar resumo com provedor remoto;
- credenciais nao ficam em texto puro no banco.

---

## Etapa 10 - Preparacao de Runtime Local GGUF

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

## Etapa 11 - Sistema de Jobs e Workers

Objetivo: criar execucao assincrona persistida.

Implementar:

- tabela `jobs` completa;
- fila simples no PGlite;
- workers via `worker_threads`;
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
- teste de evento de progresso.

Criterio de pronto:

- jobs persistidos executam fora da UI;
- UI consegue acompanhar estado basico.

---

## Etapa 12 - Conversao para Markdown

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

## Etapa 13 - Assets e Copias de Arquivos Subidos

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

## Etapa 14 - Ingestao Manual

Objetivo: permitir inserir conteudo por formulario.

Implementar:

- UI `manual-ingestion`;
- escolha inicial de `SourceItem.type`;
- formulario progressivo por tipo:
  - nota pessoal;
  - nota diaria;
  - capitulo de livro;
  - artigo de revista;
  - artigo de periodico;
  - artigo avulso;
  - manual.
- source picker com sugestoes conforme digita;
- lookup textual por titulo, alias, ISBN, ISSN, DOI e URL;
- alerta de possivel duplicata;
- criacao/vinculo de `BibliographicWork` e `BibliographicInstance`;
- criacao de `SourceItem` e `Document`;
- disparo de job de ingestion.

Testes e validacao:

- testes de composicao do formulario;
- teste de lookup;
- teste de deduplicacao simples;
- teste de criar capitulo vinculado a livro existente;
- smoke test manual.

Criterio de pronto:

- usuario consegue colar conteudo e criar fonte sem duplicar obra existente.

---

## Etapa 15 - Importacao de Arquivo Local

Objetivo: importar arquivos via app desktop.

Implementar:

- UI de importacao de arquivo;
- selecao de arquivo via dialog do main process;
- salvar asset bruto;
- converter com `markitdown-ts`;
- criar `SourceItem`, `Document` e `DocumentAsset`;
- iniciar jobs de resumo/chunking/embeddings/notas;
- preservar arquivo original na pasta opcional quando habilitado.

Testes e validacao:

- teste de import de TXT/MD;
- teste de import de HTML ou fixture suportada;
- teste de erro de arquivo invalido;
- teste de asset registrado.

Criterio de pronto:

- arquivo local vira fonte e documento Markdown.

---

## Etapa 16 - Extensao Chrome - Captura de Paginas

Objetivo: capturar paginas reais pela extensao.

Implementar:

- manifest da extensao;
- background/content script/popup;
- conexao com Integration Gateway;
- captura de:
  - URL;
  - titulo;
  - selecao;
  - DOM/HTML quando permitido;
  - metadados basicos;
  - conteudo principal via Defuddle no contexto da pagina quando viavel.
- envio `CaptureWebPageRequest`;
- feedback de status no popup;
- tratamento de erro localizado.

Testes e validacao:

- testes de contrato;
- teste unitario de payload;
- smoke test manual em pagina simples;
- verificar que desktop cria fonte a partir da captura.

Criterio de pronto:

- usuario consegue capturar pagina real e ela entra no pipeline.

---

## Etapa 17 - Extensao Chrome - Captura de YouTube

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

## Etapa 18 - Obsidian Plugin - Fundacao

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

## Etapa 19 - Projecao Markdown no Obsidian

Objetivo: gerar arquivos `.md` gerenciados no vault.

Implementar:

- service de Obsidian projection no desktop;
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
- tabela `obsidian_sync_files`;
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

## Etapa 20 - Obsidian Plugin - Sync Bidirecional Essencial

Objetivo: manter ligacao viva entre arquivo e banco.

Implementar:

- plugin monitora arquivos gerenciados por frontmatter;
- eventos:
  - created;
  - modified;
  - moved/renamed;
  - deleted.
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
- smoke test manual no Obsidian.

Criterio de pronto:

- mudancas essenciais no Obsidian refletem no banco e vice versa.

---

## Etapa 21 - Resumos

Objetivo: gerar resumo para fontes longas.

Implementar:

- `source_summaries`;
- job de resumo;
- usar perfil ativo para tarefa `summarization`;
- registrar `ai_task_runs`;
- salvar `summary` em `source_items`;
- UI para ver resumo.

Testes e validacao:

- teste com adapter mock de IA;
- teste de resumo salvo;
- teste de registro de perfil/modelo usado.

Criterio de pronto:

- fonte longa ganha resumo rastreavel.

---

## Etapa 22 - Chunking e SourceSpan

Objetivo: dividir documentos preservando proveniencia.

Implementar:

- chunker inicial para Markdown;
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

## Etapa 23 - Embeddings e pgvector

Objetivo: gerar embeddings para chunks e notas atomicas.

Implementar:

- extensao `pgvector`;
- tabelas de embeddings;
- adapter de embedding remoto/local conforme perfil;
- job de embedding;
- salvar modelo, dimensao, runtime e estrategia;
- separar indices por dimensao;
- busca vetorial basica.

Testes e validacao:

- gerar/aplicar/verificar migration;
- teste com adapter mock de embedding;
- teste de dimensao incorreta rejeitada;
- teste de busca vetorial em dataset pequeno.

Criterio de pronto:

- chunks podem ser encontrados por similaridade vetorial.

---

## Etapa 24 - Busca Textual, Vetorial e Hibrida Simples

Objetivo: permitir recuperar fontes, chunks e notas.

Implementar:

- busca textual em Markdown/metadados;
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

- teste de busca textual;
- teste de busca vetorial;
- teste de score combinado;
- teste de resultado com evidencia.

Criterio de pronto:

- usuario consegue buscar e abrir evidencias rastreaveis.

---

## Etapa 25 - Geracao de Notas Atomicas

Objetivo: gerar notas atomicas a partir de fonte.

Implementar:

- `atomic_notes`;
- `atomic_note_source_links`;
- job de geracao;
- usar perfil ativo para `atomic-note-generation`;
- prompt versionado;
- resultado estruturado com Zod;
- vincular nota a source/chunk/SourceSpan;
- projetar nota no Obsidian;
- UI para listar notas atomicas de uma fonte.

Testes e validacao:

- teste com adapter mock de IA;
- teste de parse estruturado;
- teste de vinculo com fonte;
- teste de projecao no Obsidian.

Criterio de pronto:

- uma fonte gera notas atomicas rastreaveis.

---

## Etapa 26 - Matching Inicial entre Notas Atomicas

Objetivo: conectar novas notas com notas existentes.

Implementar:

- busca hibrida de candidatos;
- score vetorial;
- score por entidades/metadados simples;
- reranking simples via perfil ativo quando configurado;
- persistencia em `atomic_note_relations`;
- limiar de relevancia configuravel;
- explicacao curta da relacao.

Testes e validacao:

- teste de candidatos por embedding;
- teste de score final;
- teste de nao persistir relacao abaixo do limiar;
- teste de relacao persistida.

Criterio de pronto:

- novas notas podem se relacionar com notas existentes.

---

## Etapa 27 - UI de Biblioteca, Fonte e Jobs

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
  - links para Obsidian/original quando existirem.
- Jobs:
  - lista;
  - progresso;
  - erro;
  - retry/cancel quando permitido.

Testes e validacao:

- testes de componentes;
- teste de estados vazios;
- teste de erro;
- smoke test manual end-to-end.

Criterio de pronto:

- usuario consegue acompanhar importacao e navegar resultados.

---

## Etapa 28 - Fluxo End-to-End 1: Manual e Arquivo

Objetivo: validar o primeiro caminho completo.

Implementar ajustes necessarios para o fluxo:

```txt
conteudo manual ou arquivo
  -> SourceItem
  -> Document Markdown
  -> asset opcional
  -> resumo
  -> chunks
  -> embeddings
  -> notas atomicas
  -> relacoes iniciais
  -> Obsidian
  -> busca
```

Testes e validacao:

- teste de integracao do pipeline com mocks;
- smoke test manual com nota colada;
- smoke test manual com arquivo simples;
- verificar arquivo Markdown no Obsidian;
- verificar busca por trecho.

Criterio de pronto:

- fluxo manual/arquivo funciona de ponta a ponta.

---

## Etapa 29 - Fluxo End-to-End 2: Extensao e YouTube

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

## Etapa 30 - Fluxo End-to-End 3: Obsidian Bidirecional

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
- tombstone quando aplicavel.

Testes e validacao:

- teste de integracao com vault temporario;
- smoke test manual no Obsidian;
- verificar `obsidian_sync_files`.

Criterio de pronto:

- ligacao banco <-> Obsidian permanece viva nos eventos essenciais.

---

## Etapa 31 - Hardening, Performance e Pacote MVP

Objetivo: fechar o MVP para uso continuado.

Implementar:

- revisar logs e redacao de segredos;
- revisar i18n;
- revisar erros de jobs;
- melhorar mensagens de falha;
- garantir que migrations sobem de banco vazio;
- validar reabertura da aplicacao com jobs existentes;
- validar backup basico dos arquivos configurados;
- revisar limites de tamanho de importacao;
- preparar build desktop;
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
- pendencias futuras estao documentadas;
- pronto para commit final quando o usuario pedir.

