# Plano de Reestruturacao da Ingestao de Fontes

Status: plano aprovado em 2026-07-15, sem implementacao iniciada.

Este plano descreve a reestruturacao do fluxo de insercao de fontes (manual e
por arquivo) para torna-lo mais preciso em metadados, mais automatizado e mais
simples de operar. Ele complementa `docs/initial.md`,
`docs/mvp-implementation-plan.md` e
`docs/hierarchical-import-and-selective-ingestion-plan.md`; o estado
implementado atual esta registrado em `MAPA.md`.

Decisoes ja tomadas com o usuario:

- provedores de enriquecimento: Open Library (primario para livros),
  Google Books (fallback de busca) e Crossref (DOI para papers e artigos);
- disparo do enriquecimento: automatico ao detectar ISBN/DOI/titulo, com
  opt-out global em Settings;
- autores/criadores: coluna JSONB estruturada validada por Zod, sem tabela
  normalizada de pessoas nesta fase.

## 1. Resultado esperado

Ao final desta reestruturacao, o usuario podera:

- escolher o tipo de fonte em um wizard com cards explicativos e busca, em vez
  de um select plano com 11 opcoes;
- registrar metadados completos por tipo (autores, edicao, editora, idioma,
  ISBN, capa, DOI, veiculo, canal, etc.), com formulario adequado a cada tipo;
- importar um livro por arquivo e ter titulo, autores, idioma, ISBN e capa
  extraidos do proprio arquivo (EPUB OPF, PDF Info/XMP, heuristicas de
  primeiras paginas) e reconciliados com APIs abertas gratuitas;
- ao digitar ISBN/DOI/titulo, ver uma lista de candidatos (nome, autor,
  edicao, ano, capa) vinda de Open Library/Google Books/Crossref e aplicar os
  dados com um clique;
- criar fontes-container (Book, PeriodicalIssue, AcademicPaper) apenas com
  metadados, sem conteudo, para receber sub-elementos depois;
- ao criar um sub-elemento (BookChapter, StandaloneArticle, DocumentSection),
  buscar a fonte-mae por nome em um select com sugestoes e, se nao existir,
  cria-la em um dialog sem sair do fluxo;
- colar conteudo manual em um tipo hierarquico e cair automaticamente na
  deteccao e revisao de sub-elementos;
- revisar sub-elementos detectados vendo o conteudo real de cada segmento,
  ajustar fronteiras com precisao (snap em headings/paginas) e confirmar a
  importacao da fonte com seus sub-elementos, sem a semantica atual de
  "marcar partes processaveis";
- decidir explicitamente o que fazer quando uma duplicata for detectada.

## 2. Diagnostico do fluxo atual

### 2.1 Como funciona hoje

O fluxo inteiro vive em
`apps/desktop/src/renderer/components/ImportView.tsx`: um formulario unico com
toggle manual/arquivo, um `<select>` plano com os 11 tipos, titulo e conteudo
obrigatorios, URL apenas para `WebArticle`/`Video`, um mini-formulario
bibliografico (titulo da obra, ISBN ou DOI, paginas) apenas para
`Book`/`BookChapter`/`StandaloneArticle` e o `ProcessingPlanPicker`. O
indicador de "passos" tem so dois estados (fonte -> estrutura); nao e um
wizard real.

No main process, `IngestionService.createManual` normaliza o markdown e
persiste; `IngestionService.importFile` converte o arquivo, usa o nome do
arquivo como titulo e roda `detectDocumentStructure` apenas para tipos
hierarquicos. A revisao de estrutura usa `StructureReview.tsx` e a
materializacao transacional em
`packages/db/src/repositories/hierarchicalIngestionRepository.ts`.

### 2.2 Gaps por requisito

