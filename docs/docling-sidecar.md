# Sidecar Docling

O codigo de integracao da Fase 2 fica em `packages/conversion` e preserva a
fronteira TypeScript-first do projeto. Python e usado apenas pelo bridge
`packages/conversion/sidecar/docling_sidecar.py`.

## Layout esperado

Em desenvolvimento:

```txt
vendor/sidecars/docling/<platform>/
  bin/python3.13          # `python.exe` no Windows
  ... runtime CPython 3.13.13, wheels e modelos locais
```

No app empacotado:

```txt
resources/
  sidecars/docling/<platform>/
  docling/docling_sidecar.py
```

O runtime deve conter CPython `3.13.13`, Docling `2.111.0`, wheels e modelos
resolvidos no build. O app nunca usa o Python do sistema e nunca executa
`pip install` no runtime.

## Protocolo

- um objeto JSON versionado por linha em stdin/stdout;
- `protocolVersion: 1`;
- request e response validados por Zod em `docling-contracts.ts`;
- nenhuma porta de rede;
- timeout, cancelamento e encerramento do processo pelo `DoclingClient`;
- resultado com Markdown, blocos, pagina, bounding box, offsets, warnings,
  qualidade e `DoclingDocument` bruto quando disponivel.

Temporarios sao criados sob `userData/tmp/conversion` e removidos em sucesso,
erro ou cancelamento. O JSON estruturado retornado e persistido como asset
derivado pelo `IngestionService`.

## Estado do artefato

O builder versionado materializa atualmente `darwin-arm64`. Ele baixa uma
distribuicao CPython imutavel e verifica seu SHA-256, instala exclusivamente as
versoes de `requirements-darwin-arm64.lock` e pre-baixa os modelos em revisions
fixadas. O conjunto RapidOCR vem da versao fixada do pacote `rapidocr`.

```bash
npm run docling:build
npm run docling:verify
npm run docling:smoke
```

`docling:smoke` cria e converte um PDF com os proxies apontados para loopback
invalido e com os modos offline de Hugging Face/Transformers ativos. Assim, o
teste usa somente o CPython, wheels e modelos do sidecar. Para atualizar o
artefato, revise primeiro a definicao e o lock e execute
`npm run docling:build -- --force`; para remover o artefato gerado, use
`npm run docling:remove`. Nenhuma dessas operacoes acontece no runtime do app.

O builder grava um manifesto do runtime com origem do CPython, hash do lock,
pacotes, revisions dos modelos, tamanhos e hashes agregados. O staging desktop
valida novamente todos os arquivos e incorpora os componentes ao SBOM SPDX.

O corpus golden amplo e os benchmarks de todos os formatos continuam como
validacao de distribuicao. Os artefatos Windows/Linux devem ser adicionados
somente com origem, locks e testes equivalentes; nao ha fallback para Python do
sistema.
