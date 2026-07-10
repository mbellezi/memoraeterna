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

- Versoes canonicas da stack em `docs/stack-versions.md`; manifests, lockfiles, binarios sidecar e scripts de build devem seguir essa matriz.
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
- Docling sera o motor primario para converter PDF e documentos complexos em Markdown e JSON estruturado, executado em sidecar Python local.
- Conversores TypeScript nativos serao o caminho primario para TXT, Markdown, CSV, JSON, XML, RSS, Atom, IPYNB e HTML local simples.
- `youtubei.js` sera o caminho inicial para metadados e transcricoes de YouTube.
- A importacao deve gerar notas atomicas no estilo Zettelkasten a partir das ideias presentes no conteudo.
- Notas atomicas devem ser relacionadas as fontes, aos elementos catalograficos, as entidades e a outras notas atomicas.
- Fontes longas, como artigos, capitulos, livros, manuais, videos e podcasts, devem receber resumo gerado durante a importacao.
- A aplicacao deve incluir uma area de configuracoes para provedores de IA, modelos de processamento, embeddings, chaves e modelos locais.
- Provedores de IA no MVP: Generic OpenAI-compatible e Google (Gemini). OpenAI, Anthropic e OpenRouter entram na fase seguinte como novos adaptadores.
- Modelos locais via GGUF devem ser executados inicialmente com `node-llama-cpp` embutido na aplicacao Electron.
- Embeddings no MVP: Google (Gemini), endpoints OpenAI-compatible e modelos locais GGUF baixaveis pela interface, inicialmente Qwen3-Embedding-0.6B e BGE-M3.
- PostgreSQL nativo embarcado como sidecar da aplicacao desktop, com binarios por plataforma e `pgvector` incluido, conforme baseline de `docs/stack-versions.md`.
- Main process gerencia o ciclo de vida do sidecar: initdb no primeiro uso, start, shutdown limpo e recuperacao de crash.
- Drizzle ORM sobre `node-postgres`.
- Banco Postgres totalmente vazio deve ser inicializado por seed/baseline
  versionado, registrar no historico Drizzle as migrations cobertas e entao
  rodar migrations pendentes; bancos existentes rodam apenas migrations
  pendentes.
- Seeds/baselines devem ser atualizados junto com as migrations que cobrem. O
  seed inicial pode conter apenas estrutura.
- `pgvector` para busca vetorial, incluido nos binarios do sidecar.
- Apache AGE `PG18/v1.7.0-rc0` para consultas e projecoes de grafo, compilado por plataforma e injetado no bundle do sidecar apos validacao; inicialmente apenas macOS.
- Zod para contratos tipados entre renderer, preload, main process e workers.
- `worker_threads` para ingestao, conversao, chunking, OCR, transcricao, embeddings e extracao de conhecimento; o worker de conversao controla o sidecar Docling quando necessario.
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
- Integration Gateway com servidor HTTP local em loopback no main process e WebSocket para eventos; Native Messaging nao sera usado.
- Busca textual com configuracao `simple`, `unaccent` e `pg_trgm`.
- Ingestao orquestrada como maquina de estados persistida (`ingestion_runs`) com etapas e checkpoints retomaveis.
- Chunks sempre gerados a partir do documento fonte normalizado, nunca do resumo.
- Notas atomicas geradas automaticamente nascem com status `pending_review` e passam por fila de revisao.
- Taxonomia de `SourceItem` reduzida a 8 tipos no MVP; demais tipos documentados ficam para fase seguinte.
- Segredos via Electron `safeStorage`; nunca em texto puro no banco.

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
    contratos de conversao para Markdown e representacao estruturada
    router por formato/politica/perfil de qualidade
    adaptadores para Defuddle, Docling, conversores TypeScript e youtubei.js
    normalizacao de Markdown
    metadados, qualidade e proveniencia de conversao

  @app/db
    cliente Postgres (node-postgres)
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
  -> PostgreSQL (sidecar)

Obsidian Plugin
  <-> Integration Client
  <-> Integration Gateway
  <-> Application Service / Event Bus
  <-> Repository / Worker / Filesystem
  <-> PostgreSQL (sidecar)
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
  -> PostgreSQL (sidecar)
```

## Main Process

O main process sera o backend local da aplicacao. Ele sera responsavel por:

- inicializar a aplicacao Electron;
- gerenciar o ciclo de vida do Postgres sidecar: initdb no primeiro uso, start, shutdown limpo e recuperacao apos crash;
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

Transporte decidido: servidor local em loopback no main process, com HTTP para requisicoes e WebSocket para eventos. Native Messaging nao sera usado; a extensao Chrome e o plugin Obsidian falam diretamente com o servidor local.

Pontos de atencao do transporte:

- a extensao Chrome precisa de `host_permissions` para o endereco local no manifest;
- service workers MV3 hibernam apos inatividade; o cliente da extensao deve reconectar e reestabelecer estado ao acordar;
- porta padrao configuravel, com deteccao de conflito;
- pareamento por token exibido no desktop e informado no cliente externo;
- o desktop precisa estar aberto para receber capturas; clientes devem tratar desconexao com feedback claro e, se util, fila local simples de reenvio.

A arquitetura deve continuar tratando o transporte como detalhe de adaptador. A regra principal e que Chrome Extension e Obsidian Plugin falem com o desktop por contratos versionados, nao por importacao direta de codigo interno.

## Preload

O preload sera a fronteira segura entre o renderer e o main process. Ele devera expor uma API pequena, explicita e tipada.

Exemplos de superficies esperadas:

```ts
window.app.documents.import(...)
window.app.documents.get(...)
window.app.search.query(...)
window.app.graph.expand(...)
window.app.jobs.subscribe(...)
window.app.settings.getApp(...)
window.app.settings.updateApp(...)
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
- configuracoes de idioma, tema, modelos e indexacao;
- exibicao de mensagens localizadas.

O renderer nao deve conter regras de persistencia, acesso direto ao banco ou logica pesada de processamento.

## Frontend Stack

A stack inicial de frontend sera:

- React 19, conforme `docs/stack-versions.md`;
- Tailwind CSS 4, conforme `docs/stack-versions.md`;
- `shadcn/ui`;
- i18n obrigatorio para todo texto de produto.

No desktop, essa stack sera usada no renderer React. Na extensao Chrome, React 19 e Tailwind CSS 4 podem ser usados em popup, options e outras superficies de UI, mantendo o bundle adequado ao ambiente de extensao. No plugin Obsidian, a UI deve respeitar as convencoes do Obsidian; React 19, Tailwind CSS 4 e componentes inspirados em `shadcn/ui` podem ser usados apenas quando fizerem sentido para views customizadas e sem quebrar a integracao visual com o host.