| Requisito | Situacao atual |
| --- | --- |
| R1: metadados por tipo | Nao existe autor/criador em nenhum lugar (nem `@app/domain`, nem schema do banco). `bibliographic_instances` tem edition/volume/issue/publicationDate/publisher/isbn/issn/doi, mas a UI so preenche titulo da obra, ISBN ou DOI e paginas. Nao ha capa, o idioma e enviado fixo como `"und"`, e `AcademicPaper` nem recebe o mini-formulario bibliografico. Defuddle extrai author/description/published mas grava em `metadata` JSONB sem tipo. O detector EPUB le o OPF (`packages/conversion/src/structure-detection.ts`) mas ignora Dublin Core (dc:creator, dc:publisher, dc:language, ISBN, capa). O pdfjs e usado so para outline; `getMetadata()` (Info/XMP) nunca e lido. |
| R2: fonte-container sem conteudo | Impossivel: `manualIngestionInputSchema` exige `content` com no minimo 1 caractere (`apps/desktop/src/shared/ipc.ts`) e todo caminho de ingestao cria um `document`. |
| R3: buscar/criar fonte-mae | `lookupSources` existe (sugestao por titulo) mas so e usado para `BookChapter`, sem filtro por tipo compativel e sem dialog de criacao quando a fonte-mae nao existe: digitar um titulo novo cria silenciosamente uma obra bibliografica solta. |
| R4: API aberta para livros | Nao existe nenhum enriquecimento externo. |
| R5: conteudo manual hierarquico -> deteccao | `createManual` nunca roda deteccao de estrutura; apenas `importFile` roda, e somente para `Book`/`PeriodicalIssue`/`AcademicPaper`. `detectMarkdownStructure` ja existe e serviria para conteudo colado. |
| R6: wizard | Nao ha wizard: o tipo e um select sem explicacao, o arquivo e escolhido depois do tipo sem nenhuma extracao de metadados (titulo = nome do arquivo), e a politica de duplicata e `ignore` fixa no codigo, silenciosa para o usuario. |
| R7: revisao de sub-elementos | `StructureReview.tsx` tem semantica dupla confusa (checkbox "processavel" + checkbox "incluir na navegacao"), split cego no ponto medio do offset, nenhum preview do conteudo do segmento e ranges exibidos como offsets crus de markdown. |

### 2.3 Infra existente que sera reutilizada

- detectores EPUB (nav/NCX) e PDF (outline pdfjs + headings Docling) com
  evidencias e confianca em `packages/conversion/src/structure-detection.ts`;
- `validateDivisionTree` e os schemas de divisao em
  `packages/domain/src/hierarchical-ingestion.ts`;
- materializacao transacional com `childTypeForRoot` no
  `hierarchicalIngestionRepository`;
- `document_assets` com `document_id` opcional e coluna `role`: a capa pode
  ser um asset `role = 'cover'` vinculado so ao source item, sem migration;
- `AssetStorageService` (armazenamento por SHA-256 com deduplicacao);
- `queueSources` ja ignora fontes sem documento (`if (!document) continue`),
  o que simplifica fontes-container;
- fila persistida, planos de processamento, presets e batches;
- `fflate` + `linkedom` (leitura de EPUB/OPF) e `pdfjs-dist` ja sao
  dependencias de `@app/conversion`;
- `lookupSources` como base do parent picker.

## 3. Modelo de metadados por tipo

### 3.1 Campos comuns a todos os tipos

| Campo | Estado atual | Acao |
| --- | --- | --- |
| titulo | existe | manter |
| subtitulo | coluna existe, sem UI | expor na UI |
| idioma | coluna existe, UI envia `"und"` fixo | select de idioma com deteccao automatica quando possivel |
| criadores (autores etc.) | nao existe | novo `creators` JSONB estruturado |
| data de publicacao/criacao | so em `bibliographic_instances`, sem UI | expor por tipo |
| descricao/abstract | nao existe estruturado | campo no descriptor tipado |
| capa/thumbnail | nao existe | asset `role = 'cover'` |
| tags/assuntos | nao existe | lista de strings no descriptor |

