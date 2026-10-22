# Evidências de 22/10/2026

Relatórios JSON aprovados e auditorias npm são versionados. Logs brutos, screenshots, traces, perfis do navegador e dados PostgreSQL temporários permanecem apenas locais, ignorados pelo Git e sem envio à VPS. O histórico de 21/10 não foi apagado; os resumos/hashes estão preservados.

- `preflight.json`: HEADs iniciais, hashes históricos e gate de publicação.
- `resumo-execucao.json`: contagens, limites de evidência, códigos de saída e prova de locks.
- `candidate-source-hashes.json`: arquivos fonte/schema/tests/lockfiles candidatos.
- `api-unit-final.json`, `api-e2e-final.json`: suítes completas após patches e correções.
- `native-final.json`: 17 cenários nativos e 24 de backfill, sem mocks de banco ou PostgreSQL embutido.
- `web-playwright.json`: 114 testes em três viewports; transporte de API simulado.
- `*audit*.json`: resultado antes/depois, runtime e árvore completa.

Runner: `KALEND_PG_BIN=/caminho/postgresql/16/bin npm run test:native`. LD_LIBRARY_PATH pode ser necessário quando os binários vêm de pacotes extraídos. Usa somente novo cluster temporário, banco de prefixo reservado e marcador proprietário. Recusa outro host, usuário ou cluster; não lê DATABASE_URL. Encerra o cluster ao concluir e retém dados/logs locais para inspeção.

PostgreSQL 16.15 foi obtido de pacotes oficiais apt.postgresql.org para Debian 12 e extraído em /tmp, sem instalar serviço ou editar repositórios apt. SHA256 dos pacotes foi confrontado com o índice Packages. O runner usa portas dinâmicas, usuário sintético kalend_audit e pools de até 6 conexões. A asserção pg_blocking_pids comprova duas sessões independentes com disputa efetiva por FOR UPDATE. Não é teste de carga nem certificação de qualquer corrida possível.
