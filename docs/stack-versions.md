# Memora Eterna - Versoes da Stack

Auditoria: 2026-07-05.

Este arquivo e a fonte canonica de versoes para criar ou atualizar manifests, lockfiles, imagens, binarios sidecar e scripts de build. Quando a ultima versao publicada conflitar com compatibilidade real da stack, prevalece a versao estavel compativel indicada aqui.

## Politica de Atualizacao

- Usar versoes exatas no bootstrap inicial do MVP para manter builds reproduziveis.
- Preferir LTS/Stable para runtime e componentes nativos.
- Registrar em PRs futuros qualquer desvio desta matriz com motivo, fonte e teste de compatibilidade.
- Atualizar Postgres major apenas com plano explicito de migracao de dados.
- Manter `npm` como package manager inicial, porque os scripts do projeto ja usam `npm run ...`.

## Runtime e Tooling

| Componente | Versao alvo | Observacoes |
| --- | --- | --- |
| Node.js | `24.18.0` LTS `Krypton` | Baseline do repo. Atende ao requisito de TypeScript nativo por type stripping estavel e fica alinhado ao Electron 43, que embute Node `24.17.0`. Node `26.4.0` e a linha Current, mas nao e o baseline enquanto Electron/dependencias nativas estiverem em Node 24. |
| npm | `11.16.0` | Versao empacotada com Node `24.18.0`. |
| TypeScript | `6.0.3` | Usar `tsc` para typecheck/build. Para scripts executados diretamente pelo Node, limitar a sintaxe a TypeScript erasable. |
| `@types/node` | `24.13.2` | Fixar na linha 24 para refletir o runtime alvo e o Node embutido no Electron. |
| `tsx` | `4.23.0` | Opcional para scripts que precisarem de suporte TypeScript completo alem do type stripping nativo do Node. |
| Vitest | `4.1.9` | Test runner inicial para pacotes e apps. |

Configuracao esperada no `package.json` raiz quando o monorepo for criado:

```json
{
  "packageManager": "npm@11.16.0",
  "engines": {
    "node": ">=24.18.0 <25",
    "npm": ">=11.16.0 <12"
  }
}
```

Para scripts executados diretamente com `node arquivo.ts`, usar imports com extensao, `type` imports explicitos e evitar `enum`, decorators, parameter properties, paths aliases de `tsconfig` e TSX. O app continua sendo compilado/bundled por TypeScript + `electron-vite`.

## Desktop, Frontend e Build

| Componente | Versao alvo | Observacoes |
| --- | --- | --- |
| Electron | `43.0.0` | Latest stable auditado; embute Chromium `150.0.7871.46` e Node `24.17.0`. |
| `electron-vite` | `5.0.0` | Latest stable auditado. |
| Vite | `7.3.6` | Vite `8.1.3` existe, mas fica pendente porque `electron-vite@5.0.0` declara peer compatibility apenas para Vite 5/6/7. |
| `@vitejs/plugin-react` | `5.2.0` | Versao compativel com Vite 7 e React 19. |
| `@swc/core` | `1.15.43` | Peer usado por `electron-vite`. |
| React | `19.2.7` | Linha obrigatoria do renderer. |
| `react-dom` | `19.2.7` | Mesma linha do React. |
| `@types/react` | `19.2.17` | Tipos da linha React 19. |
| `@types/react-dom` | `19.2.3` | Tipos da linha React DOM 19. |
| Tailwind CSS | `4.3.2` | Linha obrigatoria de CSS. |
| `@tailwindcss/vite` | `4.3.2` | Plugin Tailwind para Vite. |
| `shadcn` CLI | `4.13.0` | `shadcn/ui` gera componentes vendorizados; nao tratar como dependencia runtime de UI. |
| `lucide-react` | `1.23.0` | Icones padrao da UI. |
| `electron-builder` | `26.15.3` | Baseline para empacotamento se usado no MVP. |
| `@electron/notarize` | `3.1.1` | Baseline para notarizacao macOS se usado no MVP. |

## Web App Opcional

Next.js nao faz parte da stack obrigatoria do MVP desktop. Se um app web separado for pedido explicitamente, usar:

| Componente | Versao alvo | Observacoes |
| --- | --- | --- |
| Next.js | `16.2.10` | Compativel com React 19 e Node 24 LTS. Nao substituir `apps/desktop` nem introduzir Next no renderer Electron sem decisao arquitetural explicita. |

## Banco, Vetores e Grafo

| Componente | Versao alvo | Observacoes |
| --- | --- | --- |
| PostgreSQL sidecar | `18.4` | Major estavel atual. Major upgrades exigem plano explicito de migracao. |
| `pgvector` | `0.8.4` | Compilar/empacotar junto aos binarios do sidecar. |
| Apache AGE | `PG18/v1.7.0-rc0` | Alvo explicito do spike macOS com PostgreSQL 18. Como ainda traz sufixo `rc0`, a Etapa 0.5 deve validar build, `CREATE EXTENSION age`, query Cypher trivial e ciclos start/stop antes de qualquer dependencia de produto. Consultas de grafo devem degradar para CTEs recursivas quando AGE nao estiver disponivel ou falhar na plataforma. |
| `pg` (`node-postgres`) | `8.22.0` | Cliente Postgres para `@app/db`. |
| `@types/pg` | `8.20.0` | Tipos para `pg`. |
| Drizzle ORM | `0.45.2` | ORM e query builder. |
| Drizzle Kit | `0.31.10` | Geracao de migrations. |
| `drizzle-zod` | `0.8.3` | Usar somente onde simplificar contratos Drizzle/Zod. |
| Zod | `4.4.3` | Contratos entre processos, workers e integracoes. |

`postgres-vector-embedded` citado nos documentos arquiteturais deve ser tratado como conceito/artefato de sidecar a validar na Etapa 0.5, nao como dependencia npm publica: o pacote nao existe no registro npm auditado em 2026-07-05. O spike deve fixar a origem real dos binarios, checksums e processo de reproducao.

## Conversao, Captura e IA Local

| Componente | Versao alvo | Observacoes |
| --- | --- | --- |
| Defuddle | `0.19.1` | Extracao primaria de paginas web. |
| `markitdown-ts` | `0.0.10` | Conversao primaria de arquivos locais/anexos. |
| `youtubei.js` | `17.2.0` | Metadados e transcricoes de YouTube quando disponiveis. |
| `node-llama-cpp` | `3.19.0` | Apenas main process ou workers controlados pelo main process. |

## Fontes Auditadas

- Node.js releases e suporte TypeScript nativo: `https://nodejs.org/dist/index.json`, `https://nodejs.org/api/typescript.html`, `https://nodejs.org/en/blog/release/v24.18.0`.
- Electron release `43.0.0`: `https://releases.electronjs.org/release/v43.0.0`.
- PostgreSQL versioning: `https://www.postgresql.org/support/versioning/`.
- `pgvector` tags: `https://api.github.com/repos/pgvector/pgvector/tags`.
- Apache AGE releases/tags: `https://api.github.com/repos/apache/age/releases/latest`, `https://api.github.com/repos/apache/age/tags`.
- Pacotes npm: `npm view <pacote> version`, `npm view <pacote> dist-tags`, `npm view <pacote>@<versao> peerDependencies engines`.