### 3.2 Auditoria por tipo (campos faltantes para referenciar bem a fonte)

| Tipo | Campos que faltam hoje |
| --- | --- |
| `PersonalNote` | tags/topicos; contexto opcional |
| `DailyNote` | data da nota como campo estruturado (`noteDate`) |
| `WebArticle` | autor(es), nome do site, data de publicacao, descricao, imagem principal (Defuddle ja extrai parte disso; falta mapear para campos tipados) |
| `Book` | autores, organizadores, tradutores, edicao, editora, data de publicacao, idioma, ISBN-10/13 separados e validados, serie/volume, numero de paginas, assuntos, capa |
| `BookChapter` | numero do capitulo, intervalo de paginas estruturado, autores proprios (coletaneas), vinculo forte com o livro-mae |
| `PeriodicalIssue` | nome do periodico como obra, ISSN, volume, numero, data da edicao, editora, capa |
| `AcademicPaper` | autores (com afiliacao opcional), DOI, veiculo (journal/conferencia), ano, abstract, keywords, paginas -- hoje o tipo nao recebe nenhum campo bibliografico na UI |
| `DocumentSection` | numero da secao, intervalo de paginas, vinculo com o paper-mae |
| `StandaloneArticle` | autores, periodico/edicao-mae, data, alem do DOI/paginas ja existentes |
| `Video` | canal/criador, duracao, data de publicacao, plataforma e id do video estruturados, thumbnail (youtubei.js ja captura; falta mapear) |
| `GenericDocument` | autor, data de criacao, descricao (mimeType ja vai para metadata) |

### 3.3 Definicoes de dominio (`@app/domain`)

- `CreatorSchema` (Zod):

```txt
{ name, role: author | editor | translator | organizer | channel |
  host | contributor, sortName?, externalIds? (orcid, openlibrary, ...) }
```

- `SourceDescriptorSchema`: discriminated union por `SourceItemType` com os
  campos da secao 3.2, validada no IPC. O descriptor e persistido de forma
  documentada em `source_items.metadata` (chaves canonicas, nao mais um saco
  generico), e os campos que pertencem a camada bibliografica (obra/instancia)
  sao gravados nas tabelas proprias.
- proveniencia por campo: cada valor carrega origem
  `manual | extracted | enriched`, usada no merge e exibida na UI.

### 3.4 Migrations

- adicionar coluna `creators jsonb not null default '[]'` em
  `bibliographic_works` e `bibliographic_instances`;
- avaliar campos novos em `bibliographic_instances`: `page_count`, `series`;
  demais campos ja existem (edition, volume, issue, publication_date,
  publisher, isbn, issn, doi);
- capa nao exige migration (asset com `role = 'cover'`);
- seguir as regras do projeto: `npm run db:generate`, atualizar
  `packages/db/seed/baseline.sql` e `packages/db/seed/manifest.json` na mesma
  mudanca, validar com `npm run db:seed:verify` e verificar no banco real.

## 4. Extracao local de metadados de arquivo

Novo modulo `packages/conversion/src/metadata-extraction.ts`, exposto como
`extractFileMetadata(input) -> SourceDescriptorDraft` com proveniencia por
campo. Nao acessa banco; o `IngestionService` orquestra.

Extratores por formato:

- EPUB: ler OPF/Dublin Core (dc:title, dc:creator com papel, dc:publisher,
  dc:language, dc:date, dc:identifier com ISBN, dc:subject, dc:description) e
  a capa (item `properties="cover-image"` ou meta `name="cover"`),
  reutilizando `fflate` + `linkedom` ja usados pelo detector de estrutura;
- PDF: `pdfjs.getMetadata()` (Info dict e XMP: Title, Author, Subject,
  Keywords, CreationDate) mais heuristicas nas primeiras ~10 paginas do texto
  convertido: regex de ISBN (com validacao de digito verificador), regex de
  DOI (`10.\d{4,9}/...`), titulo pelo primeiro heading Docling de maior
  hierarquia quando o Info dict estiver vazio ou for lixo (ex.
  `Microsoft Word - final.docx`);
