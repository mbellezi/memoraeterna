# Plano de Importacao Hierarquica e Ingestao Seletiva

Status: implementacao funcional concluida em 2026-07-15. O corpus golden amplo,
benchmarks de memoria e smoke manual multiplataforma permanecem como hardening
de distribuicao, sem bloquear o fluxo funcional descrito neste documento.

Este plano descreve a evolucao da importacao de arquivos longos para suportar
livros, revistas e papers estruturados, escolha das etapas de processamento,
processamento posterior em lote e reingestao segura. Ele complementa
`docs/initial.md` e `docs/mvp-implementation-plan.md`; o estado implementado e
os pontos de validacao operacional estao registrados em `MAPA.md`.

## 1. Resultado esperado

Ao final desta evolucao, o usuario podera:

- importar um arquivo sem ser obrigado a executar tarefas de IA;
- escolher, em toda importacao interativa, quais etapas de processamento deseja
  executar;
- revisar e corrigir as divisoes detectadas antes que elas se tornem a
  hierarquia canonica da fonte;
- navegar na Library por uma hierarquia de fonte principal e itens filhos;
- tratar livros como `Book -> BookChapter`;
- tratar edicoes de revistas como `PeriodicalIssue -> StandaloneArticle`;
- tratar papers como `AcademicPaper -> DocumentSection`, preservando tambem
  subsecoes apenas navegacionais quando nao precisarem ser fontes independentes;
- gerar resumo, notas atomicas, grafo e relacionamentos por capitulo, artigo ou
  secao;
- selecionar posteriormente um ou mais itens e escolher quais etapas executar;
- reexecutar etapas ja concluidas sem confundir reingestao com retry;
- preservar resultados revisados pelo usuario e a proveniencia de resultados
  antigos durante uma reingestao;
- acompanhar lotes, itens, etapas, erros e resultados pela interface.

## 2. Principios e decisoes de arquitetura

### 2.1 Importar, estruturar e processar sao operacoes distintas

O fluxo deixa de tratar "importar" e "executar todo o pipeline" como sinonimos:

```txt
Importacao obrigatoria
  -> preservar o arquivo original
  -> identificar formato e metadados
  -> converter/normalizar conteudo
  -> detectar e revisar estrutura quando aplicavel
  -> materializar fonte principal e itens filhos

Processamento opcional
  -> chunking
  -> embeddings para busca
  -> resumo
  -> notas atomicas
  -> grafo de conhecimento
  -> matching/relacionamentos
  -> projecao Obsidian
```

A importacao deve continuar util sem IA: a fonte e suas divisoes podem ser
navegadas, lidas e processadas posteriormente.

### 2.2 Divisao documental nao e chunk

Capitulos, artigos e secoes sao unidades canonicas e navegaveis. Cada uma pode
ter documento, resumo, notas atomicas, historico de processamento e muitos
chunks. Chunks continuam sendo unidades tecnicas para busca e IA e nao devem
ser exibidos como a hierarquia editorial.

### 2.3 Um original, varias divisoes rastreaveis

O arquivo original pertence a fonte raiz e deve ser armazenado fisicamente uma
unica vez. Itens filhos guardam seletores e proveniencia para esse original:

- PDF: pagina inicial/final, page label, bloco Docling, bounding box e offsets;
- EPUB: item do spine, `href`, fragmento, caminho DOM e EPUB CFI quando
  disponivel;
- Markdown normalizado: offsets inicial/final e hash do trecho.

O documento Markdown de cada filho e uma derivacao versionada. Nao se duplica o
PDF ou EPUB para cada capitulo.

### 2.4 Retry e reingestao tem semanticas diferentes

- **Retry/retomada:** continua a mesma `ingestion_run`, respeitando checkpoints
  concluidos e tentando novamente a etapa que falhou ou foi cancelada.
- **Reingestao:** cria uma nova execucao intencional, com novo plano de etapas,
  novos hashes de entrada e vinculo para a execucao anterior que ela substitui.
- **Executar etapas ausentes:** cria uma nova execucao que reutiliza artefatos
  validos e executa apenas o que nunca foi concluido.

A UI deve usar esses tres nomes, sem apresentar todos como "Tentar novamente".

### 2.5 Resultados revisados nunca sao apagados silenciosamente

- resumos antigos permanecem no historico; o mais novo concluido vira o atual;
- notas `approved`, `rejected` ou editadas pelo usuario nao sao sobrescritas por
  nova geracao;
- notas antigas ainda `pending_review` podem ser marcadas como `archived` ou
  `superseded` depois de uma confirmacao explicita;
- relacionamentos aceitos/rejeitados pelo usuario nao sao sobrescritos por um
  novo score automatico;
- mudanca de conteudo ou estrutura cria uma nova revisao documental; chunks
  referenciados por notas revisadas nao sao removidos por cascade;
- toda saida derivada registra a execucao e a revisao documental usadas.

### 2.6 A estrutura detectada e uma proposta antes de ser canonica

Deteccao automatica produz uma arvore em estado `draft`. O usuario pode revisar,
renomear, dividir, unir, reordenar, mudar o tipo ou excluir candidatos. Somente
`Confirmar estrutura` materializa/atualiza itens filhos.

Na primeira versao, a revisao deve ser obrigatoria para livros, revistas e
papers. Uma preferencia futura pode permitir aceitacao automatica apenas para
estruturas de alta confianca.

## 3. Tipos e hierarquias de dominio

Esta funcionalidade e uma expansao pos-MVP da taxonomia fixa registrada em
`RULES.md`. Antes da implementacao da migration, a expansao deve ser confirmada
e registrada nas regras do projeto.

Modelo recomendado:

