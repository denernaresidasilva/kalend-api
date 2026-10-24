# Restauração do fluxo automático — 24/10/2026

Política simplificada pelo proprietário: desenvolvimento/Git/publicação DEV não
exigem instalar a arquitetura histórica inteira nem comprovar console independente.
O gate de recuperação continua pertinente a alterações administrativas de acesso.
Histórico integral preservado; documentos antigos não são gates cumulativos.

Workflows mantidos ativos por push em develop, mesmo SSH/Node/npm/Prisma/build/PM2.
Correções técnicas: guards hostname/usuário DEV em ambos; API usa configuração
Prisma exclusiva da migration e preflight SQL antes do DDL. Sem deploy manual.

Provisionada kalend_dev_migrator sem privilégios administrativos/memberships e
proprietária apenas de kalend_dev/objetos DEV. HBA permite somente TCP loopback a
kalend_dev para essa role e rejeita outros bancos. Credencial nova permanece na
.env privada DEV; DATABASE_URL runtime e PROD não foram alterados. Grants CRUD e
default privileges DEV preservam o runtime após a transferência de ownership.
Backup/ownership/configurações anteriores guardados sob root, sem exclusões.
Nenhuma mudança de SSH/sudoers/firewall, reinício global ou operação em PROD.

O caminho sudo CloudPanel e a credencial runtime compartilhada continuam riscos
históricos explícitos, fora desta correção de migration; não afirmar isolamento
integral dos executores ou instalar propostas antigas para autorizar tarefas comuns.

Backup novo restaurado em namespace local sem rede: 27 tabelas, fingerprints,
ledger, 53 constraints, 84 índices e 24 FKs conferidos, zero órfãos. Classificação:
1 evidência de pagamento a importar, 6 assinaturas sem direito pago comprovado,
zero ambiguidade. HTTP 200 e restore não equivalem a homologação de jornada real.
Ver evidência sanitizada em RESTAURACAO_FLUXO_2026-10-24.json.

Uma checagem pós-provisionamento falhou por PATH sem /usr/sbin/runuser; nenhuma
transação SQL falhou. Checagem corrigida com path absoluto confirmou DEV permitido
e outros bancos rejeitados; preflight Node como a conta DEV também aprovado.
Resultados de publicação/homologação são registrados após os pushes.
