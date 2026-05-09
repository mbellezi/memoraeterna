# Memor Aeterna - Descricao Inicial do Projeto

## Visao Geral

Memora Eterna sera uma plataforma local-first para gerenciamento, indexacao e recuperacao de informacoes de longo prazo. O projeto sera composto por tres elementos principais:

1. uma aplicacao Electron para desktop;
2. uma extensao para Chrome usada para capturar conteudo web e envia-lo para a aplicacao;
3. um plugin para Obsidian com comunicacao bidirecional com a aplicacao.

A aplicacao desktop sera o nucleo do sistema. Ela devera consumir conteudos fornecidos pelo usuario, como artigos, capitulos de livros, documentos, videos, transcricoes, paginas web e notas, transformando-os em uma base de conhecimento local, pesquisavel e auditavel.

O objetivo central e permitir que o usuario construa uma memoria pessoal ou institucional persistente, com busca textual, busca semantica, extracao de entidades, relacoes entre conceitos e rastreabilidade ate as fontes originais.

O projeto sera local-first, TypeScript-first e orientado por uma arquitetura em camadas, com separacao clara entre aplicacoes, contratos, interfaces, servicos de aplicacao, persistencia, indexacao, integracoes e processamento pesado.

## Decisoes Iniciais

As seguintes decisoes foram adotadas como base inicial do projeto:

- `electron-vite` como fundacao da aplicacao desktop.
- React 19 no renderer.
- Tailwind CSS 4 para estilos.
- `shadcn/ui` como base de componentes de UI.
- Node.js no main process do Electron.
- Extensao Chrome como aplicacao isolada dentro do monorepo.
- Plugin Obsidian como aplicacao isolada dentro do monorepo.
- Aplicacao desktop como fonte de verdade, dona do banco e do pipeline de indexacao.
- Integration Gateway no main process para receber requisicoes externas autorizadas.
- Contratos compartilhados e versionados para comunicacao entre desktop, extensao Chrome e plugin Obsidian.
- Toda fonte de conteudo importada deve ser convertida para Markdown normalizado.
- Defuddle sera o motor primario para extracao de conteudo principal de paginas web para Markdown limpo.
- `markitdown-ts` sera o motor primario para converter arquivos locais/anexos para Markdown.
- `youtubei.js` sera o caminho inicial para metadados e transcricoes de YouTube.
- A importacao deve gerar notas atomicas no estilo Zettelkasten a partir das ideias presentes no conteudo.
- Notas atomicas devem ser relacionadas as fontes, aos elementos catalograficos, as entidades e a outras notas atomicas.
- Fontes longas, como artigos, capitulos, livros, manuais, videos e podcasts, devem receber resumo gerado durante a importacao.
- A aplicacao deve incluir uma area de configuracoes para provedores de IA, modelos de processamento, embeddings, chaves e modelos locais.
- Provedores de IA iniciais: OpenAI, Google, Anthropic, OpenRouter e local/OpenAI-compatible.
- Modelos locais via GGUF devem ser executados inicialmente com `node-llama-cpp` embutido na aplicacao Electron.
- Provedores de embedding iniciais: OpenAI, Google e modelos locais baixaveis.
- Drizzle ORM com PGlite.
- PGlite com `pgvector` para busca vetorial.
- PGlite com Apache AGE para consultas e projecoes de grafo.
- Zod para contratos tipados entre renderer, preload, main process e workers.
- `worker_threads` para ingestao, chunking, OCR, transcricao, embeddings e extracao de conhecimento.
- Pacote interno `@app/domain` para tipos canonicos e schemas compartilhados.
- Pacote interno `@app/db` para schema, migrations, repositorios e queries.
- Pacote interno `@app/integration-contracts` para contratos externos, eventos e schemas de integracao.
- i18n no frontend e no backend.
- NUNCA escrever textos diretamente no codigo; qualquer texto deve passar por i18n.
- Testes de regressao automatizados sempre que pertinente, usando a infraestrutura existente de cada parte do projeto.
- Alteracoes em schema Drizzle exigem geracao de migration via `npm run db:generate`.
- Migrations devem ser verificadas no banco real apos aplicacao.
- Nao fazer commit final automaticamente; informar quando estiver pronto para o commit.
- Idiomas iniciais: `en` como padrao, `pt-BR`, `it`, `fr` e `es`.

## Arquitetura Geral

```txt
apps/
  desktop/
    Electron App
      main/
        ciclo de vida da aplicacao
        handlers IPC
        integration gateway
        servicos de aplicacao
        orquestracao de workers
        acesso ao banco
        acesso ao filesystem
        i18n backend

      preload/
        ponte segura entre renderer e main
        API tipada exposta ao renderer
        validacao com Zod

      renderer/
        React 19
        estado da UI
        i18n frontend
        leitor de documentos
        busca
        explorador de grafo
        telas de configuracao

  chrome-extension/
    captura de conteudo web
    popup/options/content scripts/background
    cliente do integration gateway
    i18n da extensao

  obsidian-plugin/
    integracao com vaults e notas
    comandos e painel do Obsidian
    cliente bidirecional do integration gateway
    i18n do plugin

packages/
  @app/domain
    tipos canonicos
    schemas Zod de dominio
    enums compartilhados
    eventos de dominio

  @app/integration-contracts
    contratos externos versionados
    schemas Zod de entrada e saida
    eventos desktop <-> clientes externos
    capacidades e handshake de clientes

  @app/ai
    abstracoes de provedores de IA
    descoberta de modelos
    configuracao de modelos de processamento
    configuracao de embeddings
    suporte a modelos locais

  @app/conversion
    contratos de conversao para Markdown
    adaptadores para Defuddle, markitdown-ts e youtubei.js
    normalizacao de Markdown
    metadados de conversao

  @app/db
    cliente PGlite
    schema Drizzle
    migrations
    repositorios
    queries SQL, vetoriais e de grafo

  @app/i18n
    mensagens compartilhadas
    tipos de locale
    arquivos de traducao comuns
```

O desktop sera o unico elemento com acesso direto ao banco, filesystem gerenciado da aplicacao e pipeline de indexacao. A extensao Chrome e o plugin Obsidian devem se comunicar com o desktop apenas por contratos publicos internos, sem importar codigo do main process, repositorios ou banco.

```txt
Chrome Extension
  -> Integration Client
  -> Integration Gateway
  -> Application Service
  -> Repository / Worker / Filesystem
  -> PGlite

Obsidian Plugin
  <-> Integration Client
  <-> Integration Gateway
  <-> Application Service / Event Bus
  <-> Repository / Worker / Filesystem
  <-> PGlite
```

O renderer nao devera acessar o banco diretamente. Toda comunicacao entre interface e backend local passara por uma API segura exposta no preload e implementada no main process.

```txt
React Renderer
  -> Preload API tipada
  -> IPC
  -> Main IPC Handler
  -> Zod parse
  -> Application Service
  -> Repository / Worker / Filesystem
  -> PGlite
```

## Main Process

O main process sera o backend local da aplicacao. Ele sera responsavel por:

- inicializar a aplicacao Electron;
- inicializar o banco PGlite;
- executar migrations;
- registrar handlers IPC;
- inicializar o Integration Gateway;
- autenticar e autorizar clientes externos locais;
- coordenar servicos de aplicacao;
- gerenciar filas de jobs;
- criar e monitorar workers;
- acessar o filesystem;
- controlar importacao, indexacao e reprocessamento de conteudo;
- emitir eventos de progresso para o renderer;
- emitir eventos para clientes externos conectados, quando autorizado;
- produzir mensagens localizadas quando forem visiveis ao usuario.

O main process devera concentrar operacoes sensiveis e privilegiadas, mantendo o renderer isolado de acesso direto ao filesystem, banco de dados e APIs nativas.

## Integration Gateway

O Integration Gateway sera o ponto de entrada local para clientes externos autorizados, como a extensao Chrome e o plugin Obsidian.

Ele devera viver no main process da aplicacao desktop e encaminhar requisicoes para os mesmos servicos de aplicacao usados pelo renderer, sem expor banco, repositorios ou filesystem diretamente.

Responsabilidades iniciais:

- receber conteudo capturado pela extensao Chrome;
- permitir comunicacao bidirecional com o plugin Obsidian;
- validar payloads com Zod usando `@app/integration-contracts`;
- autenticar clientes externos locais;
- registrar capacidades de cada cliente;
- publicar eventos de progresso e sincronizacao;
- encaminhar comandos para servicos de aplicacao;
- manter compatibilidade por versao de contrato.

O transporte exato ainda deve ser validado. Candidatos iniciais:

- servidor local em loopback com HTTP para requisicoes e WebSocket para eventos;
- Native Messaging para a extensao Chrome;
- adaptador especifico para o plugin Obsidian quando necessario.

