# Publicação integral pendente — 24/10/2026

Estado: preparação local validada; push não executado. Fetch origin concluído nos dois repositórios. Sem divergência: API 13 à frente/0 atrás antes do commit desta revisão; Web 4 à frente/0 atrás.

## Commits locais anteriores à revisão

### kalend-api

```text
6475fe8 feat(billing): preserve entitlement evidence and validate native concurrency
34e4261 chore(security): patch Prisma and local test dependencies
36a1370 test(billing): cover concurrent native chargeback and refund
fc1e6da docs: record native validation and remaining DEV homologation gates
6251f50 chore(release): prepare restricted DEV access and backfill audit
1cfd974 chore(security): prepare dedicated DEV audit public key and validation
dae83ea docs(qa): record real DEV legacy classification and verified backup restore
ff18655 fix(billing): retry concurrent webhook event registration
db18266 test(release): rehearse PaymentEvidence on isolated DEV snapshot
5f58274 ops(dev): prepare isolated release controls and supervised runbook
2794d93 docs(release): record authorized execution blocked by GitHub administration access
52a704c docs(release): verify existing Actions isolation and refresh DEV backup evidence
40297b3 ci(dev): restore existing Actions deployment and record execution policy
```

### kalend-web

```text
525382d test: align recovery coverage with approved interface
5c7bf8c chore(security): patch Next and vulnerable runtime transitives
d1b549d ci(dev): replace automatic deployment with inert manual gate
bbb668b ci(dev): restore existing develop deployment workflow
```

## Arquivos locais incluídos no commit de preparação

- `docs/homologacao/RELEASE_DEV_CONTROLADA.md`
- `docs/homologacao/SUPER_ADMIN_MATRIZ.md`
- `docs/homologacao/SUPER_ADMIN_STATUS.md`
- `docs/homologacao/evidencias/.gitignore`
- `docs/homologacao/evidencias/2026-10-22-revisao-administrativa/backup-roundtrip.json`
- `docs/homologacao/evidencias/2026-10-22-revisao-administrativa/files-sha256.json`
- `docs/homologacao/evidencias/2026-10-22-revisao-administrativa/hba-local.json`
- `docs/homologacao/evidencias/2026-10-22-revisao-administrativa/native-nonsuper.json`
- `docs/homologacao/evidencias/2026-10-22-revisao-administrativa/readonly-guard-final.json`
- `docs/homologacao/evidencias/2026-10-22-revisao-administrativa/resumo-execucao.json`
- `docs/homologacao/evidencias/2026-10-22-revisao-administrativa/sshd-local.json`
- `docs/homologacao/evidencias/2026-10-23-pacote-auditor/README.md`
- `docs/homologacao/evidencias/2026-10-23-pacote-auditor/resumo.json`
- `docs/homologacao/evidencias/2026-10-23-pacote-auditor/sql-restrito.json`
- `docs/homologacao/evidencias/2026-10-23-pacote-auditor/static.json`
- `docs/homologacao/evidencias/2026-10-23-preflight-final/preservation.json`
- `docs/homologacao/evidencias/2026-10-23-preflight-final/remote-top-include.json`
- `docs/homologacao/evidencias/2026-10-23-preflight-final/remote.json`
- `docs/homologacao/evidencias/2026-10-23-preflight-final/resumo.json`
- `docs/homologacao/evidencias/2026-10-23-preflight-final/sudo-model.json`
- `docs/homologacao/release-controlada/DEPENDENCIAS_CLOUDPANEL.md`
- `docs/homologacao/release-controlada/INTERVENCAO_ADMINISTRATIVA.md`
- `docs/homologacao/release-controlada/PREFLIGHT_FASE_A_2026-10-23.md`
- `docs/homologacao/release-controlada/SANDBOX_RESTORE.md`
- `docs/homologacao/release-controlada/SHA256SUMS`
- `docs/homologacao/release-controlada/authorized_keys.example`
- `docs/homologacao/release-controlada/backfill-audit.sql`
- `docs/homologacao/release-controlada/backup-role.sql`
- `docs/homologacao/release-controlada/check-audit-files.py`
- `docs/homologacao/release-controlada/kalend-dev-audit`
- `docs/homologacao/release-controlada/kalend-dev-release-gate`
- `docs/homologacao/release-controlada/pg_hba-backup.fragment.conf`
- `docs/homologacao/release-controlada/pg_ident-backup.fragment.conf`
- `docs/homologacao/release-controlada/readonly-role.sql`
- `docs/homologacao/release-controlada/sshd-audit.fragment.conf`
- `docs/homologacao/release-controlada/sudoers-audit-only.conf`
- `docs/homologacao/release-controlada/sudoers-dev-only.conf`
- `scripts/test-native-postgres.mjs`
- `scripts/tests/review_audit_static.py`
- `scripts/tests/review_backup_roundtrip.py`
- `scripts/tests/test_audit_file_permissions.py`
- `scripts/tests/test_release_access_templates.py`
- `test/release-access.native.ts`
- `docs/homologacao/PUBLICACAO_PENDENTE_2026-10-24.md` (este relatório)