Componentes reutilizaveis devem privilegiar composicao, acessibilidade, responsividade e compatibilidade com i18n. Textos visiveis nao devem ficar embutidos nos componentes.

## Area de Configuracoes

A aplicacao desktop devera incluir uma area de configuracoes para preferencias de usuario, modelos, provedores, integracoes e comportamento do pipeline.

Configuracoes iniciais:

- idioma da interface;
- tema da interface, com `dark` como padrao e alternancia para `light`;
- provedores de IA;
- API keys e credenciais de provedores;
- modelo de IA usado para processamento;
- perfis de configuracao de IA por tarefa;
- perfil de IA padrao ativo;
- modelo de embedding usado para indexacao e matching;
- modelos locais baixados;
- caminho do vault Obsidian usado para projecao e sincronizacao Markdown;
- pasta opcional para copias dos arquivos subidos;
- parametros de chunking, resumo, geracao de notas atomicas e matching;
- clientes externos autorizados;
- preferencias de privacidade e uso local/remoto.

Textos dessa area tambem devem seguir a regra de i18n obrigatorio.

## Configuracoes de IA

A aplicacao deve permitir selecionar o modelo de IA usado pelo pipeline de processamento, incluindo catalogacao, busca de metadados, conversao assistida quando aplicavel, resumo, OCR, parsing de imagens, extracao de entidades, extracao de claims, geracao de notas atomicas e reranking.

Provedores no MVP:

- Google (Gemini);
- Generic OpenAI-compatible endpoint.

Fase seguinte (arquitetura ja preparada por adaptadores):

- OpenAI;
- Anthropic;
- OpenRouter;
- Local embutido via `node-llama-cpp` (interface preparada no MVP, sem dependencia funcional).

Cada provedor remoto deve permitir:

- cadastro de API key ou credencial equivalente;
- teste de conexao;
- listagem dinamica dos modelos disponiveis;
- selecao de um modelo por perfil e roteamento de perfil por tarefa;
- registro de modelo usado em cada artefato gerado;
- tratamento de erro localizavel via i18n.

## Perfis de IA por Tarefa

As configuracoes de IA devem ser agrupadas em perfis reutilizaveis. Cada perfil define exatamente um provedor/modelo, sua configuracao, privacidade e idioma. O usuario pode manter varios perfis e escolher, no roteamento por tarefa, qual perfil — e portanto qual modelo — executa cada etapa do pipeline.

Exemplos de perfis:

```txt
Perfil rapido local
Perfil qualidade maxima
Perfil baixo custo
Perfil privado/offline
Perfil experimental
```

O roteamento deve permitir selecionar um perfil compativel para cada tarefa:

- busca de metadados sobre conteudo;
- catalogacao;
- resumo;
- extracao de entidades;
- extracao de claims;
- geracao de notas atomicas;
- geracao do grafo de conhecimento;
- matching/reranking;
- OCR;
- parsing de imagens;
- transcricao;
- interpretacao de video;
- embeddings de chunks;
- embeddings de notas atomicas;
- assistencia de escrita.

Regras:

- apenas um perfil deve estar ativo como padrao por vez, usado como fallback quando nao houver rota explicita;
- a aplicacao deve permitir clonar um perfil existente;
- a aplicacao deve permitir comparar perfis por cobertura de capabilities, custo estimado, uso local/remoto e privacidade;
- cada perfil deve referenciar um unico modelo remoto ou local;
- cada rota de tarefa deve validar se o modelo do perfil escolhido possui as capabilities necessarias;
- uma tarefa sem modelo configurado deve seguir politica explicita: bloquear, pedir escolha ao usuario ou usar fallback permitido;
- cada artefato gerado deve registrar o perfil, a tarefa, o modelo, o provedor, o runtime e os parametros usados;
- mudancas no perfil ativo so devem afetar novas execucoes, nao alterar historico de artefatos ja gerados.

Seguranca de credenciais:

- API keys nao devem ser armazenadas em texto puro no banco local;
- o banco deve guardar apenas referencias, metadados nao sensiveis e status;
- segredos devem usar Electron `safeStorage` (armazenamento seguro do SO; no Linux depende de keyring disponivel);
- logs nunca devem incluir chaves ou tokens; como excecao de diagnostico, o
  debug habilitado na dashboard pode registrar o output completo de modelos
  locais com aviso explicito de privacidade. Ele fica desabilitado por padrao,
  deve ser desligado apos o debug e nao autoriza registrar respostas de
  provedores remotos.

Selecao por tarefa:

```txt
busca de metadados
catalogacao
resumo
OCR
parsing de imagens
transcricao
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

Modelos de embedding devem aparecer separados dos modelos generativos em cadastro, listagem e seletores de perfil. A separacao usa capabilities reais do adapter; cadastrar um provedor remoto nao pode atribuir automaticamente todas as capabilities ao modelo.

Provedores remotos iniciais:

- OpenAI;
- Google.

Modelos locais baixaveis iniciais:

- `Qwen/Qwen3-Embedding-0.6B`;
- `BAAI/bge-m3`.

O gerenciador de modelos locais deve permitir:

- listar modelos disponiveis para download;
- baixar, verificar e remover modelos;
- registrar versao, tamanho, dimensoes e runtime;
- registrar formato, como GGUF, ONNX ou outro formato futuro;
- registrar backend local, inicialmente `node-llama-cpp` para GGUF;
- indicar se o modelo esta pronto para uso offline;
- escolher modelo padrao para chunks e para notas atomicas.
- editar os parametros padrao de cada modelo e permitir overrides independentes em cada perfil/tarefa.

Estrategia de dimensoes:

- usar a dimensao nativa do modelo como fonte principal de qualidade;
- quando o modelo suportar dimensoes reduzidas de forma nativa, permitir indice rapido em dimensao menor;
- usar dimensao reduzida para candidate generation quando houver ganho claro de velocidade e espaco;
- usar dimensao maior/nativa para reranking semantico quando o modelo suportar;
- registrar dimensao, modelo e estrategia em cada embedding gerado.

Ideia inicial: usar indices separados conforme a dimensao nativa ou validada de cada modelo. `Qwen/Qwen3-Embedding-0.6B` suporta Matryoshka ate 1024 dimensoes; `BAAI/bge-m3` produz vetores densos nativos de 1024 dimensoes. Ambos usam 1024 por padrao no catalogo local.

## Parametros, Perfis e Idioma de IA

Cada configuracao de modelo remoto ou local guarda parametros padrao editaveis. O vocabulario canonico inicial e:

- `contextWindow`;
- `temperature`;
- `maxTokens`;
- `reasoningLevel` (`off`, `minimal`, `low`, `medium`, `high`);
- `topP`;
- `dimensions` para embeddings;
- `seed`.

Adapters convertem esses nomes para o contrato concreto do provedor ou runtime. Parametros nao suportados por uma tarefa nao devem ser enviados por espalhamento direto ao endpoint.

Ao configurar uma tarefa para um perfil, o usuario pode sobrescrever os parametros daquele vinculo sem alterar os defaults do unico modelo do perfil ou outros perfis. A precedencia em execucao e:

```txt
defaults internos seguros
  -> defaults do modelo
  -> overrides do perfil/tarefa