A arquitetura deve tratar o transporte como detalhe de adaptador. A regra principal e que Chrome Extension e Obsidian Plugin falem com o desktop por contratos versionados, nao por importacao direta de codigo interno.

## Preload

O preload sera a fronteira segura entre o renderer e o main process. Ele devera expor uma API pequena, explicita e tipada.

Exemplos de superficies esperadas:

```ts
window.app.documents.import(...)
window.app.documents.get(...)
window.app.search.query(...)
window.app.graph.expand(...)
window.app.jobs.subscribe(...)
window.app.settings.get(...)
window.app.settings.update(...)
```

Todas as entradas e saidas relevantes deverao ser validadas com Zod. A API exposta pelo preload deve ser tratada como contrato publico interno da aplicacao.

## Renderer

O renderer sera implementado em React 19 e devera cuidar apenas da experiencia de usuario, estado visual e interacao.

Responsabilidades principais:

- navegacao da aplicacao;
- importacao de conteudos;
- visualizacao de documentos;
- busca textual, semantica e hibrida;
- exploracao de entidades e relacoes;
- acompanhamento de jobs;
- configuracoes de idioma, modelos e indexacao;
- exibicao de mensagens localizadas.

O renderer nao deve conter regras de persistencia, acesso direto ao banco ou logica pesada de processamento.

## Frontend Stack

A stack inicial de frontend sera:

- React 19;
- Tailwind CSS 4;
- `shadcn/ui`;
- i18n obrigatorio para todo texto de produto.

No desktop, essa stack sera usada no renderer React. Na extensao Chrome, React 19 e Tailwind CSS 4 podem ser usados em popup, options e outras superficies de UI, mantendo o bundle adequado ao ambiente de extensao. No plugin Obsidian, a UI deve respeitar as convencoes do Obsidian; React 19, Tailwind CSS 4 e componentes inspirados em `shadcn/ui` podem ser usados apenas quando fizerem sentido para views customizadas e sem quebrar a integracao visual com o host.

Componentes reutilizaveis devem privilegiar composicao, acessibilidade, responsividade e compatibilidade com i18n. Textos visiveis nao devem ficar embutidos nos componentes.

## Area de Configuracoes

A aplicacao desktop devera incluir uma area de configuracoes para preferencias de usuario, modelos, provedores, integracoes e comportamento do pipeline.

Configuracoes iniciais:

- idioma da interface;
- provedores de IA;
- API keys e credenciais de provedores;
- modelo de IA usado para processamento;
- modelo de embedding usado para indexacao e matching;
- modelos locais baixados;
- parametros de chunking, resumo, geracao de notas atomicas e matching;
- clientes externos autorizados;
- preferencias de privacidade e uso local/remoto.

Textos dessa area tambem devem seguir a regra de i18n obrigatorio.

## Configuracoes de IA

A aplicacao deve permitir selecionar o modelo de IA usado pelo pipeline de processamento, incluindo catalogacao, conversao assistida quando aplicavel, resumo, extracao de entidades, extracao de claims, geracao de notas atomicas e reranking.

Provedores iniciais:

- OpenAI;
- Google;
- Anthropic;
- OpenRouter;
- Local embutido via `node-llama-cpp`;
- Generic OpenAI-compatible endpoint.

Cada provedor remoto deve permitir:

- cadastro de API key ou credencial equivalente;
- teste de conexao;
- listagem dinamica dos modelos disponiveis;
- selecao de modelo por tarefa;
- registro de modelo usado em cada artefato gerado;
- tratamento de erro localizavel via i18n.

Seguranca de credenciais:

- API keys nao devem ser armazenadas em texto puro no PGlite;
- o banco deve guardar apenas referencias, metadados nao sensiveis e status;
- segredos devem usar armazenamento seguro do sistema operacional ou mecanismo equivalente;
- logs nunca devem incluir chaves, tokens ou payloads sensiveis.

Selecao por tarefa:

```txt
catalogacao
resumo
extracao de entidades
extracao de claims
geracao de notas atomicas
matching/reranking
assistencia de escrita
```

## Abstracao de Modelos de IA

A aplicacao deve tratar provedores, runtimes e modelos como adaptadores independentes. Cada adaptador encapsula sua propria metodologia de carregamento, operacao, cancelamento, streaming, progresso, erros, recursos locais e formato de entrada/saida.

A camada de aplicacao nao deve saber se uma tarefa esta sendo executada por API remota, `node-llama-cpp`, Transformers.js/ONNX, endpoint OpenAI-compatible, runtime local futuro ou sidecar. Ela deve negociar capacidades e chamar uma interface comum.

Conceitos principais:

```txt
AiModelAdapter
  -> unidade operacional que executa uma ou mais tarefas

AiModelCapabilities
  -> lista declarativa do que o modelo/runtime suporta

AiTaskRequest
  -> pedido tipado de processamento

AiTaskHandle
  -> handle para acompanhar progresso, streaming e cancelamento

AiTaskResult
  -> resultado estruturado com metadados de execucao
```

Capacidades iniciais a declarar por modelo:

- `text-generation`;
- `structured-output`;
- `json-schema-output`;
- `summarization`;
- `entity-extraction`;
- `claim-extraction`;
- `atomic-note-generation`;
- `embedding`;
- `reranking`;
- `image-understanding`;
- `document-ocr`;
- `audio-transcription`;
- `video-understanding`;
- `streaming`;
- `cancellation`;
- `batching`;
- `offline`;
- `local-files`;
- `requires-api-key`;
- `requires-network`;
- `supports-progress-events`.

Fluxo de negociacao:

```txt
pipeline solicita tarefa
  -> AiModelRegistry consulta modelos configurados
  -> filtra por capabilities obrigatorias
  -> aplica preferencias do usuario e politicas de privacidade
  -> verifica disponibilidade local/remota
  -> cria AiTaskRequest validado por Zod
  -> executa via adaptador escolhido
  -> retorna AiTaskHandle
  -> emite progresso/streaming/cancelamento
  -> persiste AiTaskResult e metadados
```

Cada adaptador deve declarar:

- identificador do provedor;
- identificador do modelo;
- runtime usado;
- formato do modelo quando aplicavel, como GGUF ou ONNX;
- capacidades suportadas;
- limites praticos, como contexto, dimensoes, tamanho maximo de arquivo, modalidades e batch size;
- requisitos, como API key, rede, GPU, memoria minima, arquivo local ou runtime nativo;
- politicas de cancelamento e timeout;
- tipos de erro normalizados;
- versao do adaptador e do runtime.

Exemplo conceitual:

```ts
type AiCapability =
  | "text-generation"
  | "structured-output"
  | "embedding"
  | "reranking"
  | "image-understanding"
  | "audio-transcription"
  | "streaming"
  | "cancellation"
  | "offline";

interface AiModelAdapter {
  describe(): AiModelDescriptor;
  canHandle(request: AiTaskRequest): boolean;
  run(request: AiTaskRequest, signal?: AbortSignal): Promise<AiTaskResult>;
}
```

Essa abstracao deve permitir decidir depois quais modelos serao usados para cada funcao, sem alterar o pipeline principal de ingestao, catalogacao, resumo, embeddings, OCR, transcricao, reranking ou geracao de notas atomicas.

## Runtime Local com node-llama-cpp

O caminho inicial para executar modelos locais GGUF sera `node-llama-cpp` integrado ao desktop Electron. O objetivo e permitir modelos locais sem exigir que o usuario instale `llama.cpp`, Homebrew, Ollama ou qualquer runtime externo.

Responsabilidades iniciais:

- rodar apenas no main process ou em workers controlados pelo main process;
- nunca ser importado pelo renderer, extensao Chrome ou plugin Obsidian;
- carregar modelos GGUF a partir da pasta gerenciada da aplicacao;
- expor uma interface interna comum em `@app/ai`;
- suportar cancelamento, timeouts, logs, progresso e erros localizados;
- registrar modelo, quantizacao, runtime, parametros e versao em cada artefato gerado;
- detectar capacidade local quando possivel, como CPU, memoria, Metal, CUDA ou Vulkan;
- manter fallback para provedores remotos ou OpenAI-compatible quando o modelo local nao estiver disponivel.

Fluxo esperado:

```txt
Configuracoes > Modelos locais
  -> escolher modelo local disponivel
  -> baixar GGUF para pasta gerenciada
  -> verificar hash e metadados
  -> registrar em local_models
  -> executar teste rapido
  -> disponibilizar como provider local
```

Ollama, LM Studio, `llama-server` externo ou qualquer endpoint OpenAI-compatible podem continuar existindo como integracoes opcionais, mas nao serao o caminho local principal.

