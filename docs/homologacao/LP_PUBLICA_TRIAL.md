# Landing pública e cadastro Trial

Estado local: 25/10/2026. Esta implementação ainda não foi publicada em DEV.

## Implementado

- `POST /auth/trial-signup`, protegido por `AuthOriginGuard`, cria em uma
  transação Serializable um usuário novo, uma empresa Trial, membership OWNER,
  assinatura Trial sem evidência de pagamento, consentimento versionado,
  sessão autenticada e evento de boas-vindas na Outbox.
- Plano, elegibilidade e duração são validados no servidor. E-mail existente é
  rejeitado genericamente; não há associação de empresa, troca de senha ou login
  automático em conta preexistente.
- Rate limits por IP/e-mail, honeypot, validação de senha, aceite obrigatório e
  consentimento promocional independente.
- Evento de boas-vindas solicita somente e-mail. Nenhum segredo é inserido nos
  eventos. WhatsApp depende de autorização/configuração e Push exige subscription
  autorizada do dispositivo; nenhum deles é disparado pelo cadastro público.
- `/lp` apresenta o catálogo elegível real; termos, privacidade e onboarding
  informam claramente as capacidades disponíveis. Módulos operacionais ainda
  indisponíveis não são anunciados como entregues.
- Tracking de marketing é opt-in, sem PII. Conversão ocorre após criação
  confirmada, e conversões são deduplicadas por sessão. DEV não é indexável.

## Validação local

- API: 892 testes unitários e 251 E2E passaram; build, lint e Prisma validate
  passaram.
- Migration `20261025090000_public_trial_signup_consent`: aplicada em PGlite
  isolado; tabela, defaults, FKs, unicidade e índices verificados.
- Web: 402 testes, ESLint, TypeScript e build passaram.
- Playwright local da LP: 3/3 passaram em desktop, tablet e mobile; chamadas de
  API foram simuladas localmente, não representam homologação real.

## Gate DEV pendente

Leitura remota sanitizada em `srv1119527`: os processos DEV estão online; o
preflight da migration confirmou `kalend_dev`/`kalend_dev_migrator` sem
privilégios de cluster e `prisma migrate status` mostrou as 19 migrations já
publicadas como aplicadas. O catálogo público retornou três planos Trial elegíveis.
Contudo, o runtime da API lê `kalend_dev` através da role `kalend`, que tem
`CREATEDB` e é proprietária de outro banco. As contas DEV também mantêm a
permissão CloudPanel `clpctlWrapper` via sudo.

Backup novo de `kalend_dev` criado sob `/root/kalend-dev-lp-20261025-xVFoWvuV`,
modo 0700 root:root; SHA-256 registrado no manifesto privado. Restore completo
foi testado em database temporário isolado e removido depois da validação: 29
tabelas, 69 constraints, 31 FKs, 92 índices, zero constraints não validadas,
17 subscriptions e 11 payments. Um segundo snapshot privado, também restaurado
com sucesso, foi preservado em `/root/kalend-dev-lp-20261025-fvBmlaR3`.
Nenhum serviço ou configuração foi alterado; dados de aplicação, migration,
push e deploy não foram alterados/executados.

Antes de publicar, separar a role de runtime exclusivamente em `kalend_dev`,
provar autenticação e privilégios sem acesso a `kalend`, e estabelecer uma
identidade de execução DEV sem caminho administrativo efetivo. Essas mudanças
exigem intervenção administrativa delimitada, backup das configurações e
recuperação apropriada. Não usar este commit como autorização para contornar o
gate.

Depois do isolamento: backup atualizado e restore verificado de `kalend_dev`,
push API (a migration é aplicada pelo workflow automático) e, em seguida, Web;
acompanhar Actions e validar cadastro, cookies, tenant, assinatura Trial e
Outbox com fixtures QA/sink autorizado. Não enviar WhatsApp/Push sem dispositivo
ou destinatário QA autorizado; não cobrar, usar SMTP de produção ou alterar PROD.

## Limitações funcionais reconhecidas

O onboarding confirma Trial e conta, mas serviços, horários e agenda pública
continuam indisponíveis neste ambiente. O envio real de e-mail sandbox depende
da allowlist e da configuração de DEV. Termos e política publicados nesta
implementação requerem validação jurídica antes de uso comercial definitivo.