| Documento | Fonte raiz | Filho processavel | Nos apenas navegacionais |
| --- | --- | --- | --- |
| Livro | `Book` | `BookChapter` | parte, subsecao, apendice |
| Revista | `PeriodicalIssue` (novo) | `StandaloneArticle` | editorial, expediente, agrupamento |
| Paper | `AcademicPaper` (novo) | `DocumentSection` (novo) | subsecao e subsubsecao |

Regras:

- `parent_source_item_id` continua expressando a hierarquia entre fontes;
- a fonte raiz aparece na lista principal da Library;
- filhos aparecem dentro da fonte raiz por padrao e podem ser encontrados por
  busca ou filtro sem poluir a lista principal;
- secoes de baixo nivel podem existir somente em `document_divisions` quando
  servirem apenas para navegacao;
- promover uma divisao navegacional para item processavel cria um `SourceItem`
  filho sem perder seu id estrutural e sua proveniencia;
- consultas, busca e contagens da fonte raiz podem incluir descendentes;
- excluir a raiz exige confirmacao e uma politica explicita para toda a arvore;
- excluir um filho nao exclui o original nem seus irmaos.

## 4. Deteccao de estrutura

### 4.1 Contrato comum

Todo detector deve produzir candidatos no mesmo formato conceitual:

```ts
type DocumentDivisionKind =
  | "part"
  | "chapter"
  | "article"
  | "section"
  | "subsection"
  | "frontmatter"
  | "backmatter"
  | "appendix"
  | "unknown";

interface DocumentDivisionCandidate {
  id: string;
  parentId: string | null;
  kind: DocumentDivisionKind;
  title: string;
  level: number;
  position: number;
  startSelector: Record<string, unknown>;
  endSelector: Record<string, unknown>;
  startPage?: number;
  endPage?: number;
  confidence: number;
  evidence: Array<{
    kind: string;
    source: string;
    score: number;
    metadata: Record<string, unknown>;
  }>;
  reviewStatus: "proposed" | "accepted" | "rejected" | "edited";
}
```

O score e explicavel: a UI deve conseguir mostrar, por exemplo, "encontrado no
sumario do EPUB" ou "bookmark e titulo na pagina concordam".

### 4.2 EPUB

Ordem de confianca:

1. `nav.xhtml` com `nav epub:type="toc"` no EPUB 3;
2. NCX no EPUB 2;
3. semantica EPUB/HTML (`epub:type`, `section`, `h1`-`h6`);
4. fronteiras de arquivos XHTML no spine;
5. nomes de arquivo apenas como ultimo fallback.

Fluxo:

```txt
EPUB/ZIP
  -> META-INF/container.xml
  -> package OPF
  -> metadata + manifest + spine
  -> nav.xhtml ou NCX
  -> resolver href e fragmentos
  -> alinhar TOC com a ordem do spine
  -> construir arvore proposta
  -> extrair XHTML por divisao
  -> normalizar Markdown e proveniencia
```

Requisitos:

- implementar o analisador estrutural em TypeScript com extracao ZIP limitada;
- reutilizar `fflate` e um parser XML/XHTML seguro;
- suportar um capitulo distribuido em varios XHTML;
- suportar varios capitulos no mesmo XHTML por fragmentos;
- preservar niveis mais profundos do sumario, mesmo quando apenas capitulos
  forem materializados como filhos;
- classificar front matter, back matter, apendice, notas e indice;
- ignorar scripts e nunca buscar recursos remotos durante a analise;
- validar paths do container contra traversal e impor limites de entradas,
  profundidade, tamanho expandido e taxa de compressao;
- manter Docling como conversor/normalizador disponivel, mas nao depender do
  Markdown final para redescobrir uma estrutura que o EPUB ja declara.

### 4.3 PDF

PDF nao garante estrutura semantica. A deteccao deve combinar sinais:

1. outline/bookmarks e page labels lidos por `pdfjs-dist` no backend Node;
2. sumario impresso e numeros de pagina extraidos do conteudo;
3. `title`, `section_header`, hierarquia, ordem e proveniencia do
   `DoclingDocument`;
4. sinais de layout, como posicao, destaque, pagina de abertura e espaco em
   branco;
5. padroes lexicais multilingues (`Capitulo`, `Chapter`, `Parte`, `Abstract`,
   `References` etc.);
6. OCR Docling em paginas sem camada textual;
7. modelo visual apenas como fallback futuro, opcional e explicitamente
   autorizado pelo perfil de privacidade.

O detector deve:

- resolver destinos de bookmarks para paginas fisicas;
- preservar page labels e tratar numeracao romana ou reiniciada;
- localizar paginas de sumario e interpretar linhas com titulo e pagina;
- estimar e validar o deslocamento entre pagina impressa e indice do PDF;
- confirmar entradas do sumario por similaridade com headings proximos;
- combinar evidencias sem tratar qualquer heading isolado como capitulo;
- detectar sobreposicoes, intervalos vazios, gaps e limites fora do arquivo;
- diferenciar livros, revistas e papers com regras especificas;
- manter baixa confianca quando houver somente padrao lexical ou layout;
- permitir que o usuario mantenha o PDF como uma unica fonte se a divisao for
  fraca.

Sinais especificos:

- **Livro:** partes, capitulos, prefacio, apendices e indice;
- **Revista:** sumario, titulo de materia, subtitulo, byline e pagina inicial;
  chamadas de capa, anuncios e cabecalhos recorrentes nao devem virar artigos;
- **Paper:** abstract, secoes numeradas, conclusao, acknowledgements,
  referencias e apendices; titulos de figuras/tabelas nao devem virar secoes.

Calibracao implementada em 2026-07-16 para papers sem bookmarks:

- o Markdown canonico exportado pelo Docling passou a ser a fonte dos limites
  de cada secao; offsets dos blocos estruturados nao sao mais usados como
  fronteira porque podem perder alinhamento em documentos longos;
- blocos Docling continuam sendo cruzados por titulo para fornecer pagina,
  bounding box, indentacao e evidencia explicavel;
- a hierarquia combina numeracao (`1`, `1.1`, `1.1.1`), niveis Markdown e
  indentacao conservadora; todas as secoes aceitas de um paper podem ser
  materializadas como `DocumentSection` sem perder o texto das subpartes;
- o filtro remove titulo/autoria repetidos, sumario, rotulos editoriais,
  captions, headings dentro de figuras, marcadores de codigo e boilerplate do
  publicador;
- o lexico cobre inicialmente ingles, portugues, espanhol, frances, italiano e
  alemao para abstract, introducao, metodos, resultados, discussao, conclusao,
  declaracoes, referencias e apendices;
- os sete PDFs de `samples/articles` foram usados na calibracao: seis acionam
  este fallback sem bookmarks e passaram a produzir intervalos Markdown nao
  vazios; o PDF com outline continua usando a navegacao nativa prioritaria.

Calibracao implementada em 2026-07-16 para livros EPUB e PDF:

- em EPUB, `nav.xhtml`/NCX permanece como autoridade para ordem e hierarquia,
  mas cada entrada e alinhada ao Markdown canonico convertido para definir
  intervalos reais; o alinhamento evita ocorrencias duplicadas no sumario e
  tambem funciona quando o conversor nao preserva headings Markdown;
- em PDF com bookmarks, outline e page labels permanecem prioritarios e os
  destinos sao cruzados com headings do Markdown. Em PDF sem bookmarks, partes,
  capitulos e apendices sao detectados diretamente no Markdown canonico, usando
  blocos Docling somente como evidencia de pagina e layout;
- em papers com outline hierarquico, a raiz e secoes que apenas agrupam filhos
  ficam navegaveis, enquanto as secoes-folha sao processaveis; isso preserva
  todas as subpartes sem materializar intervalos pai/filho sobrepostos;
- o fallback distingue sumario impresso do corpo, combina marcadores genericos
  de capitulo com o subtitulo seguinte e recupera lacunas numeradas quando o
  OCR deixou de classificar um titulo como heading;
- papeis de livro cobrem marcadores em portugues, ingles, espanhol, frances,
  italiano e alemao, alem de ordinais romanos e marcadores chineses observados
  no corpus; heuristicas especializadas reduzem sessoes internas a capitulos
  tematicos em livros cujo layout repetiria dezenas de falsos capitulos;
- o corpus local ignorado pelo Git contem sete papers, treze EPUBs e nove PDFs
  de livros. Um PDF adicional foi excluido temporariamente; o PDF integralmente
  escaneado de Ouspensky e exercitado apenas nas primeiras 100 paginas. O runner
  guarda conversoes por lote e snapshots para comparar novos exemplos sem
  reenviar esse corpus ao repositorio.

### 4.4 DoclingDocument e blocos

O sidecar atual preserva `rawStructuredResult`, mas `_block_payload()` achata
`texts`, `tables` e `pictures`. A implementacao deve expor explicitamente:

- arvore `body` e `groups`;
- referencias parent/children;
- labels originais;
- ordem de leitura;
- `self_ref`/JSON Pointer;
- pagina, bounding box, charspan e confianca;
- offsets no Markdown por serializacao controlada, sem depender apenas de
  `markdown.find`, que e ambiguo para textos repetidos.

O protocolo do sidecar deve ganhar versao nova e manter validacao Zod. A logica
de dominio, scoring e revisao continua em TypeScript; Python permanece restrito
a conversao Docling.

### 4.5 Confianca e decisao

Faixas iniciais, calibradas por fixtures em vez de fixadas sem evidencia:

- `high`: dois sinais fortes concordam, ou estrutura nativa EPUB valida;
- `medium`: um sinal forte ou varios sinais fracos coerentes;
- `low`: inferencia lexical/layout sem confirmacao independente.

Comportamento:

- alta: candidato selecionado na tela de revisao;
- media: candidato selecionado com alerta visual;
- baixa: candidato nao selecionado ou documento unico sugerido;
- conflito: bloquear confirmacao ate o usuario resolver overlap/ordem;
- o usuario sempre pode inspecionar as evidencias.

## 5. Plano de processamento por etapas

### 5.1 Etapas e dependencias

As etapas selecionaveis devem formar um DAG validado no dominio:

```txt
conversion (obrigatoria na importacao)
  -> structureDetection (quando aplicavel)
  -> structureReview (checkpoint humano)
  -> materialization
      -> chunking
          -> embedding
          -> summarization
          -> atomicNotes
              -> knowledgeGraph
              -> atomicNoteMatching
      -> obsidianProjection (apos mudancas canonicas, quando habilitado)

summarization (subitens processaveis selecionados)
  -> aggregateSummarization (Book)
```

Regras:

- a UI mostra as dependencias e inclui pre-requisitos automaticamente;
- desmarcar um pre-requisito desmarca os dependentes;
- `summarization` e `atomicNotes` exigem chunks, mas nao exigem embedding;
- `knowledgeGraph` e `atomicNoteMatching` exigem notas atomicas;
- matching pode usar sinais disponiveis e registrar quando vetor ou AGE nao
  estavam disponiveis;
- em lote, matching aguarda a geracao de notas de todos os itens selecionados
  para evitar viés pela ordem de execucao;