## Configuracoes de Embeddings

A aplicacao deve permitir escolher o modelo de embedding por provedor remoto ou local.

Provedores remotos iniciais:

- OpenAI;
- Google.

Modelos locais baixaveis iniciais:

- `google/embeddinggemma-300m`;
- `intfloat/multilingual-e5-base`.

O gerenciador de modelos locais deve permitir:

- listar modelos disponiveis para download;
- baixar, verificar e remover modelos;
- registrar versao, tamanho, dimensoes e runtime;
- registrar formato, como GGUF, ONNX ou outro formato futuro;
- registrar backend local, inicialmente `node-llama-cpp` para GGUF;
- indicar se o modelo esta pronto para uso offline;
- escolher modelo padrao para chunks e para notas atomicas.

Estrategia de dimensoes:

- usar a dimensao nativa do modelo como fonte principal de qualidade;
- quando o modelo suportar dimensoes reduzidas de forma nativa, permitir indice rapido em dimensao menor;
- usar dimensao reduzida para candidate generation quando houver ganho claro de velocidade e espaco;
- usar dimensao maior/nativa para reranking semantico quando o modelo suportar;
- registrar dimensao, modelo e estrategia em cada embedding gerado.

Ideia inicial: usar um indice rapido com 256 dimensoes para recuperar candidatos e um indice maior para reranking. Essa estrategia combina bem com modelos Matryoshka, como `google/embeddinggemma-300m`, que pode produzir 768 dimensoes e suportar truncamentos como 256. `intfloat/multilingual-e5-base` tem dimensao nativa de 768, o que tambem se encaixa bem na etapa de reranking em maior qualidade.

## Extracao Web para Markdown

Defuddle sera o motor primario para converter paginas web em Markdown limpo, removendo ruido como navegacao, sidebars, comentarios, headers, footers e outros elementos que nao fazem parte do conteudo principal.

Uso esperado:

```txt
URL ou DOM da pagina
  -> Defuddle
  -> Markdown limpo
  -> metadados extraidos
  -> catalogacao
  -> SourceItem + Document + assets
```

Dois modos devem ser suportados:

- extensao Chrome: executar Defuddle no `document` atual, ideal para paginas ja renderizadas, paginas autenticadas e conteudo que depende da sessao do usuario;
- desktop: executar Defuddle sobre HTML obtido a partir da URL, usando uma implementacao DOM no Node quando a pagina nao exigir sessao ou renderizacao complexa.

Metadados e auditoria da extracao:

```txt
original_url
final_url
captured_at
raw_html_hash
clean_markdown_hash
extraction_engine
extraction_engine_version
extracted_metadata
```

Fallbacks previstos:

- Mozilla Readability + Turndown para paginas em que Defuddle falhar ou produzir resultado fraco;
- Playwright ou BrowserWindow local para paginas que dependem fortemente de JavaScript;
- servicos externos opcionais, como Firecrawl ou Jina Reader, apenas quando o usuario habilitar explicitamente esse caminho.

## Importacao de Arquivos para Markdown

`markitdown-ts` sera o motor primario para converter arquivos locais, anexos e arquivos recebidos de integracoes para Markdown normalizado.

Ele deve ser executado no desktop, preferencialmente em `worker_threads`, sem expor acesso direto a arquivos para o renderer, extensao Chrome ou plugin Obsidian.

Uso esperado:

```txt
arquivo local, anexo ou buffer importado
  -> salvar asset bruto
  -> detectar MIME, extensao e tamanho
  -> converter com markitdown-ts quando suportado
  -> normalizar Markdown
  -> extrair metadados tecnicos
  -> criar SourceItem + Document + DocumentAsset
  -> gerar resumo, chunks, embeddings e notas atomicas
```

Formatos iniciais a validar com `markitdown-ts`:

- PDF textual;
- Word `.docx`;
- Excel `.xlsx`;
- HTML;
- texto simples, Markdown, CSV, XML, RSS e Atom;
- Jupyter Notebook `.ipynb`;
- imagens, inicialmente para metadados EXIF e descricao assistida quando habilitada;
- ZIP, com iteracao recursiva e limites de seguranca;
- PowerPoint/PPTX e EPUB devem ser tratados como formatos a validar antes de compromisso firme.

Casos que nao devem depender apenas de `markitdown-ts`:

- PDF escaneado ou imagem sem texto pesquisavel deve seguir para OCR;
- audio e video devem seguir para pipeline de transcricao;
- imagem que exige leitura visual deve seguir para OCR ou analise visual configurada;
- arquivos compactados devem ter limites de tamanho, profundidade, quantidade de arquivos e tipos permitidos;
- arquivos protegidos por senha, corrompidos ou com formato ambiguo devem gerar erro recuperavel e localizavel via i18n.

Metadados e auditoria da conversao:

```txt
original_file_name
mime_type
file_extension
file_size_bytes
source_file_hash
conversion_engine
conversion_engine_version
conversion_started_at
conversion_finished_at
conversion_warnings
extracted_metadata
```

O suporte de `markitdown-ts` para URLs e YouTube nao deve substituir as decisoes ja tomadas: Defuddle continua sendo o caminho primario para paginas web, e `youtubei.js` continua sendo o caminho inicial para YouTube.

## YouTube e Videos Web

Paginas de video, especialmente YouTube, devem ter um fluxo proprio. Defuddle pode ajudar a capturar metadados visiveis na pagina, como titulo, descricao e informacoes presentes no DOM, mas o caminho inicial para metadados e transcricoes de YouTube sera `youtubei.js`, mantendo a implementacao em TypeScript e sem depender de executaveis externos.

Para YouTube, a estrategia inicial deve ser:

```txt
URL do video
  -> identificar video_id
  -> buscar metadados estruturados via youtubei.js
  -> obter transcricao via youtubei.js quando disponivel/autorizado
  -> normalizar transcricao para Markdown
  -> criar SourceItem do tipo Video
  -> armazenar transcript como Document/asset
  -> gerar resumo, chunks, embeddings e notas atomicas
```

Fontes de metadados:

- `youtubei.js` como provedor inicial para metadados publicos e dados de video;
- oEmbed ou metadados publicos como fallback simples;
- YouTube Data API `videos.list` pode ser considerada futuramente quando houver API key configurada e vantagem clara de robustez, quota ou conformidade.

Transcricoes:

- `youtubei.js` sera o provedor inicial para listar e obter faixas de transcricao/legenda disponiveis;
- para videos publicos de terceiros, a API oficial de captions tem restricoes de autorizacao e nao deve ser assumida como caminho universal;
- YouTube Data API `captions.download` pode ser considerada futuramente apenas quando o usuario tiver autorizacao adequada sobre o video;
- toda transcricao deve registrar idioma, origem, tipo de legenda, data de captura e ferramenta usada.

`yt-dlp` fica fora do escopo inicial. Ele podera ser reavaliado no futuro como helper opcional se o caminho TypeScript-first nao atender casos importantes, mas nao deve orientar a arquitetura inicial.

O uso de APIs nao oficiais de YouTube deve ser configuravel, transparente para o usuario e respeitar limites legais, termos de uso, privacidade e disponibilidade da plataforma.

## Extensao Chrome

A extensao Chrome sera uma aplicacao isolada dentro do monorepo. Ela sera responsavel por capturar conteudo web e envia-lo para a aplicacao desktop.

Responsabilidades iniciais:

- capturar URL, titulo, selecao, conteudo principal e metadados de paginas web;
- permitir envio manual de conteudo para o desktop;
- exibir estado basico de conexao com a aplicacao;
- usar contratos de `@app/integration-contracts`;
- validar payloads antes de enviar quando fizer sentido;
- manter UI, manifest, permissoes e build independentes da aplicacao desktop.

A extensao nao deve acessar banco, repositorios, workers ou codigo do main process. Ela deve depender apenas de pacotes compartilhados seguros, como `@app/domain`, `@app/integration-contracts` e, se apropriado, `@app/i18n`.

## Plugin Obsidian

O plugin Obsidian sera uma aplicacao isolada dentro do monorepo. Ele devera se comunicar bidirecionalmente com a aplicacao desktop para enviar notas, receber contexto e sincronizar informacoes relevantes.

Responsabilidades iniciais:

- enviar notas, selecoes e metadados do vault para o desktop;
- receber eventos, resultados ou referencias vindas do desktop;
- expor comandos e superficies de UI dentro do Obsidian;
- usar contratos de `@app/integration-contracts`;
- manter isolamento em relacao ao banco e aos servicos internos do desktop;
- preservar limites e convencoes do ambiente de plugins do Obsidian.

