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

O source bridge e os testes de contrato/crash/timeout/cancelamento estao
versionados. O bundle por plataforma ainda nao existe no repositorio local. A
proxima acao de distribuicao deve produzir os artefatos, preencher
`runtime-manifest.json` com origem, licencas, checksums e SBOM reais e executar
o corpus golden/benchmarks de PDF, Office, EPUB, OpenDocument e imagens. Nao se
deve preencher checksums ou afirmar suporte de formato antes dessa validacao.
