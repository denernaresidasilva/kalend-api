# Política de execução KALEND — fluxo automático DEV

Atualização do proprietário em 24/10/2026. Esta política sucede os gates gerais
anteriores; a versão anterior está preservada em
[histórico](homologacao/POLITICA_EXECUCAO_2026-10-24_ANTES_SIMPLIFICACAO.md).

## Autonomia e publicação

Executar desenvolvimento, testes, correções, builds, commits, Git e preparação
local autonomamente, preservando trabalho anterior. Publicação DEV, migration,
deploy e reinícios dos serviços DEV necessários já estão autorizados.
Não pedir confirmação rotineira nem comandos Git manuais ao proprietário.

Fluxo: Codex → Git local → push normal em develop → GitHub Actions → deploy DEV.
Manter workflows ativos e automáticos; não trocar por publicação manual. Alterar
somente o necessário para corrigir um risco técnico demonstrado.

## Controles indispensáveis da release

Antes de publicar, revisar commits/arquivos e confirmar fetch sem divergência
inesperada, destino SSH, conta e diretórios DEV, comandos efetivos, banco efetivo
da migration e backup recuperável atualizado de kalend_dev. Não imprimir secrets.
Migration deve utilizar identidade sem privilégios em PROD e alvo kalend_dev
validado antes do DDL. Credencial compartilhada não pode executar a migration.
A existência de sudo amplo é risco histórico a registrar; sua substituição por
toda uma arquitetura de isolamento não é pré-condição automática desta release.
Não executar wrappers administrativos ou código de aplicação como root.

Não exigir nova autorização para o que já foi permitido. Não exigir console
independente para tarefas sem alteração de SSH, sudoers ou autenticação
administrativa. Mudanças nesses mecanismos e em configurações compartilhadas
exigem escopo específico, impacto/rollback verificados e recuperação adequada.
Regras SQL limitadas exclusivamente a uma nova identidade DEV não autorizam
alterar regras das identidades administrativas ou de outros sistemas.

## Limites e verificação

Não modificar PROD, main, outros sistemas, serviços globais ou backups existentes.
Não usar force push, prisma migrate reset, reset destrutivo local, nem remover
controles de autenticação, permissões ou backup para forçar publicação.
PROD sem uso comercial não modifica esses limites.

Após push API e Web, acompanhar Actions; conferir SHAs, ledger/checksum, schema e
backfill PaymentEvidence, serviços DEV e jornadas reais com fixtures QA e
provedores sandbox. HTTP 200 ou ensaio local não são homologação real.
Sem cobranças reais ou mensagens a clientes reais sem autorização específica.
Não repetir auditorias/baterias aprovadas sem mudança relevante.

Prioridade: release DEV e homologação Super Admin; depois gateways e painéis.
Evidências e propostas antigas são históricas, não gates cumulativos do fluxo atual.
