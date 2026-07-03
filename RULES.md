# Memora Eterna - Regras de Implementacao

Este arquivo deve ser seguido por qualquer agente ou subagente que implemente codigo neste projeto.

Ele complementa:

- `docs/initial.md`;
- `docs/mvp-implementation-plan.md`.

Se houver conflito entre este arquivo e uma etapa de algum comand dado ao agente ou etapa de implementação, pare e registre a divergencia antes de implementar.

## Principios Gerais

- O projeto e local-first, TypeScript-first e orientado por contratos.
- Implemente uma etapa por vez, conforme `docs/mvp-implementation-plan.md`.
- Nao implemente escopo futuro dentro do MVP sem pedido explicito.
- Taxonomia de `SourceItem` no MVP: `PersonalNote`, `DailyNote`, `WebArticle`, `Book`, `BookChapter`, `StandaloneArticle`, `Video`, `GenericDocument`; os demais tipos documentados ficam para fase seguinte.
- Preserve as ideias documentadas, mesmo quando estiverem fora da etapa atual.
- Evite refactors amplos que nao sejam necessarios para a etapa.
- Nao reverta alteracoes do usuario ou de outros agentes sem pedido explicito.
- Nao faca commit final automaticamente.
- Ao concluir uma etapa, informe arquivos alterados, testes executados, migrations aplicadas e pendencias.

## Stack Obrigatoria

- Desktop: Electron com `electron-vite`.
- Renderer: React 19.
- CSS/UI: Tailwind CSS 4 e `shadcn/ui`.
- Icones: preferir `lucide-react`.
- Backend local: Node.js no main process do Electron.
- Banco: PostgreSQL nativo embarcado como sidecar da aplicacao, com base em `postgres-vector-embedded` (binarios por plataforma com `pgvector` incluido).
- ORM/migrations: Drizzle ORM sobre `node-postgres`.
- Vetores: `pgvector`, incluido nos binarios do sidecar.
- Grafo: Apache AGE, compilado por plataforma e injetado no bundle do sidecar; inicialmente apenas macOS, e apenas como camada simples de projecao/consulta.
- Contratos: Zod.
- Workers: `worker_threads`.
- Web extraction: Defuddle.
- Arquivos para Markdown: `markitdown-ts`.
- YouTube: `youtubei.js`.
- Runtime local GGUF: `node-llama-cpp`, apenas no main process ou em workers controlados pelo main process.

## Fronteiras de Arquitetura

- Renderer nunca acessa banco, filesystem privilegiado, segredos, `node-llama-cpp` ou APIs nativas diretamente.
- Renderer fala com o backend local apenas via preload seguro e IPC validado por Zod.
- Main process concentra acesso a banco, filesystem, secrets, runtime local, workers e Integration Gateway.
- Extensao Chrome e plugin Obsidian nunca acessam o banco local diretamente.
- Extensao Chrome e plugin Obsidian se comunicam com desktop apenas por contratos versionados em `@app/integration-contracts`.
- Transporte do Integration Gateway: servidor HTTP local em loopback no main process, com WebSocket para eventos; clientes externos autorizados por token de pareamento. Native Messaging nao sera usado.
- `@app/db` nao pode ser importado pela extensao Chrome nem pelo plugin Obsidian.
- `@app/ai` nao deve ser importado por clientes externos no fluxo padrao.
- `@app/conversion` nao deve ser importado por clientes externos quando incluir adaptadores dependentes de Node ou filesystem.
- Codigo do main process do Electron nao deve ser importado pela extensao Chrome nem pelo plugin Obsidian.

Fluxo padrao:

```txt
Renderer
  -> Preload API
  -> IPC
  -> Main handler
  -> Zod parse
  -> Application service
  -> Repository / Worker / Filesystem
  -> PostgreSQL (sidecar)
```

## Postgres Sidecar