- em uma hierarquia, `aggregateSummarization` aguarda o fim do processamento
  dos subitens selecionados e usa os resumos que efetivamente foram produzidos;
- etapas nao solicitadas ficam `skipped` com motivo `not_requested`, em vez de
  parecerem pendentes ou falhas;
- o plano efetivo e persistido como snapshot; mudancas posteriores nas
  configuracoes nao alteram uma execucao ja criada.

### 5.2 Presets da interface

Toda importacao interativa apresenta uma etapa de escolha, com estes presets:

- **Importar somente:** arquivo, conversao, estrutura e materializacao;
- **Preparar para busca:** mais chunking e embeddings;
- **Gerar resumo:** mais chunking e resumo;
- **Conhecimento completo:** busca, resumo, notas, grafo e relacionamentos;
- **Personalizado:** checkboxes por etapa com dependencias visiveis.

O ultimo preset pode vir pre-selecionado, mas o dialog deve aparecer em toda
importacao interativa. Nao iniciar tarefas de IA antes da confirmacao.

### 5.3 Escopo do processamento

O usuario pode executar um plano para:

- uma fonte simples;
- a fonte raiz inteira;
- todos os filhos ainda nao processados;
- uma selecao de capitulos/artigos/secoes;
- itens filtrados por estado, como "sem resumo" ou "com erro".

Na raiz, a UI deve distinguir:

- processar somente a raiz;
- processar os filhos selecionados;
- processar a raiz e os filhos.

Por padrao, livros/revistas/papers geram conhecimento nos filhos. A raiz agrega
estado e resultados dos descendentes, sem duplicar notas do conteudo inteiro.
Quando pelo menos um filho entra no plano, a raiz recebe somente um documento
catalografico sintetico com titulo, criadores, metadados e o resumo atual da
fonte, quando existir. Esse
documento pode passar por chunking tecnico, embedding e construcao do grafo
quando essas etapas fizerem parte do plano; resumo, notas atomicas e matching
continuam exclusivos dos filhos selecionados.
Em `Book`, processar somente a raiz oferece apenas etapas aplicaveis a raiz,
como `aggregateSummarization`. Selecionar o preset **Gerar resumo** para o livro
inclui os capitulos processaveis ainda sem resumo e finaliza com a agregacao dos
resumos que foram efetivamente produzidos.

### 5.4 Resumo agregado do livro

O resumo atual de um `Book` deve ser obrigatoriamente um resumo dos resumos
atuais e nao vazios de seus `BookChapter` processaveis, nunca um resumo
independente do arquivo inteiro.

Regras:

- cada capitulo gera e mantem seu proprio resumo primeiro;
- `aggregateSummarization` entra na fila automaticamente quando o processamento
  dos subitens selecionados terminar e pelo menos um resumo atual e valido
  tiver sido produzido;
- a entrada da agregacao e ordenada pela ordem canonica dos capitulos;
- a geracao registra os ids, hashes e versoes de todos os resumos de capitulo
  usados;
- subitens sem conteudo resumivel, como titulos, indices, bibliografias e
  referencias, podem permanecer sem resumo e nao bloqueiam a agregacao;
- se nenhum subitem produzir resumo, a raiz permanece sem resumo agregado;
- a mesma regra e aplicada de baixo para cima em cada nivel da hierarquia, de
  modo que um resumo agregado intermediario possa alimentar seu pai;
- a UI pode mostrar progresso, por exemplo, `9 de 12 capitulos processados, 7 resumidos`;
- capitulos explicitamente excluidos da estrutura ou marcados apenas para
  navegacao nao entram na agregacao;
- front matter, apendice ou outro filho processavel entra se tiver sido
  confirmado pelo usuario como parte do conteudo resumivel;
- quando um resumo de capitulo for criado, reingerido, substituido ou esvaziado,
  o resumo agregado atual do livro fica `stale` e uma nova agregacao e agendada
  depois que o processamento dos subitens selecionados terminar;
- o historico de resumos agregados permanece auditavel;
- notas atomicas continuam pertencendo aos capitulos; a agregacao nao gera
  copias de notas no nivel do livro.

Para livros muito extensos, a agregacao pode usar map-reduce deterministico
sobre grupos ordenados de resumos de capitulos, preservando no resultado final
a rastreabilidade ate cada resumo de origem.

Revistas e papers podem ganhar agregacao equivalente em uma evolucao posterior,
mas isso nao e requisito para considerar este plano concluido.

## 6. Persistencia e migrations

### 6.1 Estrutura documental

Adicionar tabelas equivalentes a:

`document_structures`

- `id`;
- `root_source_item_id`;
- `root_document_id`;
- `format`;
- `detector_version`;
- `status`: `draft`, `in_review`, `confirmed`, `materialized`, `superseded`;
- `overall_confidence`;
- `revision`;
- `raw_evidence`;
- timestamps e usuario/acao que confirmou.

`document_divisions`

- `id` estavel;
- `structure_id`;
- `parent_division_id`;
- `child_source_item_id` e `child_document_id`, nulos antes da materializacao;
- `kind`, `title`, `level`, `position`;
- seletores inicial/final tipados por formato;
- pagina inicial/final e page labels quando aplicavel;
- offsets no Markdown raiz;
- `content_hash`;
- `confidence`, `evidence` e `review_status`;
- `is_processable`;
- metadata e timestamps.

Restricoes:

- arvore sem ciclos;
- ordem unica entre irmaos;
- intervalos de filhos processaveis nao se sobrepoem;
- seletores pertencem ao documento raiz declarado;
- materializacao idempotente pelo id da divisao;
- editar limites depois de haver resultados derivados cria nova revisao da
  estrutura, sem mutar a proveniencia historica.

### 6.2 Revisoes de documento