- Defuddle (web): mapear title/author/description/published/site para o
  descriptor tipado de `WebArticle` (hoje vai para metadata sem tipo);
- YouTube: mapear canal, duracao, data, thumbnail e id do video capturados
  pelo `youtubei.js` para o descriptor de `Video`;
- Docling: aproveitar metadados de documento quando o sidecar fornecer;
- nome do arquivo: fallback de titulo com limpeza de separadores.

Regras:

- validacao/normalizacao de ISBN-10 <-> ISBN-13; biblioteca opcional `isbn3`
  (unica dependencia nova considerada, pequena e sem transitividade pesada) ou
  implementacao propria do digito verificador;
- todo campo extraido recebe proveniencia `extracted` e a fonte da evidencia
  (`epub-opf`, `pdf-info`, `pdf-page-scan`, `defuddle`, `youtubei`);
- a extracao nunca bloqueia a importacao: falha vira warning e o formulario
  fica em branco para preenchimento manual.

## 5. Enriquecimento externo (APIs abertas gratuitas)

Novo `MetadataEnrichmentService` no main process
(`apps/desktop/src/main/services/metadata-enrichment-service.ts`), com um
adapter por provedor e um contrato comum
`search(query) -> EnrichmentCandidate[]`:

- Open Library (primario para livros): lookup por ISBN
  (`/isbn/{isbn}.json` + `/works/...`), busca por titulo/autor
  (`/search.json`), capas via `covers.openlibrary.org`; gratuito, sem chave;
- Google Books (fallback para livros): `GET
  https://www.googleapis.com/books/v1/volumes?q=isbn:...|intitle:...`;
  gratuito sem chave para consultas basicas; usado quando Open Library nao
  retornar candidato bom (ajuda com livros brasileiros recentes);
- Crossref (papers e artigos): `GET https://api.crossref.org/works/{doi}` e
  busca bibliografica; incluir `mailto` no User-Agent (polite pool); preenche
  autores, veiculo, ano, paginas e abstract quando disponivel.

Comportamento:

- disparo automatico com opt-out: quando o wizard tiver ISBN/DOI (digitado ou
  extraido do arquivo) ou titulo+tipo compativel, a busca dispara sozinha com
  debounce; um toggle global em Settings
  (`metadataEnrichmentEnabled`, default ligado) desabilita qualquer chamada;
  com o toggle desligado o botao "Buscar dados" some e nada sai da maquina;
- a UI mostra a lista de candidatos com capa, titulo, autor, edicao e ano;
  o usuario escolhe um candidato e os campos sao aplicados;
- merge campo a campo com proveniencia: valor `manual` nunca e sobrescrito
  sem confirmacao; `enriched` sobrescreve `extracted` apenas com aceite do
  usuario (diff visivel no formulario);
- a capa escolhida e baixada e armazenada via `AssetStorageService` como
  asset `role = 'cover'` (nunca hotlink em runtime);
- cache local de consultas (por ISBN/DOI/query normalizada) para evitar
  chamadas repetidas; TTL simples em tabela ou arquivo em `userData`;
- resiliencia: timeout curto, sem retry agressivo, falha de rede degrada para
  fluxo manual com aviso discreto; nenhum segredo envolvido, logs sem payload
  sensivel;
- transparencia local-first: as URLs consultadas ficam registradas no log de
  debug; nenhum conteudo do usuario e enviado, apenas ISBN/DOI/titulo/autor.

## 6. Wizard de importacao

Substituir o `ImportView` por um wizard com passos adaptativos. Todos os
textos via `@app/i18n` nos 5 locales.

Passos:

1. Tipo: cards agrupados (Notas, Web e Midia, Livros e Periodicos,
   Academico, Generico), cada card com nome e uma frase explicando o tipo;
   caixa de busca/filtro no topo; badge "hierarquico" para
   `Book`/`PeriodicalIssue`/`AcademicPaper`; badge "sub-elemento" para
   `BookChapter`/`StandaloneArticle`/`DocumentSection`.