O plugin podera evoluir para fluxos mais ricos, como inserir backlinks, criar notas derivadas, consultar entidades relacionadas ou anexar evidencias vindas da base de conhecimento. Esses fluxos devem ser tratados como comandos/eventos versionados no contrato de integracao.

## Pacote `@app/domain`

O pacote `@app/domain` sera a linguagem comum da aplicacao. Ele deve evitar dependencias pesadas e poder ser usado por renderer, preload, main process, workers, testes e banco.

Tipos canonicos iniciais:

- `ContentSource`
- `SourceItem`
- `Document`
- `Chunk`
- `Entity`
- `GraphEntity`
- `Relation`
- `SourceSpan`
- `EmbeddingJob`
- `IngestionJob`
- `ExtractionJob`
- `LanguageCode`
- `KnowledgeSource`
- `DocumentAsset`
- `BibliographicWork`
- `BibliographicInstance`
- `PublicationIssue`
- `Claim`
- `Question`
- `AtomicNote`
- `AtomicNoteRelation`
- `AtomicNoteSourceLink`
- `SourceSummary`
- `Moc`
- `WikiPage`
- `SearchQuery`
- `SearchResult`

Tambem devera conter schemas Zod compartilhados, como:

- `DocumentIdSchema`
- `SourceItemSchema`
- `ContentSourceSchema`
- `CreateDocumentInputSchema`
- `SearchQuerySchema`
- `EntitySchema`
- `GraphEntitySchema`
- `RelationSchema`
- `SourceSpanSchema`
- `BibliographicWorkSchema`
- `ClaimSchema`
- `AtomicNoteSchema`
- `AtomicNoteRelationSchema`
- `JobStatusSchema`
- `LanguageCodeSchema`

Esse pacote deve definir o vocabulario estavel do sistema. Mudancas nele devem ser feitas com cuidado, pois tendem a afetar varias camadas.

## Pacote `@app/integration-contracts`

O pacote `@app/integration-contracts` sera a fronteira compartilhada entre a aplicacao desktop, a extensao Chrome e o plugin Obsidian.

Ele deve conter apenas contratos, schemas, tipos de eventos e utilitarios seguros para ambientes externos. Nao deve importar Electron, PGlite, Drizzle, Node APIs privilegiadas ou codigo de servicos internos.

Responsabilidades:

- definir comandos aceitos pelo Integration Gateway;
- definir eventos emitidos pelo desktop para clientes externos;
- definir schemas Zod de payloads externos;
- versionar contratos de integracao;
- declarar capacidades de clientes;
- padronizar respostas, erros e estados de conexao;
- permitir que Chrome Extension e Obsidian Plugin sejam desenvolvidos e testados sem depender do codigo interno do desktop.

Exemplos de contratos futuros:

```ts
CaptureWebPageRequest
CaptureSelectionRequest
CaptureWebPageAsMarkdownRequest
CaptureYouTubeVideoRequest
ImportObsidianNoteRequest
SearchFromExternalClientRequest
IntegrationEvent
IntegrationClientCapabilities
IntegrationHandshake
```

Esse pacote deve ser tratado como uma API publica interna. Mudancas breaking devem ser versionadas explicitamente.

## Pacote `@app/ai`

O pacote `@app/ai` deve concentrar abstracoes compartilhadas para provedores de IA, modelos de processamento, embeddings e modelos locais.

Ele deve ser usado pelo desktop e pelos workers, mas nao deve expor segredos nem depender diretamente da UI. A extensao Chrome e o plugin Obsidian nao devem chamar provedores de IA diretamente no fluxo padrao; eles devem enviar conteudo ao desktop, que executa o pipeline configurado.

Responsabilidades:

- definir interfaces comuns para provedores de IA;
- definir interfaces comuns para provedores de embedding;
- definir interfaces comuns para adaptadores de modelo;
- manter registro de modelos, capacidades e disponibilidade;
- negociar o modelo adequado para cada tarefa a partir de capabilities;
- definir adaptador local para `node-llama-cpp`;
- listar modelos disponiveis por provedor quando a API permitir;
- validar configuracoes de modelos;
- mapear capacidades de modelos por tarefa;
- registrar metadados de execucao, como modelo, provedor, dimensoes, prompt version e parametros;
- suportar modelos locais baixaveis;
- padronizar erros de provedor para mensagens localizadas.

Provedores de processamento inicial:

```txt
OpenAI
Google
Anthropic
OpenRouter
Local embedded node-llama-cpp runtime
Generic OpenAI-compatible endpoint
```

Provedores de embedding inicial:

```txt
OpenAI
Google
Local embedding models
```

## Pacote `@app/conversion`

O pacote `@app/conversion` deve concentrar interfaces, adaptadores e utilitarios de conversao para Markdown. Ele deve manter uma API comum para motores diferentes, permitindo que workers e servicos de aplicacao escolham o conversor correto sem acoplar o pipeline a uma biblioteca especifica.

Responsabilidades:

- definir contratos de conversao de entrada e saida;
- padronizar metadados de conversao, avisos e erros;
- encapsular `markitdown-ts` para arquivos locais, anexos e buffers;
- encapsular Defuddle para paginas web e DOM renderizado;
- encapsular normalizadores para transcricoes obtidas via `youtubei.js`;
- aplicar pos-processamento de Markdown normalizado;
- registrar motor, versao, opcoes e qualidade estimada da conversao;
- expor erros recuperaveis e mensagens localizaveis via i18n.

`@app/conversion` nao deve acessar banco diretamente. Ele deve receber entradas ja autorizadas e retornar resultados estruturados para os servicos de aplicacao persistirem via `@app/db`.

## Taxonomia de Conteudo e Entidades

O sistema deve distinguir entre itens de acervo e entidades do grafo.

Itens de acervo sao fontes ingeridas, catalogadas e indexadas. Entidades do grafo sao pessoas, organizacoes, lugares, conceitos, eventos, obras e outros elementos mencionados, relacionados ou extraidos das fontes.

Essa separacao evita misturar "coisas que sao fontes" com "coisas que aparecem dentro das fontes".

```txt
SourceItem
  -> conteudo ingerido ou catalogado
  -> possui metadados, assets, chunks e SourceSpans
  -> pode gerar embeddings, entidades, relacoes e claims

GraphEntity
  -> no conceitual do grafo
  -> pode ser extraido, importado ou criado manualmente
  -> pode se relacionar com SourceItems, chunks e outras entidades
```

## Itens de Acervo

Tipos iniciais de itens de acervo:

- `PersonalNote`: nota avulsa pessoal.
- `DailyNote`: nota diaria.
- `WebArticle`: artigo ou pagina web com URL, titulo, autor, data e metadados disponiveis.
- `BlogPost`: post de blog, quando fizer sentido diferenciar de artigo web generico.
- `Book`: livro, com dados de catalogacao e imagens de capa.
- `BookChapter`: capitulo de livro, conectado ao livro, com titulo, autores quando houver e paginas quando disponiveis.
- `Magazine`: revista como publicacao seriada ou colecao.
- `MagazineIssue`: edicao especifica de revista.
- `MagazineArticle`: artigo de revista, conectado a uma edicao de revista quando disponivel.
- `Journal`: periodico academico ou tecnico.
- `JournalVolume`: volume de periodico.
- `JournalIssue`: numero/edicao de periodico.
- `JournalArticle`: artigo de periodico, conectado ao periodico, volume/numero e paginas quando disponiveis.
- `StandaloneArticle`: artigo fora de periodico, com titulo, autores, paginas e metadados disponiveis.
- `Manual`: manual, guia tecnico ou documentacao.
- `ResearchPaper`: paper academico, preprint ou conference paper.
- `AcademicThesis`: tese, dissertacao ou monografia.
- `Report`: relatorio tecnico, institucional, whitepaper ou estudo.
- `NewsletterIssue`: edicao de newsletter.
- `Email`: email arquivado como fonte de conhecimento.
- `SocialPost`: post, thread ou discussao de rede social, forum ou comunidade.
- `Course`: curso completo.
- `Lecture`: aula, palestra, conferencia ou apresentacao.
- `Video`: video com site, URL, autor, canal, episodio, transcricao e metadados.
- `PodcastEpisode`: episodio de podcast com site, URL, autor, canal, episodio, transcricao e metadados.
- `Dataset`: conjunto de dados citado ou importado.
- `SoftwareRepository`: repositorio de software, pacote ou projeto tecnico.
- `LegalDocument`: lei, norma, regulamento, contrato, decisao judicial ou documento juridico.
- `Image`: imagem avulsa com metadados, descricao, OCR ou analise visual.
- `GenericDocument`: PDF, DOCX, TXT, Markdown, EPUB ou arquivo ainda nao classificado.
- `Archive`: ZIP, pasta ou conjunto de documentos importados em lote.