Estender `documents` ou criar `document_revisions` com:

- numero de revisao;
- `supersedes_document_id`;
- `is_current`;
- hash do conteudo e hash da estrutura de origem;
- `created_by_ingestion_run_id`;
- motivo da revisao.

Reingestao que muda conteudo, conversao ou limites cria nova revisao. Execucao
somente de resumo/notas reutiliza a revisao atual e seus chunks.

### 6.3 Lotes e execucoes

Adicionar `processing_batches` para representar uma acao do usuario sobre um ou
mais itens:

- id, origem/trigger, plano solicitado, politica de reingestao;
- status e progresso agregado;
- timestamps;
- barreira para etapas coletivas, como matching.

Estender `ingestion_runs`:

- `batch_id`;
- `run_kind`: `initial`, `missing_stages`, `reingestion`, `retry_resume`;
- `requested_stages` e `effective_stages`;
- `plan_version`;
- `input_document_revision_id` e hashes de entrada;
- `supersedes_run_id`;
- politica para artefatos anteriores;
- trigger (`interactive_import`, `library_action`, `integration`, `recovery`).

Normalizar estados em `ingestion_run_stages` para permitir consulta eficiente e
historico por etapa, mantendo metadata/checkpoints JSON por etapa. Fazer backfill
dos checkpoints atuais e manter leitura compativel durante a migration.

### 6.4 Geracoes de conhecimento

Adicionar um identificador de geracao aos artefatos derivados, diretamente ou
por tabela `knowledge_generations`:

- fonte alvo e revisao documental;
- tipo de etapa;
- ingestion run/job/AI task run;
- prompt, perfil, modelo, parametros e hashes;
- status atual/superseded;
- vinculo com geracao anterior.

Politicas:

- `source_summaries` ja preserva historico; adicionar geracao e indicador do
  resumo atual;
- atomic notes ganham `generation_id` e estado de supersessao separado da
  revisao humana;
- o `generation_key` nao deve fazer uma nova geracao sobrescrever nota aprovada;
- relacoes e elementos de grafo registram a geracao que os produziu;
- notas aprovadas continuam apontando para a revisao/chunks originais;
- nunca usar `replaceDocumentChunks` sobre chunks que sustentam artefatos
  revisados; criar nova revisao ou reusar chunks pelo hash.

### 6.5 Taxonomia e bibliografia

- adicionar `PeriodicalIssue`, `AcademicPaper` e `DocumentSection` a contratos,
  enum Postgres, repositorios, filtros e i18n;
- revista usa `bibliographic_work.type = publication` e
  `bibliographic_instance.type = issue`, com ISSN, volume, numero e data;
- paper usa DOI e metadados bibliograficos do artigo;
- filhos herdam links bibliograficos relevantes da raiz, mas guardam paginas,
  titulo, autores/byline e identificadores proprios quando existirem;
- capitulos mantem vinculo com o livro e a edicao;
- executar migrations novas; nunca editar migrations ja aplicadas;
- atualizar baseline, manifest e verificacao real conforme `RULES.md`.

## 7. Servicos, contratos e jobs

### 7.1 Servicos propostos

- `DocumentStructureService`: coordena detectores, scoring, revisoes e
  materializacao;
- `EpubStructureDetector`: container, OPF, spine, navigation e seletores;
- `PdfStructureDetector`: outline, page labels, TOC e fusao com Docling;
- `DivisionMaterializationService`: cria/atualiza filhos e documentos derivados
  em transacao;
- `ProcessingPlanService`: valida DAG, resolve presets e calcula etapas efetivas;
- `BatchProcessingService`: cria lotes/runs e coordena barreiras;
- `ArtifactVersioningService`: aplica politicas de reingestao e supersessao.

Detectores devem implementar um contrato comum e permanecer em
`@app/conversion` quando lidarem apenas com estrutura/conversao. Decisoes de
dominio e persistencia ficam nos services do main process e repositorios.

### 7.2 Jobs

Adicionar/ajustar tipos:

- `structure-detection`;
- `division-materialization`;
- `ingestion` orientado por `effectiveStages`;
- jobs de etapa ja existentes continuam filhos da execucao;
- `aggregate-summarization`;
- coordenacao de lote para matching apos geracao de todas as notas.

O supervisor deixa de percorrer incondicionalmente todas as etapas. Para cada
etapa ele deve:

1. consultar o plano efetivo;
2. validar pre-requisitos e hashes;
3. reutilizar artefato valido ou iniciar a etapa;
4. registrar `completed`, `skipped`, `failed` ou `canceled`;
5. invalidar/superseder somente derivados afetados pela politica escolhida;
6. prosseguir para as proximas etapas independentes quando seguro.

### 7.3 IPC e validacao

Novos contratos Zod devem cobrir:

- preview e confirmacao da estrutura;
- edicao de titulo, tipo, nivel e limites;
- presets e selecao de etapas;
- criacao e consulta de lote;
- selecao de fontes/divisoes;
- executar etapas ausentes;
- reingestao e politica de artefatos anteriores;
- arvore da Library e status agregado;
- historico de execucoes/geracoes.

Renderer nunca recebe paths privilegiados nem acessa arquivos diretamente.

## 8. Arquivos grandes e uso de recursos

O fluxo atual usa `readFile()` para carregar o arquivo inteiro e converte o
documento completo antes de persistir. Isso deve mudar para livros e revistas
grandes.

Requisitos:

- importar a partir de path validado/handle controlado pelo main process;
- calcular SHA-256 e copiar o original por streaming;
- executar primeiro uma passagem estrutural barata;
- EPUB: ler somente container/OPF/navigation e entradas XHTML necessarias;
- PDF: ler outline/page labels antes do pipeline de layout;
- processar PDF em intervalos de paginas com `Docling DocumentConverter` e
  `page_range`;
