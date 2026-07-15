# ADR 0001: Ingestao de fontes orientada por descriptors tipados

- Status: aceito
- Data: 2026-07-15
- Escopo: desktop, dominio, conversao e persistencia

## Contexto

O fluxo anterior combinava tipo, titulo, conteudo e um pequeno conjunto de
campos bibliograficos em um formulario plano. Metadados extraidos por arquivo,
Defuddle e YouTube ficavam em JSON generico; livros, periodicos e papers nao
podiam existir como containers sem documento; enriquecimento externo e decisao
de duplicata nao faziam parte do contrato de ingestao.

O banco nao continha dados de usuario durante esta mudanca. Portanto, nao foi
necessario manter o payload legado nem executar backfill de metadata existente.

## Decisao

1. `SourceDescriptorSchema` e uma union discriminada pelos 11
   `SourceItemType`. Todo ingresso novo no desktop usa um descriptor completo,
   validado por Zod no preload e no main process.
2. Criadores sao arrays JSONB estruturados em obras e instancias
   bibliograficas. Nao existe tabela de pessoas nesta fase.
3. O descriptor canonico fica em `source_items.metadata.descriptor`; campos de
   obra/edicao tambem sao projetados para as tabelas bibliograficas. Essa
   duplicacao e deliberada: o descriptor preserva o contrato de entrada e as
   tabelas normalizadas sustentam lookup e relacionamentos.
4. Cada campo registra proveniencia `manual`, `extracted` ou `enriched`.
   Valores manuais nao sao sobrescritos por aplicacao automatica. Substituir um
   valor extraido por um candidato enriquecido exige acao explicita do usuario.
5. A selecao de arquivos e todo acesso a paths permanecem no main process. O
   renderer recebe somente um token UUID temporario, nome, MIME type e draft de
   metadata; o token expira e nunca revela o path local.
6. Rede de enriquecimento existe apenas no main process, por adapters Open
   Library, Google Books e Crossref. O recurso tem opt-out global, timeout,
   cache local, falha nao bloqueante e allowlist HTTPS separada para capas.
7. `Book`, `PeriodicalIssue` e `AcademicPaper` podem ser persistidos sem
   `documents` e `ingestion_runs`. Processamento e projecao ignoram o container
   em si e operam sobre descendentes quando o escopo pedir.
8. A revisao estrutural apresenta um unico conceito: criar sub-elemento. Os
   campos internos `isProcessable` e `reviewStatus` continuam existindo para a
   persistencia, mas sao atualizados juntos pela UI.
9. Duplicatas sao verificadas por URI/hash e, em seguida, por tipo com titulo
   ou identificadores. O usuario escolhe manter, atualizar ou criar versao.

## Consequencias

- O contrato IPC ficou mais estrito e nao aceita o formato legado do formulario.
- Containers exigem que Library, processamento, exclusao e Obsidian tolerem a
  ausencia de documento.
- Capas podem existir temporariamente sem `source_item_id` enquanto o wizard
  esta aberto; ao confirmar, o asset e vinculado a fonte e ao documento quando
  houver.
- APIs publicas melhoram catalogacao, mas seus resultados continuam sugestoes;
  indisponibilidade de rede degrada para preenchimento manual.
- Metadados de criadores de sub-elementos ficam no descriptor do filho; o
  vinculo bibliografico herda obra/instancia e paginas do container.

## Alternativas rejeitadas

- manter `metadata` sem schema: nao permite formulario, merge e validacao
  previsiveis;
- normalizar pessoas agora: adicionaria identidade/deduplicacao de autores sem
  necessidade para o fluxo atual;
- acessar arquivos ou APIs no renderer: violaria a fronteira de seguranca do
  Electron;
- criar documento vazio para container: misturaria entidade de catalogacao com
  conteudo processavel e produziria runs sem evidencia.
