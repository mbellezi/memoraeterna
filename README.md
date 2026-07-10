# Memora Eterna

Memora Eterna e uma aplicacao desktop local-first para organizar fontes,
documentos, notas, evidencias e memoria de longo prazo. A aplicacao desktop e a
fonte de verdade local: ela gerencia o banco PostgreSQL embarcado, o pipeline de
ingestao/indexacao e as integracoes com Chrome e Obsidian.

O MVP usa um monorepo TypeScript com Electron, React, Tailwind, Drizzle e
PostgreSQL nativo como sidecar.

A espinha dorsal implementada permite inserir conteudo manual, importar
formatos textuais, acompanhar jobs retomaveis, preservar assets, gerar chunks
com proveniencia e buscar evidencias por texto ou por combinacao textual e
vetorial quando um perfil de embedding esta configurado.

## Estrutura

```txt
apps/
  desktop/             Aplicacao Electron com renderer React e preload seguro
  chrome-extension/    Extensao Chrome isolada
  obsidian-plugin/     Plugin Obsidian isolado
packages/
  ai/                  Adaptadores e contratos internos de IA
  conversion/          Conversao e normalizacao de conteudo
  db/                  Schema, migrations, repositorios e sidecar Postgres
  domain/              Tipos canonicos e schemas Zod
  i18n/                Locales e helpers de traducao
  integration-contracts/
```

## Prerequisitos

- Node.js `24.18.0` LTS.
- npm `11.16.0`.
- macOS com Xcode Command Line Tools para instalar/buildar o sidecar:

```bash
xcode-select --install
```

As versoes canonicas ficam em `docs/stack-versions.md`. O `package.json` raiz
tambem declara os engines esperados.

## Bootstrap DEV Inicial

Instale dependencias do monorepo:

```bash
npm install
```

Crie os `.env` locais e instale o sidecar PostgreSQL para desenvolvimento:

```bash
npm run setup:dev
```

Esse comando executa:

- `scripts/setup-dev-env.mjs`, que cria `.env` e `apps/desktop/.env` com
  variaveis aleatorias de banco quando ainda nao existem;
- `scripts/install-postgres-sidecar.mjs`, que instala o PostgreSQL sidecar em
  `vendor/sidecars/...`.

Para regenerar credenciais DEV:

```bash
npm run setup:env -- --force
```

Para instalar apenas o sidecar, preservando os `.env` existentes:

```bash
npm run sidecar:install:postgres
```

## Sidecars

O sidecar DEV instala:

- PostgreSQL `18.4`;
- pgvector `0.8.4`;
- Apache AGE `PG18/v1.7.0-rc0`.

Em desenvolvimento, os binarios ficam em:

```txt
vendor/sidecars/postgres/darwin-{arch}/postgresql-18.4/
```

Essa pasta e ignorada pelo Git. Em producao, o app empacotado deve copiar os
artefatos para:

```txt
resources/
  sidecars/
    postgres/
      darwin-arm64/
        postgresql-18.4/
  drizzle/
```

No runtime Electron, o banco sobe junto com a aplicacao. A janela abre com uma
tela de bootstrap, o main process inicia o sidecar em loopback usando
`MEMORA_DATABASE_PORT` quando disponivel; se a porta estiver invalida ou
indisponivel, registra warning e cai para uma porta dinamica livre. Depois,
prepara o banco e so libera a shell quando ele esta pronto. Em banco
Postgres totalmente vazio, o bootstrap aplica o seed/baseline versionado,
registra no historico Drizzle as migrations cobertas por esse baseline e entao
roda migrations pendentes. Em banco existente, o bootstrap roda apenas
migrations pendentes. O shutdown do app aguarda o pool e o sidecar encerrarem.

As credenciais dos `.env` sao para scripts e fluxos DEV. O runtime do desktop
gera credenciais por instalacao e guarda a senha via Electron `safeStorage`.

Valide o sidecar instalado:

```bash
npm run sidecar:spike
```

O spike cria um data dir temporario, sobe o Postgres, habilita `vector` e `age`,
executa consultas triviais e encerra o processo.

## Compilar e Validar

Typecheck:

```bash
npm run typecheck
```

Testes:

```bash
npm test
```

Build:

```bash
npm run build
```

Format check:

```bash
npm run format:check
```

Fluxo completo recomendado depois do bootstrap:

```bash
npm run typecheck
npm test
npm run build
npm run format:check
npm run sidecar:spike
```

## Rodar o Desktop em DEV

```bash
npm run dev -w @app/desktop
```

Durante o boot, a UI mostra o estado do banco local. Se o sidecar ainda estiver
subindo ou aplicando migrations, a shell principal permanece bloqueada com
spinner.

Preferencias de interface ficam nos settings locais. Antes de existir uma
preferencia salva, o idioma inicial vem do desktop com fallback para ingles, e
o tema inicial e escuro. O cabecalho do menu lateral tem um botao de alternancia
rapida entre tema escuro e claro.

## Banco e Migrations

Gerar migration depois de alterar schema Drizzle:

```bash
npm run db:generate
```

Depois de gerar uma migration nova, mantenha o baseline sincronizado na mesma
mudanca:

- atualize `packages/db/seed/baseline.sql` com o SQL coberto pelo baseline, na
  ordem de `packages/db/drizzle/meta/_journal.json`;
- atualize `packages/db/seed/manifest.json` incluindo a nova migration em
  `includedMigrations`;
- valide a sincronizacao:

```bash
npm run db:seed:verify
```

Aplicar migration usando `MEMORA_DATABASE_URL` do `.env`:

```bash
npm run db:migrate
```

Verificar migration no banco real:

```bash
npm run db:verify
```

Sincronizar mecanicamente o baseline com o journal e validar as Fases 2 e 3 em
um sidecar temporario real:

```bash
npm run db:seed:sync
npm run db:seed:verify
npm run db:phase2:verify
npm run db:phase3:verify
```

Toda mudanca de schema deve ser validada no banco real, incluindo historico em
`drizzle.__drizzle_migrations` e estrutura esperada em `information_schema` ou
consulta equivalente.

O seed/baseline versionado existe apenas para acelerar e padronizar a criacao
de bancos Postgres totalmente vazios. Ele deve acompanhar as migrations que
cobre: ao alterar uma migration estrutural incluida no baseline, atualize tambem
o baseline e a lista/historico de migrations cobertas. Bancos existentes nunca
devem receber o seed por cima; seguem somente pelo fluxo de migrations
pendentes. Inicialmente o seed pode conter apenas estrutura, sem dados de
dominio.

## Notas Importantes

- Nao commitar `.env`, `apps/*/.env`, `.cache/` ou `vendor/sidecars/`.
- O renderer nunca acessa banco, filesystem privilegiado ou segredos
  diretamente; tudo passa por preload seguro e IPC validado por Zod.
- `MAPA.md` mantem o mapa operacional inicial para agentes e deve ser
  atualizado quando a estrutura ou fluxos centrais mudarem.
- O empacotamento final para macOS ainda precisa copiar `resources/sidecars/...`,
  `resources/drizzle/` e `resources/db-seed/`, alem de cuidar de
  assinatura/notarizacao dos binarios nativos.
- O bridge Docling esta implementado, mas o bundle CPython/Docling/modelos por
  plataforma ainda precisa ser produzido e verificado. Consulte
  `docs/docling-sidecar.md`.