- adicionar `pageStart`/`pageEnd`, limite de bytes e timeout ao protocolo do
  sidecar;
- persistir checkpoint por intervalo e retomar sem reconverter paginas
  concluidas;
- limitar concorrencia de Docling e memoria por processo;
- liberar temporarios e reiniciar o sidecar depois de falha/crash;
- nao manter Markdown, JSON Docling e bytes do original simultaneamente em
  memoria quando puderem ser transmitidos/persistidos;
- mostrar progresso separado para copia, deteccao, OCR, conversao,
  materializacao e processamento de conhecimento;
- arquivos protegidos, corrompidos, com DRM ou limites excedidos geram erro
  recuperavel e nao uma hierarquia parcial silenciosa.

## 9. Experiencia de usuario

### 9.1 Wizard de importacao

Fluxo recomendado:

1. **Arquivo e tipo:** selecionar arquivo; detectar e permitir corrigir
   Livro/Revista/Paper/Outro.
2. **Metadados:** titulo, autores, ISBN/ISSN/DOI, edicao/volume/numero.
3. **Analisando estrutura:** progresso, cancelamento e possibilidade de retomar.
4. **Revisar divisoes:** arvore + preview do documento.
5. **Escolher processamento:** preset ou etapas personalizadas.
6. **Confirmar:** resumo de itens, etapas, modelos/perfis e estimativa qualitativa
   de custo/tempo quando houver provider remoto.
7. **Acompanhar:** abrir o lote em Jobs ou continuar usando a aplicacao.

### 9.2 Tela de revisao das divisoes

Layout:

- esquerda: arvore com checkboxes, nivel, tipo e confianca;
- centro: preview da pagina/XHTML e marcadores de inicio/fim;
- direita: titulo, tipo, limites, evidencias e avisos;
- rodape fixo: contagem de itens, gaps/conflitos e acao de confirmar.

Acoes:

- renomear;
- alterar tipo/nível;
- promover/rebaixar na arvore;
- dividir no heading/pagina/posicao atual;
- unir com anterior/proximo;
- ajustar pagina ou fragmento inicial/final;
- excluir front matter, anuncios ou indice do processamento;
- manter divisao apenas para navegacao;
- promover divisao a item processavel;
- desfazer/refazer durante a sessao;
- restaurar proposta automatica;
- salvar rascunho e continuar depois.

Validacoes visuais:

- overlap em vermelho e confirmacao bloqueada;
- gap em amarelo, permitindo marcar como conteudo ignorado;
- baixa confianca com explicacao;
- divisao vazia ou muito curta com alerta;
- titulo duplicado permitido, mas com contexto/numero de ordem visivel.

### 9.3 Library hierarquica

Lista principal:

- mostra somente raizes por padrao;
- exibe contagem de filhos e progresso agregado (`3/12 resumidos`, `2 com
  erro`, `7 aguardando`);
- filtros podem incluir itens filhos quando solicitado;
- busca encontra filho e mostra breadcrumb ate a raiz.

Detalhe da raiz:

- header e metadados bibliograficos;
- original e revisao estrutural;
- resumo agregado do livro, com progresso dos resumos de capitulos usados;
- arvore/lista de capitulos, artigos ou secoes;
- selecao multipla e toolbar de processamento;
- filtros por etapa/estado;
- historico de lotes e erros;
- acao `Revisar estrutura` com aviso quando ja houver artefatos derivados.

Detalhe do filho:

- breadcrumb para a raiz;
- titulo, ordem, paginas/seletores e preview;
- Markdown, resumo atual e historico;
- notas atomicas e estado de revisao;
- relacionamentos e grafo;
- estado por etapa;
- `Executar etapas`, `Executar ausentes` e `Reingerir`;
- link para abrir o original na pagina/fragmento correspondente.

### 9.4 Processamento posterior e reingestao

Com um ou mais itens selecionados, abrir um dialog que mostre:

- quais etapas ja estao atuais, ausentes, falharam ou ficaram obsoletas;
- preset e checkboxes;
- pre-requisitos incluidos automaticamente;
- perfis/modelos efetivos por tarefa;
- opcao entre reutilizar artefatos validos e forcar regeneracao;
- politica para notas pendentes anteriores;
- impacto estimado e confirmacao.

Depois da confirmacao, criar um `processing_batch`; nao disparar uma chamada IPC
independente por linha selecionada.

### 9.5 Jobs e revisao de notas

- Jobs agrupa por lote e permite expandir item e etapa;
- progresso agregado nunca esconde item com erro;
- cancelar lote solicita cancelamento dos runs ainda ativos;
- retry atua somente nas falhas da mesma execucao;
- a fila de notas mostra breadcrumb da fonte raiz e filtro por capitulo/artigo/
  secao ou lote de geracao;
- resultados superseded nao aparecem por padrao, mas permanecem auditaveis.

### 9.6 Acessibilidade e i18n

- todos os textos entram em `@app/i18n` nos cinco idiomas atuais;
- a arvore segue semantica e teclado de tree view/multiselect;
- confianca nao depende somente de cor;
- dialogs preservam foco, oferecem cancelamento e descrevem impactos;
- preview e marcadores possuem alternativa textual.

## 10. Integracoes e comportamento transversal

### 10.1 Busca

- resultado de filho mostra breadcrumb;
- filtro pela raiz inclui descendentes;
- filtro por capitulo/secao continua possivel;
- embeddings do conteudo pertencem ao item filho para evitar atribuir evidencia
  ao livro inteiro; a raiz pode manter um unico embedding catalografico limitado
  a titulo, criadores, metadados e ao resumo atual da raiz;
