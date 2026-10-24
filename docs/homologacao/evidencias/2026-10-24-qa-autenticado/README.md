# Homologação autenticada DEV — 24/10/2026

API publicada a49f6a5; Web c4f84d5. Não houve novo push/deploy/migration nesta execução. Os 27 testes públicos/anônimos anteriores não foram repetidos. Novos scripts/specs no repositório Web exercitam HTTP e browser reais, sem mocks; credenciais e sessões permanecem fora dos repositórios.

Foram criados cinco usuários fictícios (Super Admin, dois proprietários, profissional e desativado) e seis empresas exclusivas desta rodada. As quatro empresas adicionais cobrem checkout sandbox, grant explícito, trial expirado e trial próximo do vencimento. O preparador usa bcrypt, transação serializable, identificação inequívoca do banco e aborta colisões; não altera contas anteriores. Planos QA privados; o plano necessário ao checkout público foi ocultado após o teste.

## Evidências e limites

- Suite HTTP inicial: 40 acertos e um erro de campo no próprio teste; reteste dirigido com `atPeriodEnd` passou, totalizando 41 casos únicos aprovados. Não se descartou a tentativa inicial privada.
- Financeiro inicial: 15 acertos. O teste aprendeu que bloqueio administrativo revoga sessão; re-login passou. O checkout positivo foi isolado em empresa/plano próprios; o plano QA privado corretamente retornou 404. Suite checkout: 7/7. Grants: 7/7. Ciclo financeiro complementar: 14/14. Inbox/revogação: 5/5.
- Token QA assinado expirou pelo relógio real (sem forjar token/alterar relógio); acesso 401, refresh legítimo 200 e novo acesso 200.
- Browser: 15 casos únicos (6 login/admin/owner, 3 trial expirado, 6 continuidade da permissão Push). Três viewports Chromium. Quatorze rotas administrativas por viewport: 42 visitas sem overflow/erro JavaScript. Temas claro/escuro comprovados. Falhas iniciais de espera de hidratação e expectativa de modal removido foram corrigidas nos testes, sem alterar a interface aprovada.
- Aprovação, falha, vencimento, GRACE, suspensão, reativação e cancelamento: chamadas autenticadas QA_SIMULATION. Estorno parcial/integral e chargeback: domínio compilado da API executado somente sobre dinheiro fictício, seguido de consulta HTTP autenticada. Isso **não** comprova callback assinado de pagamento/estorno do PagBank.
- Alteração do período de pagamento com evidência foi recusada pelo trigger, com rollback. Nenhuma evidência APPLIED sem pagamento APPROVED ao fim. Grant criado explicitamente pelo QA admin foi revogado; nenhum grant QA ativo remanescente.
- Um conflito de businessKey no helper operador foi corrigido no namespace exclusivo QA; transações falhas foram revertidas. Não houve correção improvisada no domínio financeiro ou migration.

## Comunicação sandbox

O transporte DEV usa obrigatoriamente `127.0.0.1:1025`, sem autenticação SMTP live nem conexão externa. O sink aceita somente os cinco endereços reservados desta rodada e não possui relay. Trinta e uma entregas EMAIL ACCEPTED correspondem a 31 arquivos .eml privados, todos com destinatários QA. Isso prova entrega **ao sink**, não a uma caixa postal externa.

Doze eventos comerciais, mais QA_COMMUNICATION_TEST, foram observados. SECURITY_PASSWORD_CHANGED não foi gerado: fluxo de alteração de senha continua ausente. Quatro entregas iniciais foram UNSENDABLE porque a allowlist ainda não continha as contas; o bloqueio foi preservado como evidência. Eventos posteriores de boas-vindas/trial foram aceitos. WhatsApp e Push ficaram UNSENDABLE por ausência de telefone/subscription QA; nenhum cliente recebeu mensagem.

Worker foi invocado com IDs exatos das seis empresas novas. Não se executou worker global ou reconciliação financeira global. Repetição escopada não criou novas entregas; pendências escopadas zeradas. O teste de retries/falha real de provedor permanece sem evidência DEV nesta execução.

## Alterações operacionais autorizadas

- `.env` exclusivamente DEV: três variáveis QA (IDs, emails permitidos, habilitação de SMTP sandbox); nenhum segredo, DATABASE_URL ou provedor SMTP modificado.
- Uma reinicialização específica de kalend-api-dev para carregar essas opções. Nenhum restart de produção ou serviço compartilhado.
- Sink Python não root em namespace PM2 próprio, diretório privado `.kalend-qa` do usuário API. Sem PM2 save/unit/startup; limite de 100 mensagens e 1 MiB por mensagem. É infraestrutura QA temporária, não serviço permanente homologado após reboot.
- Rollback QA: parar somente `kalend-qa-smtp-sink` no PM2_HOME privado desta rodada; restaurar apenas as três variáveis QA ao estado anterior registrado no backup privado e reiniciar somente API DEV se autorizado/necessário. Não restaurar o `.env` inteiro sobre mudanças posteriores, não restaurar banco e não excluir histórico financeiro para limpeza. Não executar rollback automaticamente enquanto a homologação usar o sink.

## Pendências que impedem homologação integral

1. Callback legítimo de pagamento sandbox, recorrência e estorno no provedor, preservando assinatura e idempotência.
2. Telefone WhatsApp QA autorizado e dispositivo/navegador Push QA. Identificar o perfil/dispositivo original de BUG-01 para reproduzir esse incidente específico; continuidade de permissões em Chromium passou.
3. Fluxos de recuperação/alteração de senha ausentes e certificações gerais registradas na matriz; não foram apresentados como implementados.
4. Teste dinâmico de startup PM2 é uma tarefa operacional separada.

PROD e DEV frontend/API terminaram HTTP 200. PM2 PROD (1299/1318), Nginx (1230), PostgreSQL (1067), Redis (788) e Docker (1140) preservados. Nenhuma alteração CloudPanel/SSH/sudoers/HBA/PROD, nenhuma cobrança real ou comunicação externa.