## Preservados fora da publicação

- Cópia histórica não commitada INTERVENCAO_ADMINISTRATIVA_V1_HISTORICO.md; evidência histórica files-sha256.json pode mencionar seu hash, sem incorporar a cópia.
- Caches __pycache__, backups, dados de clusters temporários, logs brutos, .env e chaves privadas permanecem locais.
- Web começou e terminou sem alterações locais de fonte.

## Validação

- Node 24.21.0. API: 55 arquivos/881 testes aprovados; build aprovado.
- PostgreSQL 16 local efêmero: 3 arquivos/42 testes aprovados; conexões de teste NOSUPERUSER; cluster encerrado normalmente.
- Python: 45 testes aprovados. Manifesto SHA256SUMS: 22/22 arquivos iguais.
- Web: 19 testes aprovados; build webpack aprovado, reproduzindo a modalidade do Actions.
- git diff --check aprovado; git fsck sem corrupção (objetos dangling preservados).
- Workflows idênticos a origin/develop: push em develop, deploy automático preservado. Nenhum script de reset foi executado nesta sessão.
- Revisão por padrões de chave privada/tokens/URLs nos arquivos dos commits pendentes e arquivos locais: achados de chave falsa e URLs com senhas de testes confirmados como fixtures. Essa inspeção não equivale a uma garantia absoluta de ausência de segredos.

## Consulta atual da VPS, somente leitura

- Host srv1119527; consulta administrativa uid 0, sem alteração de configuração ou dados comerciais.
- API DEV instalada: b1cc220aafcb1f2fef97c026150795fcd5c88906.
- Web DEV instalado: 4d86829b81737189503eb8b1859477e708dcdb12.
- DATABASE_URL da API: banco kalend_dev, identidade kalend; senha/URL não impressas.
- Role kalend: NOSUPERUSER/NOCREATEROLE/CREATEDB/NOBYPASSRLS; proprietária de kalend e kalend_dev. Logo, NÃO atende ao requisito de ausência de privilégio em PROD.
- Nenhuma role kalend_dev_migrator encontrada na consulta; nenhuma migration com evidence no nome no ledger DEV. PaymentEvidence ainda não aplicada no ledger consultado.
- sudo -l confirma clpctlWrapper permitido para kalend-dev e kalend-api-dev.

## Bloqueios reais para publicação

1. Comprovar recuperação administrativa independente antes de alterar permissões (pergunta enviada ao proprietário).
2. Preparar/aprovar intervenção específica que elimine o caminho administrativo das identidades DEV, após inventário das dependências CloudPanel, sem mudar PROD ou regras globais.
3. Provisionar e comprovar identidade de migration restrita a kalend_dev; bloquear uso da credencial compartilhada pelo DEV sem retirar privilégios de PROD.
4. Comprovar identidade efetiva do SSH usado pelo Actions e compatibilidade do fluxo automático preservado com os controles instalados.
5. Revalidar backup/classificação na janela final, obter aprovação interativa de publicação e então push API, push Web, acompanhar Actions, verificar SHAs/migration e homologar DEV.

Não houve push, migration real, deploy, restart, reload ou escrita administrativa remota. PROD foi preservada por ausência dessas operações; não se afirma isolamento efetivo ainda inexistente. Nenhuma versão candidata foi homologada em DEV nesta execução.


## Política vigente — sessão Full Access, 24/10/2026

Publicação DEV autorizada sem dependência de botão Yes; política atual em
[POLITICA_EXECUCAO_KALEND.md](../POLITICA_EXECUCAO_KALEND.md). O impedimento não é
aprovação interativa. Preflight encontrou HEAD API e6664fd e Web bbb668b; 14/4
commits pendentes revisados, ancestralidade dos HEADs remotos preservada e workflows
finais idênticos ao fluxo remoto existente. Varredura dos blobs alterados não
identificou material privado pelos padrões verificados; único marcador de chave
privada era fixture negativa de 41 caracteres, sem chave. Isso não é garantia
universal de ausência de secrets. Trabalho consolidado e arquivos não rastreados
anteriores preservados.

28 testes operacionais/permissões passaram; testes de chave pública executados
separadamente. Nenhuma bateria financeira foi repetida. Consulta atual READ ONLY
confirmou banco kalend_dev com role/owner kalend, também proprietária de PROD.
Sudo efetivo ainda permite clpctlWrapper aos usuários DEV e ALL a clp. Os quatro
endpoints DEV/PROD retornam 200. Não houve push, migration, deploy ou alteração
administrativa remota. Para prosseguir falta executar a intervenção DEV delimitada
com recuperação independente verificável e autorização administrativa correspondente,
validar isolamento SQL/sudo efetivo e atestar a identidade SSH real do CI. Full
Access não substitui esses controles. Não desativar workflows.