Os tipos bibliograficos devem permitir modelar hierarquias:

```txt
Book
  -> BookChapter

Magazine
  -> MagazineIssue
    -> MagazineArticle

Journal
  -> JournalVolume
    -> JournalIssue
      -> JournalArticle

Course
  -> Lecture
```

## Entidades do Grafo

Tipos iniciais de entidades do grafo:

- `Person`: pessoa, incluindo autores e pessoas mencionadas. Pode conter nome, aliases, nascimento, morte, areas de atuacao, descricao e pagina da Wikipedia quando disponivel.
- `Organization`: empresa, universidade, editora, orgao publico, instituicao ou organizacao.
- `Place`: pais, cidade, regiao, endereco ou local fisico.
- `Event`: acontecimento historico, conferencia, reuniao, lancamento, guerra ou marco relevante.
- `Concept`: ideia, tema, tecnica, teoria, escola de pensamento ou topico abstrato.
- `Work`: obra abstrata, independente de uma edicao especifica.
- `Publication`: publicacao seriada abstrata, como uma revista ou periodico enquanto entidade conceitual.
- `Publisher`: editora ou publicador.
- `Project`: projeto pessoal, academico, empresarial ou open source.
- `Product`: produto, ferramenta, modelo, servico ou tecnologia.
- `FieldOfStudy`: area de conhecimento ou disciplina.
- `Tag`: classificacao manual ou semiautomatica.
- `Collection`: colecao tematica criada pelo usuario.

Tipos investigativos conectados ao grafo:

- `Claim`: afirmacao extraida de uma fonte, sempre com evidencia.
- `Question`: pergunta aberta do usuario ou questao de pesquisa.

`Claim` e `Question` sao importantes porque permitem que o sistema va alem de catalogacao. Eles transformam a base de conhecimento em uma ferramenta de investigacao, com perguntas abertas, afirmacoes rastreaveis e evidencias conectadas a trechos especificos.

## Camadas Bibliograficas

Para evitar ambiguidade entre obra, edicao e arquivo importado, o modelo deve separar:

```txt
BibliographicWork
  -> obra abstrata
  -> exemplo: "A Republica", "Nature", "Clean Architecture"

BibliographicInstance
  -> edicao, volume, issue, arquivo ou manifestacao concreta
  -> exemplo: edicao de 2011, volume 42 numero 3, PDF importado

SourceItem
  -> item efetivamente ingerido e indexado
  -> exemplo: arquivo PDF, pagina capturada, capitulo escaneado
```

Exemplos de relacoes:

```txt
Person -> authored -> SourceItem
Person -> edited -> BibliographicInstance
BookChapter -> partOf -> Book
MagazineArticle -> publishedIn -> MagazineIssue
JournalArticle -> publishedIn -> JournalIssue
JournalIssue -> issueOf -> Journal
Claim -> supportedBy -> SourceSpan
Concept -> mentionedIn -> Chunk
Question -> investigates -> Concept
SourceItem -> storedAs -> DocumentAsset
```

## Sistema de Notas Atomicas Zettelkasten

A aplicacao deve gerenciar um sistema de notas atomicas no estilo Zettelkasten. Essas notas serao geradas automaticamente a partir da importacao de cada fonte de conteudo e tambem poderao ser refinadas, editadas ou conectadas manualmente no futuro.

Uma nota atomica deve representar uma ideia especifica, formulada de maneira independente, com referencia clara a sua fonte e as evidencias usadas para cria-la.

Fluxo conceitual:

```txt
Fonte de conteudo importada
  -> conversao para Markdown normalizado
  -> catalogacao
  -> armazenamento do conteudo e assets
  -> criacao de entidades, elementos e relacoes da fonte
  -> geracao de resumo quando a fonte for longa
  -> identificacao das ideias presentes no conteudo
  -> criacao de notas atomicas Zettelkasten
  -> relacao das notas com fonte, chunks, SourceSpans, claims e entidades
  -> busca por notas atomicas existentes relacionadas
  -> combinacao de busca vetorial, grafo, scores e reranking
  -> filtragem de conexoes fracas
  -> persistencia das relacoes entre notas no banco SQL
```

Ao final de uma importacao, o sistema deve ter:

- a fonte de conteudo em Markdown normalizado;
- o item de acervo catalogado;
- assets e metadados preservados;
- entidades, mencoes, claims e relacoes extraidas;
- resumo gerado para fontes longas;
- notas atomicas que representam as ideias principais e secundarias do conteudo;
- relacoes entre essas notas atomicas e a fonte original;
- relacoes entre novas notas atomicas e notas atomicas ja existentes.

Tipos conceituais:

```txt
AtomicNote
  -> representa uma ideia atomica
  -> possui corpo em Markdown
  -> aponta para fontes, evidencias e entidades
  -> pode ter embedding proprio

AtomicNoteSourceLink
  -> conecta nota atomica a SourceItem, Chunk, Claim ou SourceSpan
  -> preserva proveniencia

AtomicNoteRelation
  -> conecta duas notas atomicas
  -> possui tipo, score e sinais usados na decisao

SourceSummary
  -> resumo gerado para fonte longa
  -> vinculado ao SourceItem e ao pipeline/modelo usado
```

As relacoes entre notas atomicas devem ser persistidas no banco SQL, mesmo quando forem descobertas por busca vetorial e grafo. O grafo pode ser usado para descoberta, expansao e consulta, mas a relacao validada entre notas deve ter registro canonico consultavel e auditavel.

## MOCs e Wikis

MOCs, wikis e outras estruturas de navegacao humana serao uma camada posterior sobre o sistema de notas atomicas.

Essas estruturas nao devem substituir as relacoes atomicas de baixo nivel. Elas devem organizar caminhos de leitura, mapas tematicos, trilhas conceituais e paginas de navegacao a partir de notas, fontes, entidades e colecoes.

Tipos previstos para refinamento futuro:

```txt
Moc
  -> mapa de conteudo curado ou semiautomatico
  -> organiza notas e fontes em torno de um tema

WikiPage
  -> pagina navegavel para humanos
  -> pode combinar notas, fontes, entidades, claims e links
```

## Pacote `@app/db`

O pacote `@app/db` sera responsavel pela persistencia e pelas consultas.

Responsabilidades:

- criar e configurar o cliente PGlite;
- declarar schemas Drizzle;
- manter migrations;
- criar extensoes necessarias, como `pgvector` e Apache AGE;
- implementar repositorios;
- concentrar queries especializadas;
- expor funcoes transacionais;
- manter queries de busca textual, vetorial, hibrida e de grafo.

Estrutura conceitual:

```txt
@app/db
  src/
    client.ts
    migrations/
    schema/
      documents.ts
      source-items.ts
      chunks.ts
      embeddings.ts
      atomic-notes.ts
      atomic-note-relations.ts
      source-summaries.ts
      bibliographic.ts
      entities.ts
      relations.ts
      claims.ts
      questions.ts
      source-spans.ts
      jobs.ts
      integration-clients.ts
      ai-settings.ts
      local-models.ts
      settings.ts
    repositories/
      source-item-repository.ts
      document-repository.ts
      chunk-repository.ts
      atomic-note-repository.ts
      atomic-note-link-repository.ts
      bibliographic-repository.ts
      search-repository.ts
      graph-repository.ts
      ai-settings-repository.ts
      local-model-repository.ts
      job-repository.ts
      settings-repository.ts
    queries/
      full-text-search.ts
      vector-search.ts
      hybrid-search.ts
      atomic-note-matching.ts
      graph-traversal.ts
```

## Banco de Dados

PGlite sera a fonte de verdade local da aplicacao desktop. O banco devera armazenar itens de acervo, documentos em Markdown, assets, chunks, embeddings, metadados bibliograficos, entidades, mencoes, relacoes, claims, questions, notas atomicas, relacoes entre notas atomicas, resumos, jobs, configuracoes, configuracoes nao sensiveis de IA, clientes externos autorizados e metadados.

Modelo conceitual inicial:

```txt
source_items
  id
  type
  title
  subtitle
  source_origin
  original_uri
  content_hash
  language
  summary
  summary_generated_at
  metadata
  created_at
  updated_at

documents
  id
  source_item_id
  source_type
  title
  original_uri
  content_hash
  language
  markdown_content
  markdown_hash
  conversion_status
  created_at
  updated_at

document_assets
  id
  source_item_id
  document_id
  file_path
  mime_type
  size_bytes
  role
  created_at

source_spans
  id
  source_item_id
  document_id
  page
  start_offset
  end_offset
  selector

chunks
  id
  source_item_id
  document_id
  source_span_id
  text
  token_count
  chunk_index
  language
  created_at

embeddings
  id
  target_type
  target_id
  chunk_id
  provider
  model
  dimensions
  usage
  strategy
  embedding
  created_at

source_summaries
  id
  source_item_id
  summary
  model
  language
  generated_at
  created_at

atomic_notes
  id
  title
  body_markdown
  idea_statement
  language
  status
  created_from_source_item_id
  source_span_id
  evidence_chunk_id
  generation_model
  generation_prompt_version
  created_at
  updated_at

atomic_note_source_links
  id
  atomic_note_id
  source_item_id
  chunk_id
  source_span_id
  claim_id
  relation_type
  confidence
  created_at

atomic_note_entity_links
  id
  atomic_note_id
  entity_id
  relation_type
  confidence
  created_at

atomic_note_relations
  id
  source_atomic_note_id
  target_atomic_note_id
  relation_type
  vector_score
  graph_score
  rerank_score
  final_score
  explanation
  status
  created_at

bibliographic_works
  id
  type
  title
  subtitle
  canonical_title
  language
  metadata
  created_at
  updated_at

bibliographic_instances
  id
  work_id
  type
  edition
  volume
  issue
  publication_date
  publisher
  isbn
  issn
  doi
  metadata
  created_at
  updated_at

source_item_bibliographic_links
  id
  source_item_id
  work_id
  instance_id
  relation_type
  pages
  created_at

entities
  id
  canonical_name
  type
  aliases
  description
  language
  birth_date
  death_date
  fields
  wikipedia_url
  confidence
  created_at

claims
  id
  text
  source_item_id
  evidence_chunk_id
  source_span_id
  confidence
  created_at

questions
  id
  text
  status
  language
  created_at
  updated_at

entity_mentions
  id
  entity_id
  chunk_id
  source_span_id
  surface_text
  confidence

relations
  id
  subject_entity_id
  predicate
  object_entity_id
  evidence_chunk_id
  source_span_id
  confidence
  created_at

ai_provider_configs
  id
  provider
  display_name
  credential_ref
  base_url
  status
  created_at
  updated_at

ai_model_preferences
  id
  task
  provider_config_id
  model_id
  parameters
  created_at
  updated_at

embedding_model_configs
  id
  provider
  model_id
  dimension
  reduced_dimension
  usage
  status
  created_at
  updated_at

local_models
  id
  kind
  model_id
  display_name
  local_path
  version
  size_bytes
  dimension
  format
  runtime
  quantization
  checksum
  capabilities
  status
  created_at
  updated_at

ai_model_capabilities
  id
  model_config_id
  capability
  limits
  requirements
  status
  created_at
  updated_at

ai_task_runs
  id
  task_type
  provider
  model_id
  runtime
  capabilities_used
  input_hash
  output_hash
  status
  error
  started_at
  finished_at

jobs
  id
  type
  status
  payload
  progress
  error
  created_at
  updated_at

integration_clients
  id
  kind
  display_name
  capabilities
  contract_version
  status
  created_at
  last_seen_at
```

O campo `type` de `source_items` devera contemplar os tipos de acervo definidos na taxonomia, como `PersonalNote`, `DailyNote`, `WebArticle`, `Book`, `BookChapter`, `MagazineArticle`, `JournalArticle`, `Video`, `PodcastEpisode`, `GenericDocument` e outros.

O campo `source_origin` devera contemplar origens como importacao manual, captura web pela extensao Chrome, nota do Obsidian, transcricao, OCR e outras fontes futuras.

`documents` pode continuar existindo como tabela concreta para conteudos textuais normalizados ou como detalhe de implementacao. A entidade de produto mais ampla deve ser `source_items`.

`summary` em `source_items` deve ser preenchido para fontes longas durante a importacao. A tabela `source_summaries` permite manter historico, modelo, idioma e novas versoes de resumo quando o pipeline for reexecutado.

`markdown_content` em `documents` representa o conteudo textual normalizado usado pelo pipeline. Assets originais, capas, PDFs, imagens, transcricoes brutas e outros arquivos continuam preservados em `document_assets`.

`atomic_note_relations` e a tabela canonica de ligacoes entre notas atomicas. Essas relacoes podem ser descobertas por busca vetorial, grafo e reranking, mas devem ser persistidas em SQL para auditoria, consulta e evolucao do Zettelkasten.

`ai_provider_configs`, `ai_model_preferences`, `embedding_model_configs`, `local_models`, `ai_model_capabilities` e `ai_task_runs` devem guardar configuracoes, referencias, capacidades e metadados de execucao. Segredos reais, como API keys, devem ficar fora do banco em armazenamento seguro.

## Vetores

`pgvector` sera usado para armazenar embeddings de chunks e notas atomicas, permitindo busca semantica local.

O projeto devera registrar explicitamente:

- modelo usado para gerar o embedding;
- dimensoes do vetor;
- versao do pipeline de chunking;
- data de geracao;
- associacao com o chunk, nota atomica e fonte original quando aplicavel.

Isso sera importante para reindexacao futura, comparacao entre modelos e reproducibilidade.

Para ranking em grande escala, a estrategia inicial recomendada e manter uma etapa de recuperacao rapida e uma etapa de reranking:

```txt
candidate generation
  -> embedding reduzido quando suportado
  -> exemplo: 256 dimensoes

semantic reranking
  -> embedding maior ou dimensao nativa
  -> exemplo: 768 em modelos que suportem essa dimensao
```

Essa regra deve ser orientada por capacidade real do modelo e benchmarks. `google/embeddinggemma-300m` suporta 768 dimensoes e opcoes menores como 512, 256 e 128 via Matryoshka Representation Learning. `intfloat/multilingual-e5-base` tem dimensao nativa de 768.

Dimensoes diferentes nao devem ser misturadas no mesmo indice vetorial. Se o sistema mantiver embeddings de 256 e 768 dimensoes, a persistencia deve separar claramente modelo, dimensao, uso e indice correspondente.

## Grafo

Apache AGE sera usado para consultas e projecoes de grafo. A recomendacao inicial e manter as tabelas relacionais `entities`, `entity_mentions` e `relations` como fonte canonica, usando AGE como uma camada de consulta/projecao.

```txt
entities / relations
  -> fonte relacional tipada
  -> base para auditoria e migracoes

AGE graph
  -> travessias
  -> consultas exploratorias
  -> expansao de contexto
```

Essa separacao reduz o acoplamento ao motor de grafo e preserva a possibilidade de trocar ou complementar AGE no futuro, caso benchmarks mostrem limitacoes.

## Pipeline de Ingestao

A ingestao devera ser assincrona e baseada em jobs persistidos.

Fluxo inicial:

```txt
Receber conteudo
  -> desktop, Chrome Extension ou Obsidian Plugin
  -> validar contrato de entrada
  -> extrair pagina web com Defuddle quando a fonte for URL/pagina
  -> converter arquivos com markitdown-ts quando a fonte for arquivo local/anexo
  -> aplicar fluxo proprio para YouTube e videos web quando aplicavel
  -> classificar tipo de SourceItem
  -> extrair metadados de catalogacao
  -> salvar asset bruto
  -> criar SourceItem
  -> converter conteudo para Markdown normalizado
  -> criar Document com Markdown normalizado
  -> vincular obra, instancia, volume, issue ou item relacionado quando aplicavel
  -> criar IngestionJob
  -> carregar modelos configurados para cada tarefa
  -> gerar resumo quando a fonte for longa
  -> detectar idioma
  -> criar SourceSpans
  -> gerar chunks
  -> gerar embeddings
  -> extrair entidades
  -> extrair claims
  -> extrair relacoes
  -> gerar notas atomicas Zettelkasten para cada ideia relevante
  -> relacionar notas atomicas com fonte, chunks, SourceSpans, claims e entidades
  -> buscar notas atomicas existentes relacionadas
  -> combinar sinais vetoriais e de grafo
  -> aplicar score e reranking
  -> persistir relacoes qualificadas entre notas atomicas no SQL
  -> atualizar indices
  -> atualizar projecao de grafo
```

Workers previstos:

```txt
ingestion.worker.ts
file-conversion.worker.ts
web-extraction.worker.ts
youtube-metadata.worker.ts
transcript-download.worker.ts
markdown-conversion.worker.ts
model-discovery.worker.ts
local-model-download.worker.ts
chunking.worker.ts
summarization.worker.ts
ocr.worker.ts
transcription.worker.ts
embedding.worker.ts
entity-extraction.worker.ts
relation-extraction.worker.ts
atomic-note-generation.worker.ts
atomic-note-linking.worker.ts
atomic-note-reranking.worker.ts
graph-projection.worker.ts
```

A fila inicial pode ser implementada no proprio PGlite. Isso permite retomar trabalhos interrompidos quando a aplicacao for fechada e aberta novamente.

