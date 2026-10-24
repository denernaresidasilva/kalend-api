# Política de execução KALEND — atualização do proprietário em 24/10/2026

## Autonomia e autorização

Desenvolver, investigar, corrigir, testar, executar builds, documentar e criar commits
locais autonomamente, sem confirmações rotineiras. Preservar alterações legítimas e
não publicadas; não usar reset destrutivo, clean ou force push.

O proprietário autoriza a publicação no ambiente DEV nesta sessão. Executar push,
migration DEV, deploy e reinícios DEV necessários com as permissões efetivamente
disponíveis, somente após comprovar os controles técnicos de isolamento. A ausência
de botão Yes não bloqueia uma operação já autorizada nem substitui seus controles.
Não condicionar publicação autorizada a uma interface de aprovação inexistente.

Full Access não autoriza alterar PROD, main, outros projetos, bancos ou serviços
globais. Intervenções em SSH, sudoers, firewall e configurações compartilhadas
requerem escopo administrativo específico, recuperação verificável e autorização
correspondente. Não inferir autorização global da publicação DEV. Se faltar um
requisito administrativo, continuar tarefas independentes e registrar a condição
concreta, sem executar a etapa insegura.

## Publicação e GitHub Actions

Preservar o deploy automático existente por push em develop. Não desabilitar
workflows, substituir o deploy por operação manual ou alterar YAML sem necessidade
técnica comprovada. Revisar todos os commits pendentes API/Web, seus efeitos,
secrets, arquivos privados e modificações não commitadas antes da publicação.

Antes de migration/deploy, corrigir e validar identidades SQL exclusivas DEV,
privilégios administrativos das contas executoras, identidade SSH efetiva do CI,
banco-alvo, backup atualizado e recuperação. Credenciais compartilhadas com PROD
não podem executar a migration. Aprovação ou sucesso histórico de pipeline não
comprovam isolamento. Não testar capacidade de escrita em PROD.

Com os controles comprovados, enviar todos os commits pendentes revisados por push
normal em develop, acompanhar Actions, conferir ledger PaymentEvidence, schema,
backfill, artefatos/versões API e Web, saúde e preservação de PROD. Nenhum force push.
Não apresentar backup, ensaio local ou HTTP 200 como homologação de jornada real.

## Homologação e continuidade

Executar testes reais do Super Admin com fixtures QA e provedores sandbox. Corrigir
localmente, criar regressões, validar e republicar autonomamente no DEV enquanto
os controles de publicação continuarem válidos. Não repetir baterias financeiras
já aprovadas sem mudança ou necessidade de regressão. Não declarar homologação
com requisitos críticos sem evidência.

Após homologação do Super Admin, auditar gateways existentes com documentação
oficial atualizada, corrigir integrações, proteger credenciais e manter formulários
individuais apenas com campos necessários. Gerar automaticamente URLs e parâmetros
pertencentes ao Kalend. Usar sandbox quando houver credenciais. Sem cobranças reais
ou mensagens para clientes reais sem autorização específica.

Prioridade: publicação DEV e homologação Super Admin; depois gateways, painéis e
aplicativos. Não antecipar outros painéis enquanto o núcleo crítico não for homologado.

## Histórico preservado e estado confirmado nesta atualização

A exigência anterior de aprovação interativa foi substituída pela autorização
condicional acima. Os YAMLs locais permanecem idênticos aos últimos workflows
remotos bem-sucedidos: API b1cc220a e Web 4d86829b. As regressões operacionais de
preservação dos workflows e validação bash -n permanecem aplicáveis.

O HEAD API encontrado foi e6664fd, com consolidação posterior dos arquivos pendentes;
Web bbb668b. Esse trabalho foi preservado. Uma nova leitura sudo -l na VPS confirmou
que kalend-dev e kalend-api-dev ainda podem executar clpctlWrapper, e clp possui
NOPASSWD ALL. Não foi executado o wrapper. O mecanismo de isolamento proposto
continua não instalado. O achado SQL mais recente confirma DATABASE_URL em
kalend_dev com role kalend também proprietária de PROD; deve ser revalidado e
corrigido antes de DDL. Recuperação independente permanece pré-condição não
comprovada para alterações administrativas. Nenhuma escrita remota foi executada
na atualização desta política.