```

Etapas generativas executadas por perfil usam `maxTokens: 16384` como default
interno. Se o modelo ou o vinculo perfil/tarefa configurar outro valor, o valor
configurado prevalece.

O roteamento ativo e configurado por tipo de tarefa: embedding, resumo, geracao de notas atomicas, reranking, geracao textual e saida estruturada podem escolher perfis diferentes. O perfil padrao antigo permanece apenas como fallback de compatibilidade enquanto uma rota explicita ainda nao existir.

Cada perfil escolhe tambem o idioma das respostas. O padrao `ui` acompanha o idioma atual da interface; tambem e possivel fixar `en`, `pt-BR`, `it`, `fr` ou `es`. A instrucao de idioma vale somente para tarefas generativas e deve preservar schemas/chaves de saida estruturada; embeddings permanecem independentes de idioma.

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

O pipeline usara um `ConversionRouter` para escolher o conversor por MIME/magic bytes, extensao, politica de privacidade e perfil de qualidade.

Docling sera o motor primario para PDF, DOCX, PPTX, XLSX, EPUB, formatos OpenDocument e imagens que exijam parsing ou OCR. Ele sera executado em sidecar CPython local, iniciado e supervisionado pelo main process ou pelo worker de conversao. O sidecar deve usar runtime, wheels e modelos proprios por plataforma, comunicar-se por stdin/stdout JSON validado por Zod, operar offline por padrao e nunca depender do Python do sistema ou executar `pip install` em runtime.

TXT, Markdown, CSV, JSON, XML, RSS, Atom, Jupyter Notebook e HTML local simples devem usar conversores TypeScript nativos em `@app/conversion`. Defuddle continua sendo o caminho primario para paginas web, inclusive quando HTML tambem for suportado como arquivo local.

Uso esperado:

```txt
arquivo local, anexo ou buffer importado
  -> salvar asset bruto
  -> detectar MIME/magic bytes, extensao e tamanho
  -> ConversionRouter
     -> conversor TypeScript para formato textual simples
     -> sidecar Docling para documento complexo
  -> normalizar Markdown
  -> preservar blocos, assets e proveniencia estruturada
  -> criar SourceItem + Document + DocumentAsset
  -> gerar resumo, chunks, embeddings e notas atomicas
```

Formatos iniciais dos conversores TypeScript:

- TXT e Markdown;
- CSV;
- JSON;
- XML, RSS e Atom;
- Jupyter Notebook `.ipynb`;
- HTML local simples.

Formatos iniciais do Docling:

- PDF textual;
- PDF multicoluna, com tabelas e misto;
- PDF escaneado com OCR basico automatico somente nas paginas necessarias;
- Word `.docx`;
- Excel `.xlsx`;
- PowerPoint `.pptx`;
- EPUB;
- ODT, ODS e ODP;
- imagens quando OCR ou parsing visual basico estiver habilitado.

ZIP e outros containers devem ser extraidos com limites de tamanho, profundidade e quantidade; cada entrada deve voltar ao `ConversionRouter`.

O resultado comum de conversao deve conter:

```txt
markdown
blocks[]
  id
  type
  text
  page
  bounding_box
  source_charspan
  markdown_start
  markdown_end
  confidence
assets[]
engine
engine_version
profile_and_options
warnings
quality
raw_structured_result
```

O `DoclingDocument` JSON deve ser preservado como `DocumentAsset` derivado quando contiver layout ou proveniencia util. O dialeto normalizado aceita GFM, HTML inline para tabelas com merges/multiplos headers, LaTeX para formulas e referencias relativas para assets.

Perfis iniciais:

- `standard`: parsing de layout, ordem de leitura e tabelas;
- `ocr`: acionado automaticamente somente em paginas sem texto pesquisavel ou com texto inutilizavel.

Casos de excecao:

- OCR customizado, VLM avancado, manuscritos e resultados de baixa confianca devem gerar `requires_ocr` ou warning recuperavel, sem sucesso silencioso;
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
conversion_profile_and_options
conversion_started_at
conversion_finished_at
conversion_warnings
conversion_quality
extracted_metadata
```

O suporte do Docling a HTML, audio ou video nao substitui as decisoes ja tomadas: Defuddle continua sendo o caminho primario para paginas web, `youtubei.js` continua sendo o caminho inicial para YouTube e audio/video continuam em pipelines proprios.

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
- monitorar arquivos Markdown gerenciados pela aplicacao dentro do vault;
- enviar eventos de criacao, alteracao, renomeacao, movimentacao e remocao;
- preservar o vinculo entre arquivo Markdown, registro no banco e fonte geradora;
- expor comandos e superficies de UI dentro do Obsidian;
- usar contratos de `@app/integration-contracts`;
- manter isolamento em relacao ao banco e aos servicos internos do desktop;
- preservar limites e convencoes do ambiente de plugins do Obsidian.

O plugin podera evoluir para fluxos mais ricos, como inserir backlinks, criar notas derivadas, consultar entidades relacionadas ou anexar evidencias vindas da base de conhecimento. Esses fluxos devem ser tratados como comandos/eventos versionados no contrato de integracao.

## Vault Obsidian e Projecao Markdown

Cada conteudo convertido para Markdown deve poder gerar um arquivo `.md` no vault Obsidian configurado. Isso inclui fontes inseridas manualmente, paginas web, arquivos convertidos, transcricoes, notas atomicas, MOCs, Wikis e outras notas dinamicas futuras.

O banco continua sendo a fonte canonica da aplicacao. O vault Obsidian deve ser tratado como uma projecao sincronizada e editavel, com identidade estavel em frontmatter.