- SourceSpan sempre volta ao original e a divisao.

### 10.2 Relacionamentos e grafo

- notas sao criadas no filho;
- a raiz pode projetar no grafo apenas os elementos sustentados pelo seu
  documento catalografico, incluindo o resumo atual quando existir; o conteudo integral nunca e usado nessa projecao
  quando filhos foram selecionados;
- matching continua global por padrao e pode encontrar relacoes entre capitulos
  do mesmo livro e entre fontes diferentes;
- a raiz agrega as relacoes dos descendentes sem duplicar linhas canonicas;
- matching em lote roda depois que todas as novas notas do lote estiverem
  persistidas;
- a UI distingue relacao interna da mesma raiz de relacao externa;
- falha AGE continua degradando sem bloquear matching.

### 10.3 Obsidian

Projecao recomendada:

```txt
Books/<Livro>/index.md
Books/<Livro>/Chapters/<Capitulo>.md
Periodicals/<Revista - edicao>/index.md
Periodicals/<Revista - edicao>/Articles/<Artigo>.md
Papers/<Paper>/index.md
Papers/<Paper>/Sections/<Secao>.md
```

Frontmatter deve preservar ids da raiz, filho, divisao e revisao. Renomear ou
reordenar divisao segue as regras existentes de identidade por id, nunca por
path. A implementacao deve definir migration/reconciliacao para arquivos ja
projetados.

### 10.4 Imports nao interativos

Chrome, Obsidian e outros clientes nao podem abrir um dialog no meio de uma
captura. Recomendacao inicial:

- persistir e converter o conteudo;
- aplicar politica configurada por integracao, com default `Importar somente`;
- mostrar o item numa inbox `Aguardando processamento`;
- permitir iniciar etapas pela Library depois.

Uma configuracao futura pode escolher preset por integracao, mas nao deve mudar
o requisito de confirmacao das importacoes iniciadas pela UI desktop.

## 11. Fases de implementacao

### Fase A - Contratos, fixtures e baseline de qualidade

Implementar:

- contratos de estrutura, seletores, evidencias e planos de processamento;
- corpus de EPUB 2/3 e PDFs de livro, revista e paper;
- ground truth versionado para divisoes e paginas;
- metricas de precision/recall de fronteiras e acerto de titulo/tipo;
- fixtures com TOC valido, incompleto, divergente e ausente;
- fixtures escaneadas, multicoluna, numeracao romana e sumario deslocado;
- threat fixtures de EPUB/ZIP.

Pronto quando:

- os contratos estao validados por Zod;
- o corpus cobre casos felizes, ambiguos e hostis;
- existe um baseline mensuravel antes de alterar detectores.

### Fase B - Pipeline opcional e versionamento seguro

Implementar:

- `ProcessingPlanService` e DAG de dependencias;
- presets de importacao;
- `requestedStages`, `effectiveStages` e `skipped/not_requested`;
- batches e runs por item;
- distincao entre retry, etapas ausentes e reingestao;
- revisoes documentais e geracoes de conhecimento;
- protecao de notas revisadas/chunks historicos;
- migration e backfill dos runs atuais.

Pronto quando:

- `Importar somente` nao cria jobs de IA;
- qualquer combinacao valida executa apenas as etapas efetivas;
- reingestao nao apaga nota aprovada nem evidencia historica;
- runs antigos continuam visiveis.

### Fase C - Importacao grande e extracao estrutural

Implementar:

- copia/hash por streaming;
- analisador EPUB estrutural;
- PDF.js para outline/page labels;
- protocolo Docling v3 com progresso real por pagina, arvore e page range;
- processamento PDF em intervalos com checkpoints;
- `document_structures` e `document_divisions`;
- detectores e scoring comum.

Pronto quando:

- arquivos grandes nao precisam ser integralmente mantidos em memoria;
- EPUB e PDF produzem proposta persistida e retomavel;
- toda divisao possui seletor e evidencia auditavel.

### Fase D - Revisao e materializacao

Implementar:

- wizard e tela de revisao;
- edicao, split, merge, reorder, excluir e promover;
- validacao de gaps/overlaps;
- rascunho persistente;
- materializacao transacional e idempotente;
- novos tipos de fonte e bibliografia.

Pronto quando:

- fechar/reabrir o app preserva a revisao;
- confirmar a mesma estrutura duas vezes nao duplica filhos;
- cada filho abre o trecho correto do original.

### Fase E - Library hierarquica e processamento em lote

Implementar:

- consultas recursivas de raiz/descendentes;
- lista de raizes, breadcrumbs e detalhe hierarquico;
- selecao multipla e filtros por estado;
- dialog de etapas e impacto;
- Jobs agrupado por lote/item/etapa;
- resumo e notas por filho;
- matching com barreira de lote;
- resumo agregado automatico do livro quando todos os capitulos processaveis
  tiverem resumos atuais.

Pronto quando:

- usuario processa qualquer subconjunto de filhos;
- status agregado corresponde aos runs individuais;
- falha em um filho nao invalida os concluidos;
- relacoes entre filhos do mesmo lote podem ser encontradas.
- o resumo do livro e gerado somente depois dos resumos de todos os capitulos e
  fica obsoleto/regenera quando qualquer um deles mudar.

### Fase F - Busca, revisao, Obsidian e hardening

Implementar:

- breadcrumbs e escopo hierarquico na busca;
- filtros hierarquicos na revisao de notas;
- projecao Obsidian em arvore;
- politicas para imports nao interativos;
- acessibilidade e i18n completos;
- telemetria local/debug de detectores, sem conteudo sensivel;
- benchmarks de memoria, tempo, retomada e qualidade;
- smoke tests reais de livro EPUB, livro PDF, revista e paper.