2. Origem: manual ou arquivo, com disponibilidade por tipo (ex.
   `PersonalNote`/`DailyNote` apenas manual; `Video` manual com URL;
   `WebArticle` manual com URL ou captura pela extensao).
3. Fluxo por origem:
   - arquivo: escolher arquivo -> extracao local (secao 4) -> formulario de
     dados pre-preenchido com proveniencia visivel -> enriquecimento
     automatico (secao 5) com lista de candidatos e aplicacao por clique;
   - manual: formulario de dados por tipo (secao 3) -> passo de conteudo;
     para tipos hierarquicos o conteudo e opcional: vazio cria
     fonte-container so com metadados (secao 7); preenchido roda
     `detectMarkdownStructure` e segue para a revisao de estrutura.
4. Estrutura (apenas quando aplicavel): revisao v2 (secao 8).
5. Plano e confirmacao: `ProcessingPlanPicker` + resumo do que sera criado
   (fonte, sub-elementos, capa, vinculos bibliograficos) + tratamento
   explicito de duplicata: se `findDuplicate` acusar, mostrar a fonte
   existente e as opcoes ignorar/atualizar/importar mesmo assim, em vez do
   `ignore` silencioso atual.

Parent picker (para `BookChapter`, `StandaloneArticle`, `DocumentSection`):

- campo "fonte-mae" com busca por nome com debounce via `lookupSources`,
  filtrado pelo tipo de pai compativel (`Book`, `PeriodicalIssue`,
  `AcademicPaper`);
- se nao encontrar, acao "criar nova fonte-mae" abre um dialog com o mesmo
  formulario de metadados do tipo pai (com enriquecimento), criando uma
  fonte-container sem sair do fluxo do filho;
- o vinculo usa `parentSourceItemId` + link bibliografico (obra/instancia),
  nunca apenas o titulo digitado.

## 7. Fonte-container sem conteudo

- novo caminho `createContainerSource(descriptor)` no `IngestionService`:
  cria `source_items` (e camada bibliografica + capa) sem criar `documents`
  nem `ingestion_runs`;
- `manualIngestionInputSchema` passa a ter `content` opcional quando o tipo
  for hierarquico e o descriptor estiver completo;
- tolerancia a fonte sem documento: Library (badge "container", contagem de
  filhos), detalhe da fonte, busca (nao indexa nada, apenas navegacao),
  exclusao e projecao Obsidian (projetar apenas frontmatter + metadados ou
  pular, conforme politica ja usada para raizes);
- o pipeline nao precisa mudar: `queueSources` ja pula fontes sem documento;
- quando filhos existirem, os fluxos ja implementados de processamento por
  escopo (`children_only`, `source_and_children`) e resumo agregado passam a
  valer para containers criados manualmente.

## 8. Revisao de estrutura v2 (sub-elementos)

Reescrever a semantica da revisao: a deteccao propoe segmentos precisos, o
usuario revisa e ajusta, e a confirmacao importa a fonte com seus
sub-elementos. Some a ideia de "marcar partes que viram fontes externas
linkadas".

Mudancas na UI (`StructureReview.tsx`):

- preview do conteudo: painel mostrando o slice real do markdown canonico do
  segmento selecionado (inicio e fim visiveis), em vez de offsets crus;
- ajuste de fronteira com precisao: lista de fronteiras candidatas
  (headings do Docling, paginas do outline, blocos) com snap; o split deixa
  de ser no ponto medio cego e passa a ser "escolher o ponto de corte no
  preview/lista de headings";
- semantica unica "vira sub-elemento": um unico controle por divisao
  substitui o par processavel/navegacao; niveis mais profundos podem ficar
  como navegacao interna via um controle de "nivel de corte" com override por
  divisao (o schema `isProcessable`/`reviewStatus` e mantido por
  compatibilidade, mas a UI apresenta um conceito so);