Configuracoes relacionadas:

- caminho absoluto do vault Obsidian;
- pasta raiz dentro do vault para os arquivos gerenciados pela aplicacao, inicialmente `Memora`;
- habilitar ou pausar sincronizacao Obsidian;
- politica de delecao entre Obsidian e banco;
- politica de conflito quando banco e arquivo mudarem ao mesmo tempo.

Frontmatter minimo:

```yaml
---
memora_id: "an_01JABCDEF123456789"
memora_type: "atomic_note"
memora_source_id: "src_01JBOOKCHAPTER123"
memora_document_id: "doc_01JXYZ123"
memora_managed: true
memora_sync_version: 7
memora_content_hash: "sha256:..."
---
```

O `memora_id` e a identidade estavel. O caminho e o nome do arquivo sao editaveis e devem ser reconciliados pelo plugin.

Estrutura inicial sugerida no vault:

```txt
Memora/
  Sources/
    Web/
      2026/
        05/
          domain.com/
            titulo-do-artigo.md
    Books/
      nome-do-livro/
        book.md
        Chapters/
          capitulo-01-introducao.md
    Journals/
      nome-do-periodico/
        2026/
          vol-12-issue-03/
            titulo-do-artigo.md
    Magazines/
      nome-da-revista/
        2026-05/
          titulo-do-artigo.md
    Videos/
      2026/
        05/
          titulo-do-video.md
  Atomic/
    2026/
      05/
        10/
          ideia-atomica.md
  MOCs/
  Wikis/
  Entities/
```

Regra de nomes:

- o nome padrao deve ser humano e legivel, derivado de titulo/slug;
- nao adicionar id curto por padrao;
- quando houver colisao no mesmo diretorio, adicionar sufixo curto;
- a primeira estrategia de sufixo pode usar data curta, por exemplo `titulo--20260510.md`;
- se a colisao persistir no mesmo dia, usar contador ou fallback deterministico, por exemplo `titulo--20260510-02.md` ou `titulo--01JABC.md`;
- a identidade real nunca deve depender do nome do arquivo, apenas do frontmatter e do banco.

Sincronizacao:

- o banco deve armazenar last modified (mtime) e hash de cada arquivo gerenciado; ao abrir a aplicacao ou reconectar o plugin, executar scan de reconciliacao procurando arquivos criados, modificados, movidos ou removidos enquanto o desktop esteve fechado;
- arquivo criado no banco deve criar ou atualizar `.md` no vault;
- arquivo alterado no Obsidian deve enviar evento ao desktop e atualizar o banco;
- rename/move deve atualizar o path relativo no banco, sem mudar `memora_id`;
- remocao no Obsidian deve remover o registro correspondente no banco conforme politica configurada;
- remocao no banco deve remover ou mover para lixeira o arquivo gerenciado no Obsidian conforme politica configurada;
- para seguranca e auditoria, a implementacao pode registrar tombstone antes de remover fisicamente dados ou arquivos;
- conflitos devem ser explicitos, nunca resolvidos por sobrescrita silenciosa.

Notas atomicas geradas devem viver fora da pasta da fonte que as originou. A relacao com a fonte deve estar no banco e no frontmatter, permitindo que a nota atomica seja reorganizada futuramente por MOCs e Wikis sem perder proveniencia.

## Copias de Arquivos Subidos

A aplicacao pode permitir configurar uma pasta opcional para manter copias dos arquivos originais subidos pelo usuario. Essa pasta e diferente do vault Obsidian e serve para preservar originais para consulta futura.

Se a pasta nao for configurada, a aplicacao deve usar apenas seu armazenamento interno gerenciado. Se a pasta for configurada, cada asset copiado deve ter seu caminho relativo registrado no banco.

Estrutura recomendada:

```txt
UploadedFiles/
  sha256/
    ab/
      cd/
        abcdef1234567890.pdf
```

Regras:

- organizar por hash para evitar colisao e escalar para muitos arquivos;
- preservar `original_file_name` no banco, nao necessariamente no path;
- registrar `sha256`, MIME type, tamanho, storage base e path relativo;
- deduplicar arquivos identicos quando possivel;
- nao depender do nome original para identidade;
- se o usuario mover ou apagar arquivos nessa pasta manualmente, a aplicacao deve detectar inconsistencia e oferecer reparo, recopia ou desvinculo.

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

Ele deve conter apenas contratos, schemas, tipos de eventos e utilitarios seguros para ambientes externos. Nao deve importar Electron, `node-postgres`, Drizzle, Node APIs privilegiadas ou codigo de servicos internos.

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
- manter perfis de IA por tarefa e o perfil padrao ativo;
- negociar o modelo adequado para cada tarefa a partir de capabilities;
- definir adaptador local para `node-llama-cpp`;
- listar modelos disponiveis por provedor quando a API permitir;
- validar configuracoes de modelos;
- mapear capacidades de modelos por tarefa;
- registrar metadados de execucao, como modelo, provedor, dimensoes, prompt version e parametros;
- suportar modelos locais baixaveis;
- padronizar erros de provedor para mensagens localizadas.

Provedores de processamento no MVP:

```txt
Google (Gemini)
Generic OpenAI-compatible endpoint
```

Fase seguinte:

```txt
OpenAI
Anthropic
OpenRouter
Local embedded node-llama-cpp runtime (interface preparada no MVP)
```

Provedores de embedding no MVP:

```txt
Google (Gemini)
Generic OpenAI-compatible endpoint
Local GGUF via node-llama-cpp
```

Modelos locais iniciais:

```txt
Qwen/Qwen3-Embedding-0.6B-GGUF
ggml-org/bge-m3-Q8_0-GGUF
```

## Pacote `@app/conversion`

O pacote `@app/conversion` deve concentrar interfaces, adaptadores e utilitarios de conversao para Markdown. Ele deve manter uma API comum para motores diferentes, permitindo que workers e servicos de aplicacao escolham o conversor correto sem acoplar o pipeline a uma biblioteca especifica.

Responsabilidades:

- definir contratos de conversao de entrada e saida;
- padronizar metadados de conversao, avisos e erros;
- rotear entradas por MIME/magic bytes, extensao, politica de privacidade e perfil de qualidade;
- encapsular conversores TypeScript nativos para formatos textuais simples;
- encapsular o protocolo do sidecar Docling para PDF e documentos complexos;
- encapsular Defuddle para paginas web e DOM renderizado;
- encapsular normalizadores para transcricoes obtidas via `youtubei.js`;
- aplicar pos-processamento de Markdown normalizado;
- preservar blocos, pagina, bounding box, charspan, offsets Markdown, assets e JSON estruturado quando disponiveis;
- registrar motor, versao, perfil, opcoes e qualidade estimada da conversao;
- expor erros recuperaveis e mensagens localizaveis via i18n.