## Busca

A busca devera ser hibrida desde a fundacao e devera servir tanto a recuperacao de fontes quanto a descoberta de relacoes entre notas atomicas.

Fluxo conceitual:

```txt
Consulta do usuario
  -> normalizacao
  -> deteccao/uso de idioma
  -> busca textual
  -> busca vetorial
  -> expansao opcional via grafo
  -> combinacao de scores
  -> reranking
  -> resultados com evidencias
```

Cada resultado devera apontar para:

- item de acervo;
- documento de origem;
- trecho exato;
- `SourceSpan`;
- entidades relacionadas;
- score textual;
- score semantico;
- score combinado;
- evidencias usadas.

Regra de produto: conhecimento exibido ao usuario deve ser rastreavel ate a fonte original sempre que possivel.

Para o Zettelkasten, a busca tambem deve encontrar notas atomicas existentes que tenham conexao real de ideias com uma nova nota. O processo deve combinar:

- similaridade vetorial entre notas e chunks;
- relacoes de grafo via entidades, claims, obras, pessoas, conceitos e fontes;
- sinais bibliograficos e catalograficos;
- score combinado;
- reranking para remover conexoes superficiais;
- persistencia apenas das relacoes que passarem um limiar de relevancia.

## i18n

O projeto tera i18n na aplicacao desktop, na extensao Chrome, no plugin Obsidian e nas mensagens de backend que forem visiveis ao usuario.

Regra obrigatoria: NUNCA escrever textos diretamente no codigo. Todo texto de produto deve passar pelo sistema de i18n, incluindo labels, botoes, menus, placeholders, tooltips, mensagens de erro, mensagens de sucesso, status de jobs, nomes de comandos, textos de onboarding, estados vazios, notificacoes e dialogs.

Strings tecnicas inevitaveis, como ids de protocolo, nomes de eventos, enums, nomes de tabelas, rotas internas e constantes de contrato, devem ser tratadas como identificadores tecnicos, nao como texto exibido ao usuario.

Idiomas iniciais:

- `en` como padrao;
- `pt-BR`;
- `it`;
- `fr`;
- `es`.

Sera importante separar:

- idioma da interface;
- idioma da extensao Chrome;
- idioma do plugin Obsidian;
- idioma dos documentos ingeridos;
- idioma da consulta;
- idioma das mensagens internas visiveis ao usuario.

Exemplo:

```txt
uiLocale = "pt-BR"
document.language = "en"
query.language = "pt-BR"
```

Estrutura proposta:

```txt
@app/i18n
  src/
    locales/
      en.json
      pt-BR.json
      it.json
      fr.json
      es.json
    index.ts
    language.ts
    message-keys.ts
```

Mensagens tecnicas que aparecem para o usuario, como erros de importacao, status de jobs, falhas de conexao com clientes externos ou pedidos de autorizacao, tambem devem passar pelo sistema de i18n.

## Estrutura Inicial do Repositorio

Estrutura proposta para o projeto quando a implementacao comecar:

```txt
apps/
  desktop/
    electron.vite.config.ts
    src/
      main/
        index.ts
        integration-gateway/
        ipc/
        services/
        workers/
        i18n/
      preload/
        index.ts
        api.ts
      renderer/
        src/
          app/
          features/
          components/
          i18n/

  chrome-extension/
    manifest.json
    src/
      background/
      content/
      popup/
      options/
      integration-client/
      i18n/

  obsidian-plugin/
    manifest.json
    src/
      main.ts
      commands/
      views/
      settings/
      integration-client/
      i18n/

packages/
  domain/
    src/
      document.ts
      source-item.ts
      chunk.ts
      entity.ts
      graph-entity.ts
      relation.ts
      source-span.ts
      bibliographic.ts
      claim.ts
      question.ts
      atomic-note.ts
      zettelkasten.ts
      moc.ts
      wiki-page.ts
      jobs.ts
      search.ts
      language.ts
      schemas.ts

  integration-contracts/
    src/
      version.ts
      handshake.ts
      commands.ts
      events.ts
      errors.ts
      chrome.ts
      obsidian.ts
      schemas.ts

  ai/
    src/
      providers/
        openai.ts
        google.ts
        anthropic.ts
        openrouter.ts
        node-llama-cpp.ts
        local.ts
        openai-compatible.ts
      embeddings/
        openai.ts
        google.ts
        local.ts
      models/
        adapter.ts
        discovery.ts
        local-models.ts
        capabilities.ts
        registry.ts
        task-request.ts
        task-result.ts
      types.ts

  conversion/
    src/
      converters/
        defuddle.ts
        markitdown.ts
        youtube-transcript.ts
      markdown-normalizer.ts
      metadata.ts
      types.ts

  db/
    src/
      client.ts
      schema/
      repositories/
      queries/
      migrations/

  i18n/
    src/
      locales/
      index.ts
      types.ts

docs/
  initial.md
```

## Regras de Isolamento

O monorepo deve preservar fronteiras claras entre os tres elementos do projeto.

Regras iniciais:

- `apps/desktop` pode depender de `@app/domain`, `@app/db`, `@app/ai`, `@app/conversion`, `@app/i18n` e `@app/integration-contracts`.
- `apps/chrome-extension` pode depender de `@app/domain`, `@app/i18n` e `@app/integration-contracts`.
- `apps/obsidian-plugin` pode depender de `@app/domain`, `@app/i18n` e `@app/integration-contracts`.
- `@app/db` nao deve ser importado pela extensao Chrome nem pelo plugin Obsidian.
- `@app/ai` nao deve ser importado pela extensao Chrome nem pelo plugin Obsidian no fluxo padrao.
- `@app/conversion` nao deve ser importado por clientes externos quando incluir adaptadores dependentes de Node ou acesso a filesystem.
- Defuddle pode ser usado na extensao Chrome e no desktop, mas os resultados devem ser enviados ao pipeline por contratos de integracao.
- codigo do main process do Electron nao deve ser importado pela extensao Chrome nem pelo plugin Obsidian.
- contratos externos devem viver em `@app/integration-contracts`, nao espalhados dentro de cada app.
- detalhes de transporte devem ficar em adaptadores locais de cada app.
- regras de negocio centrais devem viver nos servicos do desktop e nos pacotes de dominio, nao nos clientes externos.

Essa separacao permite evoluir cada elemento com seu proprio build, permissoes, lifecycle e empacotamento, mantendo compatibilidade por contratos versionados.

## Qualidade e Testes

Testes de regressao devem ser criados sempre que pertinente, usando a infraestrutura de testes existente no backend, no frontend, na extensao Chrome e no plugin Obsidian.

Preferencias de teste:

- validar logica de dominio;
- validar contratos de API e schemas Zod;
- validar repositorios e queries criticas;
- validar migrations quando houver mudanca estrutural;
- validar composicao de componentes;
- validar fluxos sem depender de interacao manual com GUI;
- validar clientes de integracao por meio de contratos e adaptadores simulados.

Testes baseados na interface grafica devem ser usados apenas quando a natureza do problema realmente exigir validacao visual, comportamento de janela, integracao com browser, Obsidian ou fluxos que nao possam ser cobertos de forma confiavel por testes de unidade, integracao ou contrato.

## Migrations e Banco

Toda alteracao no `schema.ts` ou nos schemas Drizzle equivalentes exige a geracao de uma nova migration via:

```bash
npm run db:generate
```

Depois de gerar a migration, a migration deve ser aplicada pelo fluxo padrao do projeto. A task nao deve ser considerada concluida apenas porque o comando de migration terminou sem erro.

Verificacao obrigatoria pos-migration:

- confirmar no banco real que a migration foi registrada em `drizzle.__drizzle_migrations`;
- confirmar a estrutura alterada em `information_schema` ou por consulta direta na tabela afetada;
- quando aplicavel, validar indices, constraints, colunas, tipos, extensoes e dados migrados;
- registrar no resumo da tarefa quais consultas ou verificacoes foram usadas.

Essa regra vale especialmente para tabelas ligadas a `source_items`, `atomic_notes`, relacoes entre notas, entidades, relacoes, embeddings, configuracoes de IA, modelos locais, jobs, integration clients e qualquer schema compartilhado por workers ou clientes externos.

## Git e Entrega

O fluxo padrao e nao fazer o commit final automaticamente. Ao concluir uma tarefa, informar que esta pronta para o commit final e listar os arquivos alterados, verificacoes realizadas e eventuais pendencias.

## Principios de Produto