Pronto quando:

- o fluxo funciona end-to-end sem acessar banco ou filesystem pelo renderer;
- todas as operacoes destrutivas exigem confirmacao e sao auditaveis;
- builds e sidecars continuam offline/reproduziveis;
- regressao do pipeline simples permanece coberta.

## 12. Testes obrigatorios

### Unidade

- parser OPF/spine/nav/NCX;
- resolucao de href, fragmento e path;
- PDF outline/page labels;
- parser de sumario e normalizacao de numeros;
- fusao/scoring de evidencias;
- validacao de arvore, overlap e gap;
- DAG e presets de processamento;
- invalidacao e supersessao de artefatos;
- agregacao de status de raiz/lote.
- prontidao, ordenacao e invalidacao de `aggregateSummarization`.

### Integracao

- detector -> revisao -> materializacao -> filhos;
- reabrir rascunho;
- processar selecao parcial;
- adicionar etapas ausentes;
- reingestao com notas pending e approved;
- matching apos barreira do lote;
- resumo do livro criado apenas depois de todos os resumos de capitulos;
- mudanca no resumo de um capitulo tornando o resumo do livro `stale` e
  disparando nova agregacao quando os pre-requisitos estiverem atuais;
- busca da raiz incluindo descendentes;
- abrir evidencia no PDF/EPUB original;
- restart no meio de um intervalo Docling;
- migration de fonte plana existente.

### Banco real

- FKs, indices, constraints e consultas recursivas;
- historico de migration;
- baseline/manifest;
- idempotencia de materializacao;
- concorrencia de dois batches sobre o mesmo item;
- preservacao de evidencias antigas;
- `npm run db:seed:verify`.

### UI e smoke

- estados vazio, analisando, aguardando revisao, parcial, erro e sucesso;
- teclado e screen reader na arvore;
- livro EPUB com capitulos em varios XHTML;
- livro PDF com bookmarks;
- PDF sem bookmarks e com sumario impresso;
- revista com anuncios e materias multicoluna;
- paper com subsecoes, figuras, referencias e apendice;
- importacao somente, processamento posterior e reingestao.

## 13. Observabilidade e auditoria

Registrar sem expor conteudo por padrao:

- versao do detector e formato;
- quantidade de paginas/entradas/divisoes;
- evidencias e scores por candidato;
- alteracoes feitas na revisao;
- plano solicitado e plano efetivo;
- motivos de skip/reuso/invalidation;
- hashes e revisoes de entrada/saida;
- custo, tokens, modelo e parametros das tarefas de IA;
- tempo e pico de memoria por intervalo quando disponivel;
- usuario/acao que confirmou estrutura ou politica destrutiva.

O dashboard de debug pode permitir exportar um relatorio sanitizado para
calibracao dos detectores.

## 14. Questoes de produto ainda abertas

O plano assume as recomendacoes abaixo ate decisao contraria:

1. **Novos tipos de fonte:** adicionar `PeriodicalIssue`, `AcademicPaper` e
   `DocumentSection` em vez de esconder semantica em `metadata`.
2. **Revisao obrigatoria:** exigir confirmacao da estrutura na primeira versao;
   autoaceite de alta confianca fica para depois.
3. **Granularidade:** capitulos/artigos e secoes de primeiro nivel sao itens
   processaveis por padrao; niveis inferiores ficam navegacionais e podem ser
   promovidos.
4. **Notas em reingestao:** preservar revisadas; pedir confirmacao para arquivar
   pendentes superseded; nunca apagar silenciosamente.
5. **Matching:** buscar globalmente por padrao, destacando relacoes internas da
   mesma raiz; oferecer escopo limitado apenas se surgir necessidade real.
6. **Imports externos:** default `Importar somente` e inbox para processamento;
   permitir preset configuravel por integracao depois.
7. **Mudanca estrutural tardia:** criar nova revisao e solicitar reprocessamento
   dos filhos afetados, sem mutar resultados historicos.
8. **DRM/senha:** nao tentar contornar protecao; informar formato protegido e
   permitir nova tentativa quando o usuario fornecer um arquivo acessivel.

O resumo agregado de livros ja esta decidido: ele usa todos os resumos atuais
dos capitulos e so e concluido quando todos os capitulos processaveis estiverem
prontos.

Antes da Fase D, as questoes 1 e 3 devem ser confirmadas porque alteram
taxonomia e navegacao. Antes da Fase B, a questao 4 deve
ser confirmada porque define a migration e o ciclo de vida das notas.

## 15. Referencias tecnicas

- EPUB 3.3: <https://www.w3.org/TR/epub-33/>
- Modelo `DoclingDocument`:
  <https://docling-project.github.io/docling/concepts/docling_document/>
- Chunking hierarquico/hibrido Docling:
  <https://docling-project.github.io/docling/concepts/chunking/>
- `DocumentConverter` e `page_range`:
  <https://docling-project.github.io/docling/reference/document_converter/>
- PDF.js `PDFDocumentProxy`, `getOutline()` e `getPageLabels()`:
  <https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFDocumentProxy.html>

## 16. Criterio global de conclusao

Esta evolucao esta pronta quando um usuario consegue importar um livro, revista
ou paper grande; revisar sua estrutura; optar por nao usar IA; navegar pela
hierarquia; selecionar qualquer subconjunto de filhos; gerar somente os
artefatos desejados; reexecutar etapas com historico e proveniencia; e recuperar
o trabalho depois de falha ou reinicio sem perda silenciosa de conteudo revisado.