`@app/conversion` nao deve acessar banco diretamente. Ele deve receber entradas ja autorizadas e retornar resultados estruturados para os servicos de aplicacao persistirem via `@app/db`.

O sidecar Docling e uma excecao isolada ao TypeScript-first: nenhuma regra de dominio ou aplicacao deve ser implementada em Python. Runtime, wheels e modelos devem ser versionados por plataforma, verificados por checksum e operados offline por padrao. O main process ou um worker controlado por ele e o unico responsavel por start, cancelamento, timeout, recuperacao de crash e shutdown.

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

No MVP, apenas 8 tipos serao implementados: `PersonalNote`, `DailyNote`, `WebArticle`, `Book`, `BookChapter`, `StandaloneArticle`, `Video` e `GenericDocument`. Os demais tipos abaixo permanecem documentados como direcao de produto e entram em fases seguintes.

Tipos de itens de acervo:

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

## Insercao Manual de Conteudo

A aplicacao deve permitir inserir conteudo manualmente por formulario, sem captura web e sem upload de arquivo. Esse fluxo sera usado quando o usuario digitar, colar ou transcrever conteudo diretamente.

Fluxo esperado:

```txt
Novo conteudo manual
  -> escolher tipo de SourceItem
  -> carregar campos especificos do tipo escolhido
  -> buscar fontes relacionadas existentes enquanto o usuario digita
  -> permitir selecionar fonte existente para evitar duplicacao
  -> preencher conteudo em Markdown ou texto simples
  -> validar metadados obrigatorios
  -> criar ou vincular SourceItem/BibliographicWork/BibliographicInstance
  -> normalizar Markdown
  -> seguir pipeline de resumo, chunks, entidades e notas atomicas
```

O formulario deve ser progressivo: apos o usuario escolher o tipo de conteudo, a interface deve pedir apenas os campos relevantes para aquele tipo.

No MVP, o formulario cobre apenas os 8 tipos da taxonomia inicial; tipos bibliograficos adicionais (revista, periodico, curso etc.) entram com seus formularios na fase seguinte.

Exemplos:

- `PersonalNote`: titulo opcional, data, tags e conteudo.
- `DailyNote`: data, titulo opcional e conteudo.
- `BookChapter`: livro relacionado, titulo do capitulo, autores quando houver, paginas e conteudo.
- `MagazineArticle`: revista/edicao relacionada, titulo, autores, paginas e conteudo.
- `JournalArticle`: periodico, volume/issue, titulo, autores, paginas, DOI quando houver e conteudo.
- `StandaloneArticle`: titulo, autores, paginas, data e conteudo.
- `Manual`: titulo, versao, produto/organizacao relacionada e conteudo.

Busca de fontes existentes:

- ao digitar o nome de livro, revista, periodico, autor, organizacao ou obra relacionada, a aplicacao deve sugerir itens existentes com nomes iguais ou parcialmente semelhantes;
- a busca deve considerar aliases, titulo canonico, subtitulo, ISBN, ISSN, DOI, URL e outros identificadores quando disponiveis;
- o usuario deve poder selecionar um item existente ou criar um novo quando a fonte ainda nao existir;
- a UI deve deixar claro quando o usuario esta vinculando a uma fonte existente versus criando uma nova;
- em caso de possivel duplicata, a aplicacao deve alertar e pedir confirmacao antes de criar novo item;
- as sugestoes devem usar busca textual inicialmente e podem evoluir para busca hibrida com embeddings e grafo.

Esse fluxo e especialmente importante para capitulos de livros, artigos de revistas e artigos de periodicos, pois esses itens normalmente dependem de uma fonte maior ja cadastrada.

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

Notas atomicas geradas automaticamente nascem com status `pending_review` e passam por uma fila de revisao humana antes de serem consideradas estabelecidas. O matching pode considerar notas pendentes, mas a UI deve distinguir claramente notas revisadas de notas pendentes.

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

- criar e configurar o cliente Postgres (`node-postgres`) e o pool de conexoes;
- declarar schemas Drizzle;
- manter migrations;
- manter seed/baseline versionado para inicializacao de banco Postgres
  totalmente vazio;
- manter `packages/db/seed/baseline.sql` e `packages/db/seed/manifest.json`
  sincronizados sempre que novas migrations forem criadas;
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
      obsidian-sync.ts
      storage-settings.ts
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
      obsidian-sync-repository.ts
      document-asset-repository.ts
      storage-settings-repository.ts
      job-repository.ts
      settings-repository.ts
    queries/
      full-text-search.ts
      vector-search.ts
      hybrid-search.ts
      atomic-note-matching.ts
      graph-traversal.ts