- metadados por divisao: titulo, kind e criadores opcionais (autores por
  artigo de revista, por capitulo de coletanea), editaveis na revisao;
- rodape claro: "Importar fonte com N sub-elementos".

Mudancas na materializacao (`hierarchicalIngestionRepository`):

- propagar criadores e metadados da divisao para o `source_item` filho e para
  o vinculo bibliografico (capitulo -> obra com paginas);
- herdar do container: idioma, obra bibliografica, editora/edicao quando
  fizer sentido para o tipo filho.

Precisao da deteccao:

- os detectores atuais (EPUB nav/NCX, PDF outline + headings) permanecem o
  caminho primario;
- fase tardia opcional: proposta de estrutura assistida por IA para PDFs sem
  outline confiavel, usando o perfil ativo da tarefa e registrando em
  `ai_task_runs`; nunca obrigatoria, sempre revisavel.

## 9. Contratos, IPC e servicos

Novos canais IPC (validados por Zod em `apps/desktop/src/shared/ipc.ts`):

- `ingestion.extractFileMetadata`: arquivo escolhido -> descriptor draft com
  proveniencia (roda conversao/extracao sem persistir);
- `ingestion.enrichMetadata`: `{ sourceType, isbn?, doi?, title?, author? }`
  -> lista de `EnrichmentCandidate`;
- `ingestion.applyEnrichmentCover`: baixa e persiste a capa escolhida;
- `ingestion.createContainerSource`: descriptor -> fonte sem documento;
- `ingestion.detectStructureFromContent`: conteudo manual + tipo -> draft de
  estrutura (reusa `detectMarkdownStructure` + `createStructureDraft`).

Evolucoes de contratos existentes:

- `manualIngestionInputSchema` e `fileImportInputSchema` passam a aceitar o
  `SourceDescriptor` tipado completo e a decisao explicita de duplicata;
- `lookupSources` ganha filtro por tipo(s);
- os caminhos de captura (extensao Chrome, YouTube, Obsidian) apenas mapeiam
  seus metadados para os novos schemas, sem mudanca de UX nesta fase.

Servicos novos/alterados no main process:

- `MetadataEnrichmentService` (novo);
- `IngestionService`: orquestra extracao, descriptor, container e duplicata;
- `SettingsService`: toggle `metadataEnrichmentEnabled`;
- `HierarchicalIngestionService`/repositorio: metadados por divisao e
  propagacao na materializacao.

## 10. i18n, testes e migrations

- i18n: chaves novas para cards de tipo (nome + frase), passos do wizard,
  formularios por tipo, proveniencia de campo, candidatos de enriquecimento,
  dialogs de fonte-mae e duplicata, revisao v2 -- nos 5 locales (`en`,
  `pt-BR`, `it`, `fr`, `es`);
- testes:
  - schemas Zod de `CreatorSchema` e `SourceDescriptorSchema` (validos e
    invalidos por tipo);
  - extratores com fixtures reais pequenas (EPUB com OPF completo, PDF com
    Info dict, PDF sem metadados exigindo heuristica, ISBN-10/13);
  - adapters de enriquecimento com HTTP mockado (respostas gravadas de Open
    Library/Google Books/Crossref), incluindo timeout e falha de rede;
  - merge com proveniencia (manual > enriched > extracted);
  - repositorios e materializacao com criadores propagados;
  - fluxo container: criar sem documento, adicionar filho, processar escopo;
  - composicao do wizard (estados vazio/carregando/erro/sucesso) sem GUI
    manual;
- migrations: gerar via `npm run db:generate`, atualizar
  `seed/baseline.sql` + `seed/manifest.json` na mesma mudanca, validar com
  `npm run db:seed:verify` e verificar estrutura real no banco
  (`information_schema`, indices) antes de dar a fase por pronta.

## 11. Fases de implementacao