- O main process e o unico responsavel pelo ciclo de vida do sidecar: initdb no primeiro uso, start, shutdown limpo e recuperacao apos crash.
- Data dir fica no diretorio de dados do usuario da aplicacao (`userData`), nunca dentro do bundle.
- Conexao por loopback com porta dinamica e senha gerada por instalacao, ou unix socket quando disponivel.
- A senha local do banco deve ser guardada via armazenamento seguro do SO (Electron `safeStorage`), nunca em texto puro.
- Detectar e tratar `postmaster.pid` obsoleto e processos orfaos ao iniciar.
- Nao usar `trust` em TCP.
- Upgrade de major do Postgres e mudanca planejada com migracao de dados explicita; nao trocar o major sem plano.
- Workers podem abrir conexoes proprias com o banco; o pool deve ter limites configurados.
- AGE compilado inicialmente apenas para macOS; em plataformas sem AGE, consultas de grafo devem degradar para CTEs recursivas sobre as tabelas relacionais, nunca quebrar o app.

## Monorepo e Pacotes

Estrutura esperada:

- `apps/desktop`
- `apps/chrome-extension`
- `apps/obsidian-plugin`
- `packages/domain`
- `packages/integration-contracts`
- `packages/i18n`
- `packages/db`
- `packages/ai`
- `packages/conversion`

Regras:

- `@app/domain` deve conter tipos canonicos e schemas Zod sem dependencias pesadas.
- `@app/integration-contracts` deve conter apenas contratos externos, eventos, erros e schemas seguros.
- `@app/db` deve conter schema, migrations, repositorios e queries.
- `@app/ai` deve conter adaptadores, registry, capabilities, perfis e execucao de tarefas de IA.
- `@app/conversion` deve conter adaptadores de conversao e normalizacao de Markdown.
- `@app/i18n` deve conter locales, helpers e tipos compartilhados.

## i18n

- Nunca escreva textos de produto diretamente no codigo.
- Todo texto visivel ao usuario deve passar por i18n:
  - labels;
  - botoes;
  - menus;
  - placeholders;
  - tooltips;
  - mensagens de erro;
  - mensagens de sucesso;
  - status de jobs;
  - comandos;
  - estados vazios;
  - dialogs;
  - notificacoes.
- Idioma padrao: `en`.
- Idiomas iniciais: `en`, `pt-BR`, `it`, `fr`, `es`.
- Mensagens do backend que aparecem na UI tambem devem usar i18n.
- Strings tecnicas podem ficar no codigo quando forem ids, enums, nomes de tabelas, rotas internas, event names ou constantes de protocolo.

## UX e Frontend

- Construa a experiencia real, nao landing pages.
- Use componentes `shadcn/ui` e Tailwind CSS 4.
- Use icons em botoes de ferramentas quando fizer sentido.
- Use controles adequados:
  - toggles/checkboxes para booleanos;
  - selects/menus para opcoes;
  - tabs para views;
  - inputs/sliders/steppers para numeros;
  - tooltips para icones nao obvios.
- Nao coloque texto de produto hardcoded dentro de componentes.
- Evite UI dominada por uma unica familia de cor.
- Garanta que texto nao sobreponha outros elementos.
- Garanta dimensoes estaveis para toolbars, listas, grids, boards, botoes e tiles.
- Prefira telas densas, claras e utilitarias. Este e um app de conhecimento, nao uma pagina de marketing.
- Teste componentes importantes em estados vazios, carregando, erro e sucesso.

## Banco, Drizzle e Migrations

- Toda mudanca de schema Drizzle exige nova migration via:

```bash
npm run db:generate
```

- Apos gerar migration, aplique pelo fluxo padrao do projeto.
- Nao considere a task concluida apenas porque `db:migrate` terminou sem erro.
- Verifique explicitamente no banco real:
  - historico em `drizzle.__drizzle_migrations`;
  - estrutura alterada em `information_schema` ou consulta direta na tabela afetada;
  - indices, constraints, tipos e extensoes quando aplicavel.
- Inclua no resumo final quais verificacoes foram feitas.
- Use repositorios do `@app/db`; nao espalhe SQL ad hoc pela UI ou services.
- Dimensoes de embeddings diferentes devem ficar em tabelas/indices separados; indices pgvector exigem dimensao fixa por coluna.
- Busca textual usa configuracao `simple` com `unaccent` e `pg_trgm`; o idioma do documento deve ser registrado para evolucao futura.
- AGE nao e fonte canonica no MVP. Tabelas relacionais continuam canonicas.