- A base de conhecimento deve ser local-first.
- O sistema deve diferenciar itens de acervo, entidades do grafo, obras abstratas, instancias bibliograficas e assets fisicos/digitais.
- A importacao deve produzir conhecimento navegavel, nao apenas arquivos indexados.
- Notas atomicas Zettelkasten devem representar ideias especificas, com proveniencia e conexoes justificaveis.
- Relacoes entre notas atomicas devem ser persistidas no SQL e manter os sinais usados na decisao.
- Fontes longas devem receber resumo gerado durante a importacao.
- Modelos e provedores de IA devem ser configuraveis por tarefa.
- API keys e segredos devem ser protegidos e nunca aparecer em logs, banco em texto puro ou UI depois de salvos.
- Embeddings devem registrar modelo, provedor, dimensao e estrategia usada.
- Toda informacao derivada deve manter referencia a evidencias.
- O usuario deve conseguir entender de onde uma resposta, relacao ou entidade veio.
- A aplicacao deve suportar reprocessamento e reindexacao.
- O modelo de dados deve registrar versoes de pipelines e modelos.
- A UI deve favorecer exploracao, leitura e recuperacao, nao apenas chat.
- Clientes externos devem ser autorizados e isolados por contrato.
- A extensao Chrome e o plugin Obsidian devem ser convenientes sem se tornarem donos da base de conhecimento.
- A arquitetura deve permitir evoluir para sync, backup ou modo servidor no futuro, sem exigir reescrita completa.

## Pontos a Validar Cedo

Alguns pontos devem ser validados com prototipos e benchmarks antes de se tornarem compromissos rigidos:

- performance do PGlite com centenas de milhares e milhoes de chunks;
- performance de `pgvector` dentro do ambiente desktop;
- comportamento de Apache AGE dentro do PGlite para consultas reais;
- custo de cold start com banco grande;
- tamanho em disco de embeddings;
- velocidade de ingestao e reindexacao;
- estrategia de backup/exportacao;
- concorrencia entre UI, workers e banco;
- limites de OCR e transcricao locais;
- estrategia para modelos locais versus APIs externas;
- empacotamento, assinatura e distribuicao de `node-llama-cpp` no Electron por sistema operacional;
- desempenho de `node-llama-cpp` com GGUF em CPU, Metal, CUDA e Vulkan;
- transporte inicial do Integration Gateway;
- pareamento, autorizacao e revogacao de clientes externos;
- comunicacao da extensao Chrome com a aplicacao desktop;
- comunicacao bidirecional do plugin Obsidian com a aplicacao desktop;
- estrategia de versionamento dos contratos de integracao;
- empacotamento e distribuicao dos tres elementos;
- taxonomia inicial de itens de acervo e entidades;
- qualidade da extracao automatica de metadados bibliograficos;
- reconciliacao de pessoas, organizacoes, obras e publicacoes duplicadas;
- qualidade da conversao de diferentes fontes para Markdown normalizado;
- qualidade do Defuddle em diferentes tipos de pagina web;
- qualidade do `markitdown-ts` para PDF, DOCX, XLSX, HTML, CSV, XML, IPYNB, ZIP e outros arquivos;
- estrategia de fallback quando Defuddle falhar ou extrair conteudo insuficiente;
- estrategia de fallback quando `markitdown-ts` falhar, produzir Markdown fraco ou encontrar arquivo escaneado;
- confiabilidade de `youtubei.js` para metadados e transcricoes em paginas de video, especialmente YouTube;
- qualidade da geracao de resumos para fontes longas;
- qualidade da geracao de notas atomicas por ideia;
- precisao do matching entre notas atomicas existentes e novas;
- calibragem de score, limiar de relevancia e reranking para relacoes entre notas;
- qualidade e latencia dos provedores de IA por tarefa;
- descoberta dinamica de modelos por provedor;
- armazenamento seguro de API keys em cada sistema operacional;
- download, verificacao, atualizacao e remocao de modelos locais;
- comparacao entre embedding remoto e local;
- benchmark de indice rapido com 256 dimensoes versus dimensao nativa/maior para reranking;
- estrategia futura para MOCs e wikis como camada de navegacao humana.

## MVP Tecnico Sugerido

O primeiro MVP tecnico deve provar a espinha dorsal do sistema:

1. Aplicacao Electron com React via `electron-vite`.
2. Renderer com React 19, Tailwind CSS 4 e `shadcn/ui`.
3. IPC tipado com Zod entre renderer, preload e main.
4. Estrutura isolada para `apps/chrome-extension`.
5. Estrutura isolada para `apps/obsidian-plugin`.
6. `@app/integration-contracts` com contratos iniciais.
7. Integration Gateway minimo no desktop.
8. PGlite inicializado no main process.
9. Drizzle com schema, migrations basicas e fluxo `npm run db:generate`.
10. Verificacao pos-migration no banco real.
11. Area de configuracoes inicial.
12. Cadastro seguro de provedor de IA e API key.
13. Listagem dinamica de modelos quando suportada pelo provedor.
14. Selecao de modelo de processamento por tarefa.
15. Selecao de modelo de embedding remoto ou local.
16. `AiModelAdapter` e registry de modelos com capabilities.
17. Negociacao de modelo por tarefa a partir de capabilities.
18. Runtime local com `node-llama-cpp` integrado ao main process.
19. Registro de modelos locais GGUF em `local_models`.
20. Taxonomia inicial de `SourceItem` e `GraphEntity`.
21. Importacao de documento textual simples.
22. Captura externa simulada via contrato de integracao.
23. Criacao de item de acervo com metadados basicos.
24. Extracao de pagina web com Defuddle.
25. Importacao de arquivo local com `markitdown-ts`.
26. Conversao para Markdown normalizado.
27. Fluxo inicial de YouTube/video web com `youtubei.js` para metadados e transcricao.
28. Geracao de resumo para fonte longa.
29. Chunking com `SourceSpan`.
30. Busca textual.
31. Geracao de embeddings para chunks e notas atomicas.
32. Busca vetorial via `pgvector`.
33. Geracao inicial de notas atomicas Zettelkasten.
34. Relacao das notas atomicas com fonte, chunks e entidades.
35. Matching inicial entre notas atomicas usando busca hibrida.
36. Persistencia de relacoes entre notas atomicas no SQL.
37. Busca hibrida com resultados rastreaveis.
38. Jobs persistidos e executados em `worker_threads`.
39. i18n funcional em `en` e `pt-BR`, com estrutura pronta para `it`, `fr` e `es`.
40. Testes de regressao automatizados para contratos, dominio e fluxos criticos.

Depois desse MVP, o projeto pode evoluir para AGE mais profundo, grafo visual, OCR, transcricao, extracao avancada de entidades, relacoes, automacoes, captura real pela extensao Chrome, fluxos bidirecionais ricos com o plugin Obsidian, MOCs e wikis.

## Decisao Arquitetural Atual

A direcao atual do projeto e:

```txt
PGlite + Drizzle
  -> fonte de verdade local

Electron Desktop
  -> nucleo operacional da plataforma

React 19 + Tailwind CSS 4 + shadcn/ui
  -> stack de frontend

Area de Configuracoes
  -> provedores, modelos, embeddings, integracoes e preferencias

OpenAI / Google / Anthropic / OpenRouter / Local
  -> provedores configuraveis de IA

node-llama-cpp
  -> runtime local embutido para modelos GGUF no Electron

Embeddings remotos e locais
  -> OpenAI, Google, EmbeddingGemma e multilingual-e5-base

Defuddle
  -> extracao primaria de paginas web para Markdown limpo

markitdown-ts
  -> conversao primaria de arquivos locais e anexos para Markdown

YouTube/video web pipeline com youtubei.js
  -> metadados estruturados, transcricao e Markdown normalizado

Integration Gateway
  -> entrada autorizada para clientes externos

Chrome Extension
  -> captura de conteudo web

Obsidian Plugin
  -> integracao bidirecional com vaults e notas

pgvector
  -> busca semantica

Apache AGE
  -> consultas e projecoes de grafo

Zod
  -> contratos entre processos e pacotes

worker_threads
  -> processamento pesado

@app/domain
  -> linguagem comum do sistema

@app/ai
  -> provedores de IA, embeddings e modelos locais

@app/conversion
  -> adaptadores de conversao e normalizacao de Markdown

Atomic Notes / Zettelkasten
  -> ideias atomicas geradas a partir das fontes

MOCs e Wikis
  -> camada futura de navegacao humana

@app/integration-contracts
  -> contratos versionados entre desktop, Chrome e Obsidian

@app/db
  -> persistencia e consultas

@app/i18n
  -> mensagens e locales compartilhados

Testes de regressao
  -> contratos, dominio, componentes e fluxos criticos

Migrations Drizzle
  -> geradas com npm run db:generate e verificadas no banco real
```

Essa proposta ainda e inicial. O documento deve servir como base para refinamento progressivo antes da implementacao.