Cada fase e uma entrega verificavel; nenhuma fase seguinte comeca sem os
criterios de pronto da anterior.

### F1 -- Dominio e migrations

Entrega: `CreatorSchema`, `SourceDescriptorSchema` por tipo, proveniencia de
campo, migration de `creators` (+ `page_count`/`series` se confirmados),
baseline e seed sincronizados.

Pronto quando: `npm run db:seed:verify` e testes de schema passam; banco real
verificado.

### F2 -- Extracao local de metadados

Entrega: `metadata-extraction.ts` com extratores EPUB/PDF/Defuddle/YouTube,
validacao de ISBN, mapeamento para descriptors e IPC
`extractFileMetadata`.

Pronto quando: fixtures de EPUB e PDF produzem descriptors corretos com
proveniencia; falha de extracao nao bloqueia importacao.

### F3 -- Enriquecimento externo

Entrega: `MetadataEnrichmentService` com adapters Open Library, Google Books
e Crossref, cache, download de capa via `AssetStorageService`, toggle em
Settings e IPC `enrichMetadata`.

Pronto quando: busca por ISBN/DOI/titulo retorna candidatos nos testes com
HTTP mockado; toggle desligado bloqueia toda chamada; capa persistida como
asset `cover`.

### F4 -- Wizard de importacao

Entrega: novo wizard (tipo com cards, origem, dados pre-preenchidos,
candidatos de enriquecimento, plano, confirmacao com duplicata explicita) e
i18n completo.

Pronto quando: fluxos manual e arquivo funcionam ponta a ponta para todos os
tipos nao hierarquicos, com estados vazio/carregando/erro cobertos.

### F5 -- Fonte-container e parent picker

Entrega: `createContainerSource`, conteudo opcional para tipos hierarquicos,
tolerancia a fonte sem documento (Library, detalhe, busca, Obsidian,
exclusao), parent picker com busca filtrada e dialog de criacao da fonte-mae.

Pronto quando: e possivel criar um livro so com metadados, criar um capitulo
buscando o livro (ou criando-o no dialog) e processar o escopo depois.

### F6 -- Revisao de estrutura v2

Entrega: preview de conteudo, snap de fronteiras, semantica unica de
sub-elemento, metadados por divisao, materializacao propagando criadores,
deteccao a partir de conteudo manual (`detectStructureFromContent`).

Pronto quando: importar EPUB/PDF hierarquico e colar conteudo manual
resultam em fonte + sub-elementos corretos com metadados herdados; testes de
materializacao passam.

### F7 -- Hardening

Entrega: fixtures adicionais (livros reais variados, papers com/sem DOI),
ajuste fino das heuristicas, revisao de acessibilidade do wizard, atualizacao
de `MAPA.md` e deste documento com o estado final; avaliacao da fase opcional
de estrutura assistida por IA.

Pronto quando: `npm run typecheck`, `npm test` e `npm run build` passam;
pendencias registradas.

## 12. Riscos e pontos de atencao

- rede indisponivel ou APIs fora do ar: o enriquecimento e sempre opcional e
  degrada para fluxo manual; nada bloqueia a importacao;
- qualidade dos dados externos varia (edicoes brasileiras, obras antigas):
  por isso o merge exige aceite do usuario e preserva proveniencia;
- PDFs sem Info dict e sem outline continuam existindo: heuristicas de
  primeiras paginas reduzem, mas nao eliminam, preenchimento manual;
- compatibilidade com fontes ja importadas: nenhuma migracao de dados
  retroativa obrigatoria; um backfill opcional de descriptors a partir de
  `metadata` existente pode ser avaliado em F7;
- volume de i18n: os cards e formularios por tipo geram muitas chaves; tratar
  como parte do criterio de pronto de F4, nunca hardcoded;
- fronteiras de arquitetura: extracao fica em `@app/conversion` (sem banco),
  enriquecimento e rede ficam no main process, renderer continua falando so
  via IPC validado por Zod.
