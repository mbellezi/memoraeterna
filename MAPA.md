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

Fase atual: Fase 1 - Fundacao.

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

Pendencias conhecidas:

- empacotamento final macOS ainda precisa copiar `resources/sidecars/...` e
  `resources/drizzle/` e `resources/db-seed/`;
- assinatura/notarizacao dos binarios nativos ainda nao foi configurada;
- builds AGE para Windows e Linux estao fora do escopo inicial;
- o shell local usado nesta sessao ainda reportou Node 22/npm 10, embora o
  baseline do repo seja Node 24.18/npm 11.16.

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
- `src/preload/index.ts`: API segura exposta em `window.app`.
- `src/shared/ipc.ts`: canais, schemas Zod e tipos compartilhados do IPC.
- `src/renderer/App.tsx`: shell React, bootstrap do banco e navegacao inicial.
- `src/renderer/components/SettingsView.tsx`: UI inicial de settings.
- `electron.vite.config.ts`: build Electron/Vite.

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

Estrutura isolada da extensao Chrome. Deve depender apenas de contratos seguros,
principalmente `@app/integration-contracts`. Nao pode acessar o banco nem codigo
do main process.

### `apps/obsidian-plugin`

Estrutura isolada do plugin Obsidian. Deve se comunicar com o desktop por
contratos versionados. Nao pode acessar diretamente o banco local.

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

Contratos externos seguros para extensao Chrome, plugin Obsidian e desktop
gateway futuro. Deve conter apenas schemas, eventos e tipos seguros.

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

Base inicial para tipos/adaptadores de IA. Deve permanecer fora do renderer e
fora das apps externas quando incluir runtime ou segredos.

### `packages/conversion`

Base inicial para conversao/normalizacao. Nao deve acessar banco diretamente;
services de aplicacao persistem resultados via `@app/db`.

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
```

Validacao:

```bash
npm run typecheck
npm test
npm run build
npm run format:check
```

Desktop DEV:

```bash
npm run dev -w @app/desktop
```

## Documentacao de Referencia

- `docs/initial.md`: especificacao ampla do produto e arquitetura.
- `docs/mvp-implementation-plan.md`: fases e criterios de pronto.
- `docs/stack-versions.md`: matriz canonica de versoes.
- `docs/postgres-sidecar-age-spike.md`: reproducao e status do sidecar
  Postgres/pgvector/AGE.
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