## Dados Canonicos e Identidade

- Identidade canonica fica no banco.
- Paths e nomes de arquivos nao sao identidade.
- Use ids estaveis para:
  - source items;
  - documents;
  - assets;
  - chunks;
  - source spans;
  - atomic notes;
  - jobs;
  - sync files.
- Evite depender de titulo, slug ou path para reconciliacao.
- Preserve proveniencia de todo conteudo derivado.

## Obsidian

- O vault Obsidian e uma projecao sincronizada e editavel.
- O banco continua sendo a fonte canonica da aplicacao.
- Cada `.md` gerenciado deve ter frontmatter minimo com:
  - `memora_id`;
  - `memora_type`;
  - `memora_source_id` quando aplicavel;
  - `memora_document_id` quando aplicavel;
  - `memora_managed`;
  - `memora_sync_version`;
  - `memora_content_hash`.
- O plugin Obsidian pode monitorar arquivos e frontmatter, mas nao pode acessar o banco local diretamente.
- O banco deve armazenar last modified (mtime) e hash de cada arquivo gerenciado; ao abrir a aplicacao ou reconectar o plugin, executar scan de reconciliacao procurando arquivos criados, modificados, movidos ou removidos enquanto o desktop esteve fechado.
- Rename/move atualiza path relativo no banco sem mudar `memora_id`.
- Delete deve seguir politica configurada.
- Preferir tombstone antes de remocao fisica quando houver risco de perda.
- Conflitos devem ser explicitos. Nunca sobrescreva silenciosamente.
- Nome de arquivo deve ser humano e sem id por padrao.
- Em colisao no mesmo diretorio, usar sufixo curto:
  - primeira opcao: data curta, por exemplo `titulo--20260510.md`;
  - se persistir: contador, por exemplo `titulo--20260510-02.md`;
  - fallback: id curto, por exemplo `titulo--01JABC.md`.

## Arquivos Subidos e Assets

- Pasta de copias de arquivos subidos e opcional.
- Se configurada, salve copias por hash, nao por nome original.
- Estrutura recomendada:

```txt
UploadedFiles/
  sha256/
    ab/
      cd/
        abcdef1234567890.pdf
```

- Registrar no banco:
  - `original_file_name`;
  - `sha256`;
  - `mime_type`;
  - `size_bytes`;
  - `storage_base`;
  - `relative_path`;
  - `role`.
- Deduplicar arquivos identicos quando possivel.
- Rejeitar path traversal.
- Se arquivo externo sumir, detectar inconsistencia e oferecer reparo, recopia ou desvinculo.

## IA, Modelos e Capabilities

- A aplicacao deve chamar IA por `AiModelAdapter`, nao por SDK especifico espalhado pelo codigo.
- Provedores de IA no MVP: Generic OpenAI-compatible e Google (Gemini). OpenAI, Anthropic e OpenRouter entram em fase seguinte como novos adaptadores.
- Cada adaptador deve encapsular carregamento, execucao, cancelamento, progresso, streaming e erros.
- Cada modelo deve declarar capabilities.
- O pipeline escolhe modelo por tarefa via registry e perfil ativo.
- Perfis de IA agrupam escolhas por tarefa.
- Apenas um perfil deve estar ativo como padrao por vez.
- Cada artefato gerado deve registrar:
  - perfil;
  - tarefa;
  - modelo;
  - provedor;
  - runtime;
  - parametros;
  - versao de prompt quando aplicavel.
- Registrar tokens de entrada/saida, duracao e custo estimado em `ai_task_runs`.
- Notas atomicas geradas automaticamente nascem com status `pending_review` e passam por fila de revisao.
- Credenciais nunca ficam em texto puro no banco local.
- Segredos devem usar Electron `safeStorage` (armazenamento seguro do SO; no Linux depende de keyring disponivel).
- Logs nunca devem incluir chaves, tokens ou payloads sensiveis.

Capabilities iniciais incluem:

- `text-generation`
- `structured-output`
- `json-schema-output`
- `summarization`
- `entity-extraction`
- `claim-extraction`
- `atomic-note-generation`
- `embedding`
- `reranking`
- `image-understanding`
- `document-ocr`
- `audio-transcription`
- `video-understanding`
- `streaming`
- `cancellation`
- `batching`
- `offline`
- `local-files`
- `requires-api-key`
- `requires-network`
- `supports-progress-events`