```

## Postgres Sidecar Embarcado

O banco local sera um PostgreSQL nativo completo, embarcado na aplicacao desktop como processo sidecar. A versao alvo de Postgres, `pgvector`, AGE e bibliotecas Node fica em `docs/stack-versions.md`. O artefato sidecar deve fornecer binarios de Postgres + `pgvector` por plataforma para aplicacoes Node/Electron. O Apache AGE `PG18/v1.7.0-rc0` sera compilado por plataforma contra PostgreSQL 18 e injetado no bundle de binarios apos validacao; o primeiro alvo e macOS.

Regras de ciclo de vida:

- o main process e o unico dono do sidecar: initdb no primeiro uso, spawn como processo filho, shutdown limpo ao encerrar o app;
- a janela pode abrir antes do banco ficar pronto, mas deve mostrar um estado de bootstrap e so liberar a shell quando o sidecar estiver pronto e o fluxo de baseline/migrations tiver rodado;
- data dir no `userData` da aplicacao, nunca dentro do bundle;
- conexao por loopback tentando `MEMORA_DATABASE_PORT` primeiro e fazendo
  fallback com warning para porta dinamica livre; senha gerada por instalacao
  (scram), guardada via Electron `safeStorage`; unix socket pode ser usado
  quando disponivel; nunca `trust` em TCP;
- detectar e tratar `postmaster.pid` obsoleto e processos orfaos apos crash;
- impedir duas instancias da aplicacao disputando o mesmo data dir;
- upgrade de major do Postgres e mudanca planejada, com estrategia explicita de migracao de dados (`pg_upgrade` ou dump/restore);
- binarios do Postgres e extensoes entram no fluxo de assinatura/notarizacao do empacotamento por plataforma;
- se o AGE nao estiver disponivel ou uma consulta falhar, o app continua sem o score de grafo; nao existe fallback de travessia por CTE relacional.

Com Postgres completo, multiplas conexoes sao suportadas: workers podem abrir conexoes proprias com o banco, respeitando limites de pool configurados.

## Banco de Dados

O PostgreSQL embarcado (sidecar) sera a fonte de verdade local da aplicacao desktop. O banco devera armazenar itens de acervo, documentos em Markdown, assets, chunks, embeddings, metadados bibliograficos, entidades, mencoes, relacoes, claims, questions, notas atomicas, relacoes entre notas atomicas, resumos, jobs, configuracoes, configuracoes nao sensiveis de IA, clientes externos autorizados e metadados.

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
  storage_base
  relative_path
  original_file_name
  sha256
  mime_type
  size_bytes
  role
  created_at

obsidian_sync_files
  id
  memora_id
  entity_type
  entity_id
  source_item_id
  document_id
  vault_relative_path
  frontmatter_hash
  content_hash
  file_mtime
  sync_version
  sync_status
  last_seen_at
  deleted_at
  created_at
  updated_at

storage_settings
  id
  obsidian_vault_path
  obsidian_root_folder
  obsidian_sync_enabled
  obsidian_delete_policy
  uploaded_files_path
  copy_uploaded_files_enabled
  created_at
  updated_at

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

ai_profile_sets
  id
  name
  description
  is_default
  privacy_mode
  provider_config_id
  local_model_id
  model_id
  runtime
  capabilities
  status
  created_at
  updated_at

ai_profile_tasks
  id
  profile_id
  task
  parameters
  fallback_policy
  status
  created_at
  updated_at

ai_task_profile_routes
  id
  task
  profile_id
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
  profile_id
  task_type
  provider
  model_id
  runtime
  capabilities_used
  input_hash
  output_hash
  input_tokens
  output_tokens
  cost_estimate
  duration_ms
  status
  error
  started_at
  finished_at

ingestion_runs
  id
  source_item_id
  status
  current_stage
  stages_checkpoint
  error
  started_at
  finished_at
  created_at
  updated_at

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

Os chunks sao sempre gerados a partir do documento fonte normalizado, nunca do resumo. O resumo e um artefato derivado para leitura e catalogacao; quando a fonte exceder o contexto do modelo, o resumo pode ser produzido por map-reduce sobre os chunks.

`markdown_content` em `documents` representa o conteudo textual normalizado usado pelo pipeline. Assets originais, capas, PDFs, imagens, transcricoes brutas e outros arquivos continuam preservados em `document_assets`.

`atomic_note_relations` e a tabela canonica de ligacoes entre notas atomicas. Essas relacoes podem ser descobertas por busca vetorial, grafo e reranking, mas devem ser persistidas em SQL para auditoria, consulta e evolucao do Zettelkasten.

`ai_provider_configs`, `ai_profile_sets`, `ai_profile_tasks`, `ai_task_profile_routes`, `embedding_model_configs`, `local_models`, `ai_model_capabilities` e `ai_task_runs` devem guardar configuracoes, perfis, referencias, capacidades e metadados de execucao. `ai_provider_configs.default_parameters` e `local_models.default_parameters` guardam defaults por modelo; `ai_profile_tasks.parameters` guarda apenas overrides do perfil/tarefa. Segredos reais, como API keys, devem ficar fora do banco em armazenamento seguro.

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

Essa regra deve ser orientada por capacidade real do modelo e benchmarks. `Qwen/Qwen3-Embedding-0.6B` suporta dimensoes flexiveis via Matryoshka Representation Learning; `BAAI/bge-m3` usa dimensao densa nativa de 1024.

Dimensoes diferentes nao devem ser misturadas no mesmo indice vetorial. Se o sistema mantiver embeddings de 256, 768 e 1024 dimensoes, a persistencia deve separar claramente modelo, dimensao, uso e indice correspondente. Na implementacao, usar tabelas separadas por dimensao — `embeddings_256`, `embeddings_768` e `embeddings_1024` — pois indices pgvector exigem dimensao fixa por coluna.

## Grafo

Apache AGE, compilado por plataforma e carregado no Postgres sidecar, sera usado para consultas e projecoes de grafo. Se o AGE nao estiver disponivel ou uma consulta falhar, a busca omite o score de grafo e continua com os demais sinais, sem executar uma travessia substituta por CTE relacional. As tabelas relacionais `entities`, `entity_mentions` e `relations` permanecem como fonte canonica, usando AGE como camada de consulta/projecao.

A extracao do grafo usa somente as notas atomicas nao rejeitadas da fonte, e nao
o documento completo. Os chunks permanecem como proveniencia herdada das notas.
O prompt usa aliases curtos (`c1`, `c2`, ...) no lugar de UUIDs; depois da
validacao, o backend resolve cada alias para o chunk id real. O processamento
mantem checkpoint e progresso por lote para que retries nao repitam lotes ja
validados.

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

A orquestracao deve ser uma maquina de estados persistida por importacao (`ingestion_runs`): cada execucao registra a etapa atual e checkpoints por etapa concluida, permitindo continuar do ponto em que parou apos erro, cancelamento ou reinicio da aplicacao, sem refazer etapas ja concluidas.

Capturas e importacoes repetidas devem ser deduplicadas por `original_uri` e `content_hash` antes de criar nova fonte, com politica explicita: atualizar, versionar ou ignorar, conforme configuracao.

Fluxo inicial:

```txt
Receber conteudo
  -> desktop, Chrome Extension ou Obsidian Plugin
  -> validar contrato de entrada
  -> quando for insercao manual, validar tipo escolhido e campos progressivos
  -> buscar e vincular fontes existentes quando aplicavel
  -> extrair pagina web com Defuddle quando a fonte for URL/pagina
  -> rotear arquivo local/anexo para conversor TypeScript ou sidecar Docling
  -> aplicar fluxo proprio para YouTube e videos web quando aplicavel
  -> classificar tipo de SourceItem
  -> extrair metadados de catalogacao
  -> salvar asset bruto
  -> copiar asset original para pasta configurada quando habilitado
  -> criar SourceItem
  -> converter conteudo para Markdown normalizado
  -> criar Document com Markdown normalizado
  -> projetar arquivo Markdown no vault Obsidian quando sincronizacao estiver habilitada
  -> vincular obra, instancia, volume, issue ou item relacionado quando aplicavel
  -> criar IngestionJob
  -> carregar o perfil roteado para cada tarefa e seu unico modelo
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
obsidian-sync.worker.ts
asset-storage.worker.ts
```

A fila inicial pode ser implementada no proprio Postgres, usando `SELECT ... FOR UPDATE SKIP LOCKED` para permitir multiplos consumidores concorrentes. Isso permite retomar trabalhos interrompidos quando a aplicacao for fechada e aberta novamente.

## Busca

A busca devera ser hibrida desde a fundacao e devera servir tanto a recuperacao de fontes quanto a descoberta de relacoes entre notas atomicas.

A busca textual usara configuracao `simple` combinada com `unaccent` e `pg_trgm`, evitando dependencia de dicionario por idioma no MVP. O idioma de cada documento continua registrado, permitindo evoluir para dicionarios especificos e stemming por idioma no futuro.

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
            ai-profiles/
            manual-ingestion/
            source-picker/
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
        docling.ts
        plain-text.ts
        csv.ts
        json.ts
        xml-feed.ts
        ipynb.ts
        local-html.ts
        youtube-transcript.ts
      conversion-router.ts
      sidecar-contracts.ts
      markdown-normalizer.ts
      metadata.ts
      types.ts

  db/
    src/
      client.ts
      schema/
      repositories/
        ai-config-repository.ts
        source-lookup-repository.ts
        duplicate-detection-repository.ts
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
- o plugin Obsidian pode monitorar arquivos e frontmatter no vault, mas nao deve acessar o banco local diretamente.
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

O projeto mantem um seed/baseline versionado para o caso especifico de banco
Postgres totalmente vazio. Nesse fluxo, o bootstrap aplica o baseline, registra
em `drizzle.__drizzle_migrations` as migrations cobertas pelo baseline e entao
executa migrations pendentes normalmente. Em bancos existentes, seja por ja
terem historico Drizzle ou dados da aplicacao, o seed/baseline nao deve ser
aplicado; o fluxo correto e executar apenas migrations pendentes.

O seed/baseline deve acompanhar as migrations. Quando uma migration estrutural
passar a estar coberta pelo baseline, atualize tambem o baseline e o registro de
migrations cobertas. O seed inicial pode conter apenas estrutura e extensoes
necessarias, sem dados de dominio.

Ao criar nova migration, a mesma mudanca deve atualizar
`packages/db/seed/baseline.sql`, atualizar `packages/db/seed/manifest.json` com
a lista `includedMigrations` na ordem de `packages/db/drizzle/meta/_journal.json`
e passar em `npm run db:seed:verify`.

Verificacao obrigatoria pos-migration:

- confirmar no banco real que a migration foi registrada em `drizzle.__drizzle_migrations`;
- confirmar a estrutura alterada em `information_schema` ou por consulta direta na tabela afetada;
- quando aplicavel, validar indices, constraints, colunas, tipos, extensoes e dados migrados;
- confirmar sincronizacao do seed/baseline com `npm run db:seed:verify`;
- quando houver seed/baseline, validar tanto banco totalmente vazio quanto banco
  existente para garantir que o seed nao e reaplicado indevidamente;
- registrar no resumo da tarefa quais consultas ou verificacoes foram usadas.

Essa regra vale especialmente para tabelas ligadas a `source_items`, `atomic_notes`, relacoes entre notas, entidades, relacoes, embeddings, configuracoes de IA, modelos locais, jobs, integration clients e qualquer schema compartilhado por workers ou clientes externos.

## Git e Entrega

O fluxo padrao e nao fazer o commit final automaticamente. Ao concluir uma tarefa, informar que esta pronta para o commit final e listar os arquivos alterados, verificacoes realizadas e eventuais pendencias.

## Principios de Produto

- A base de conhecimento deve ser local-first.
- O sistema deve diferenciar itens de acervo, entidades do grafo, obras abstratas, instancias bibliograficas e assets fisicos/digitais.
- A importacao deve produzir conhecimento navegavel, nao apenas arquivos indexados.
- Notas atomicas Zettelkasten devem representar ideias especificas, com proveniencia e conexoes justificaveis.
- Notas atomicas geradas automaticamente passam por revisao humana antes de serem consideradas estabelecidas.
- Chamadas remotas de IA devem ser transparentes em custo: cada execucao registra tokens e custo estimado, e importacoes em lote respeitam configuracao de confirmacao.
- Relacoes entre notas atomicas devem ser persistidas no SQL e manter os sinais usados na decisao.
- Fontes longas devem receber resumo gerado durante a importacao.
- Modelos e provedores de IA devem ser configuraveis por perfil, com selecao do perfil por tarefa.
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

- performance do Postgres embarcado com centenas de milhares e milhoes de chunks;
- performance de `pgvector` dentro do ambiente desktop;
- build reproduzivel do Apache AGE por plataforma, comecando por macOS; Windows e Linux pendentes;
- comportamento de Apache AGE no sidecar para consultas reais;
- ciclo de vida do sidecar: initdb no primeiro uso, shutdown limpo, crash, processos orfaos e `postmaster.pid` obsoleto;
- estrategia de upgrade de major do Postgres com dados existentes;
- assinatura e notarizacao dos binarios do Postgres e extensoes no empacotamento por plataforma;
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
- confiabilidade do monitoramento de arquivos no vault Obsidian;
- politica de delecao entre banco e Obsidian, incluindo tombstones e recuperacao;
- escalabilidade da estrutura de pastas do vault para milhares de arquivos Markdown;
- escalabilidade da pasta opcional de arquivos subidos organizada por hash;
- estrategia de versionamento dos contratos de integracao;
- empacotamento e distribuicao dos tres elementos;
- taxonomia inicial de itens de acervo e entidades;
- qualidade da extracao automatica de metadados bibliograficos;
- reconciliacao de pessoas, organizacoes, obras e publicacoes duplicadas;
- qualidade da conversao de diferentes fontes para Markdown normalizado;
- qualidade do Defuddle em diferentes tipos de pagina web;
- qualidade do Docling para PDF textual, multicoluna, tabelas, scans, DOCX, XLSX, PPTX, EPUB e formatos OpenDocument;
- qualidade dos conversores TypeScript para TXT, Markdown, CSV, JSON, XML, feeds, IPYNB e HTML local;
- tamanho, cold start, memoria, compatibilidade e assinatura do runtime CPython, wheels e modelos Docling por plataforma;
- preservacao de pagina, bounding box, charspan, ordem de leitura e offsets Markdown no resultado estruturado;
- estrategia de fallback quando Defuddle falhar ou extrair conteudo insuficiente;
- estrategia de warning, `requires_ocr` e retry quando Docling falhar, produzir resultado fraco ou encontrar caso fora do OCR basico;
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
- UX de perfis de IA por tarefa, clonagem de perfis e troca do perfil padrao ativo;
- validacao de capabilities nos perfis de IA antes de executar jobs;
- qualidade das sugestoes de fontes existentes no formulario de insercao manual;
- regras de deduplicacao para livros, revistas, periodicos, autores, obras e publicacoes;
- estrategia futura para MOCs e wikis como camada de navegacao humana.

## MVP Tecnico Sugerido

O primeiro MVP tecnico deve provar a espinha dorsal do sistema. Ideias como AGE profundo, OCR customizado/avancado alem do OCR basico automatico do Docling, multimodal local, MOCs automaticos, wikis elaboradas e transcricao robusta permanecem na direcao do produto, mas ficam fora da implementacao inicial.

1. Aplicacao Electron com React via `electron-vite`.
2. Renderer com React 19, Tailwind CSS 4 e `shadcn/ui`, nas versoes de `docs/stack-versions.md`.
3. IPC tipado com Zod entre renderer, preload e main.
4. Estrutura isolada para `apps/chrome-extension`.
5. Estrutura isolada para `apps/obsidian-plugin`.
6. `@app/integration-contracts` com contratos iniciais.
7. Integration Gateway minimo no desktop.
8. Postgres sidecar inicializado e gerenciado pelo main process (initdb, start, spinner de bootstrap, migrations no boot, shutdown, recuperacao).
9. Drizzle com schema, migrations basicas e fluxo `npm run db:generate`.
10. Verificacao pos-migration no banco real.
11. Area de configuracoes inicial.
12. Configuracao de vault Obsidian e pasta raiz gerenciada.
13. Configuracao opcional de pasta para copias de arquivos subidos.
14. Cadastro seguro de provedor de IA e API key.
15. Listagem dinamica de modelos quando suportada pelo provedor.
16. Perfis de IA com um unico modelo e roteamento explicito de um perfil ativo para cada tipo de tarefa.
17. Selecao de um modelo de processamento remoto ou local por perfil.
18. Selecao do perfil de embedding remoto ou local no roteamento por tarefa.
18.1. Parametros padrao por modelo e overrides independentes por perfil/tarefa.
18.2. Idioma de resposta por perfil, herdando o idioma da interface por padrao.
19. `AiModelAdapter` e registry de modelos com capabilities.
20. Negociacao de modelo por tarefa a partir de capabilities.
21. Preparacao da interface para runtime local com `node-llama-cpp`, sem exigir execucao multimodal local no MVP.
22. Registro de modelos locais em `local_models` quando configurados.
23. Taxonomia inicial reduzida de `SourceItem` (8 tipos) e `GraphEntity`.
24. Insercao manual com escolha de tipo e formulario progressivo.
25. Busca de fontes existentes para evitar duplicacao na insercao manual.
26. Importacao de documento textual simples.
27. Captura real pela extensao Chrome de paginas web, selecoes e metadados.
28. Captura real pela extensao Chrome de paginas de YouTube, com URL, metadados e transcricao quando disponivel.
29. Fluxos bidirecionais essenciais com o plugin Obsidian.
30. Criacao de item de acervo com metadados basicos.
31. Extracao de pagina web com Defuddle.
32. Importacao de arquivo local via `ConversionRouter`, com TypeScript para formatos simples e Docling para documentos complexos.
33. Conversao para Markdown normalizado.
34. Projecao inicial de Markdown no vault Obsidian.
35. Sincronizacao Obsidian <-> banco para criacao, edicao, rename/move e remocao de arquivos gerenciados.
36. Fluxo inicial de YouTube/video web com `youtubei.js` para metadados e transcricao quando disponivel, sem transcricao robusta no MVP.
37. Geracao de resumo para fonte longa.
38. Chunking com `SourceSpan`.
39. Busca textual.
40. Geracao de embeddings para chunks e notas atomicas.
41. Busca vetorial via `pgvector`.
42. Geracao inicial de notas atomicas Zettelkasten.
43. Relacao das notas atomicas com fonte, chunks e entidades.
44. Matching inicial entre notas atomicas usando busca hibrida.
45. Persistencia de relacoes entre notas atomicas no SQL.
46. Busca hibrida com resultados rastreaveis.
47. Jobs persistidos e executados em `worker_threads`.
48. i18n funcional em `en` e `pt-BR`, com estrutura pronta para `it`, `fr` e `es`.
49. Testes de regressao automatizados para contratos, dominio e fluxos criticos.

Escopo explicitamente fora do MVP inicial:

- AGE profundo e travessias complexas de grafo;
- grafo visual elaborado;
- OCR customizado/avancado alem do OCR basico automatico do Docling;
- multimodal local em producao;
- transcricao robusta de audio/video;
- MOCs automaticos;
- wikis elaboradas;
- extracao avancada de entidades e relacoes;
- automacoes;
- features avancadas da extensao alem da captura de paginas web e YouTube;
- features avancadas do plugin Obsidian alem da sincronizacao bidirecional essencial.

Depois desse MVP, o projeto pode evoluir para esses itens de forma incremental, sem perder as decisoes arquiteturais ja documentadas.

## Decisao Arquitetural Atual

A direcao atual do projeto e:

```txt
Postgres embarcado (sidecar) + Drizzle
  -> fonte de verdade local

Electron Desktop
  -> nucleo operacional da plataforma

React 19 + Tailwind CSS 4 + shadcn/ui
  -> stack de frontend, conforme docs/stack-versions.md

Area de Configuracoes
  -> provedores, modelos, embeddings, integracoes e preferencias

Google (Gemini) / Generic OpenAI-compatible
  -> provedores de IA do MVP; OpenAI, Anthropic, OpenRouter e local na fase seguinte

node-llama-cpp
  -> runtime local embutido para modelos GGUF no Electron

Embeddings remotos e locais
  -> OpenAI, Google, Qwen3-Embedding-0.6B e BGE-M3

Defuddle
  -> extracao primaria de paginas web para Markdown limpo

Docling em sidecar CPython local
  -> conversao primaria de PDF e documentos complexos para Markdown e JSON estruturado

Conversores TypeScript nativos
  -> conversao primaria de formatos textuais simples para Markdown

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
  -> consultas e projecoes de grafo (build por plataforma; macOS primeiro)

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