## `node-llama-cpp`

- Deve rodar apenas em workers controlados pelo main process.
- Nunca importar `node-llama-cpp` no renderer.
- Nunca importar `node-llama-cpp` na extensao Chrome ou plugin Obsidian.
- O MVP prepara a interface local GGUF, mas nao exige multimodal local em producao.
- Trate multimodal local como validacao futura, salvo pedido explicito.

## Conversion Pipeline

- Paginas web: Defuddle como caminho primario.
- Arquivos locais/anexos: `markitdown-ts` como caminho primario.
- YouTube: `youtubei.js` para metadados e transcricao quando disponivel.
- Todo conteudo inserido deve virar Markdown normalizado.
- Preservar assets originais quando aplicavel.
- Registrar:
  - engine;
  - engine version;
  - warnings;
  - hashes;
  - metadados extraidos.
- PDF escaneado, imagem sem texto, audio e video complexo nao devem bloquear o MVP. Registrar como pendencia/processamento futuro quando necessario.

## Jobs e Workers

- Processamento pesado deve rodar em `worker_threads`.
- Jobs devem ser persistidos no banco.
- A ingestao deve ser orquestrada como maquina de estados persistida (`ingestion_runs`), com etapas e checkpoints; uma execucao interrompida por erro, cancelamento ou reinicio deve poder continuar da etapa em que parou.
- Jobs devem suportar:
  - status;
  - progresso;
  - erro;
  - cancelamento quando possivel;
  - retry simples quando fizer sentido.
- UI deve acompanhar jobs sem bloquear.
- Workers nao devem acessar UI.
- Payloads de workers devem ser validados por Zod quando cruzarem fronteiras.

## Extensao Chrome

- Deve ser app isolado em `apps/chrome-extension`.
- MVP deve capturar paginas web reais, selecoes e metadados.
- MVP deve capturar paginas YouTube reais com URL, metadados e transcricao quando disponivel.
- Usar contratos de `@app/integration-contracts`.
- Nao acessar banco, repositorios ou codigo do main process.
- Defuddle pode rodar na pagina quando apropriado, mas resultado deve entrar pelo Integration Gateway.
- UI da extensao tambem segue i18n.

## Plugin Obsidian

- Deve ser app isolado em `apps/obsidian-plugin`.
- MVP deve implementar sync bidirecional essencial:
  - create;
  - update;
  - rename/move;
  - delete.
- Deve monitorar frontmatter de arquivos gerenciados.
- Deve comunicar eventos ao desktop por contrato versionado.
- Nao deve acessar o banco local diretamente.
- Deve respeitar convencoes visuais e de lifecycle do Obsidian.

## Testes

- Criar testes de regressao sempre que pertinente.
- Preferir testes de:
  - dominio;
  - contratos Zod;
  - repositorios;
  - services;
  - workers;
  - adapters;
  - composicao de componentes;
  - fluxos sem GUI manual.
- Testes baseados em GUI so quando a natureza do problema exigir.
- Para extensao e plugin, testar contratos e adaptadores com mocks quando possivel.
- Para migrations, sempre testar aplicacao e verificacao real no banco.

## Seguranca e Privacidade

- Nao logar segredos.
- Nao armazenar API keys em texto puro no banco.
- Validar todos os payloads externos.
- Integration Gateway deve autenticar/autorizar clientes.
- Rejeitar paths inseguros.
- Respeitar politicas de privacidade local/remoto do perfil ativo.
- Nao enviar conteudo a provedor remoto se o perfil/tarefa exigir offline.
- Chamadas remotas de IA devem ser transparentes em custo: registrar tokens/custo por execucao e respeitar configuracao de confirmacao para importacoes em lote.

## Entrega de Cada Etapa

Ao terminar uma etapa, informe:

- arquivos criados/alterados;
- comandos executados;
- testes executados;
- migrations geradas;
- verificacao pos-migration feita;
- pendencias;
- se esta pronto para commit.

Nao faca commit automaticamente.

