# Operação futura da comunicação global

Nenhum comando de worker, configuração real, migration ou deploy foi executado nesta entrega. Não há Redis/BullMQ nem serviço instalado na VPS.

## Configuração

Variáveis novas:

| Variável | Uso |
| --- | --- |
| COMMUNICATION_SCHEDULER_ENABLED | CLI temporal/domínio só roda com literal `true`; ausente bloqueia |
| COMMUNICATION_WORKER_ENABLED | CLI só roda com literal `true`; ausente bloqueia a execução |
| COMMUNICATION_SMTP_HOSTS | Hosts DNS exatos separados por vírgula; ausente nega todos |
| COMMUNICATION_EVOLUTION_HOSTS | Hosts DNS exatos separados por vírgula; ausente nega todos |
| COMMUNICATION_META_GRAPH_VERSION | Versão Graph fixada pelo operador após revisão/homologação; sem default |

Existentes: DATABASE_URL, GATEWAY_ENCRYPTION_KEY, AUTH_*; nenhuma foi criada/alterada com valor real. Segredos dos providers ficam no cofre do banco. Allowlist de rede é definida pelo operador, não pelo formulário administrativo. Não usar IP privado nem host com credenciais/path/porta arbitrária. Ambiente SANDBOX não cria sandbox de SMTP/Evolution: preparar mailbox/instância e destinatários de teste.

Configuração exemplo conceitual de SMTP (não contém segredo):

```json
{"environment":"SANDBOX","config":{"host":"smtp.example.test","port":"587","secure":"false","username":"sender","fromName":"Kalend","fromEmail":"sender@example.test"}}
```

Envie `secrets.password` pelo canal administrativo seguro. PATCH `secrets` ausente ou campo `""` preserva; `null` remove o campo; não envie máscara. Mudança de configuração/secret invalida teste e desabilita. Teste a conexão; depois habilite em PATCH separado. Troca de ambiente exige todos os secrets novos e é proibida com histórico de entregas. Troca de conta Meta/Evolution com histórico também é proibida. Revisão de configuração/template congela entregas pendentes: mudança faz o worker ignorar o snapshot antigo. Planejar rotação antes de ter fila pendente; não forçar reenvio criando outra chave.

## Endpoints

Prefixo `/communication`, coerente com recursos globais existentes (`/payment-gateways`, `/plans`), nas rotas administrativas protegido por AdminGuard: JWT/cookie, sessão, usuário ativo e isSuperAdmin atual. Mutação exige Origin permitida. Membership OWNER/ADMIN não concede acesso global.

| Método/path | Contrato |
| --- | --- |
| GET /providers | Configs públicas, flags/status/revisão; nunca secrets/ciphertext |
| PATCH /providers/:provider | `environment?`, `enabled?`, `config?`, `secrets?`; config é objeto completo validado |
| POST /providers/:provider/test | Negociação/autenticação; não envia mensagem |
| POST /providers/:provider/send-test | Body `{}` para SMTP/Evolution; Meta `{template:{id,name,language,parameters:[]}}`; destinatário sempre o Super Admin autenticado, lido do banco |
| POST /providers/EVOLUTION/pair | Solicita pareamento da instância configurada; devolve QR PNG temporário, nunca apiKey |
| GET /events | Catálogo de 13 eventos e variáveis permitidas |
| GET /templates | Configuração por evento/canal, últimos até 100 itens |
| PATCH /templates/:event/:channel | `{provider,enabled,content}`; upsert global, canais independentes |
| GET /meta/templates | Cache local do WABA/ambiente configurados, até 100 |
| POST /meta/templates | `{name,language,category:"UTILITY",text}`; BODY estático; não define aprovação local |
| POST /meta/templates/sync | `{after?}`; uma página remota, retorna `{synced,after}`; continuar até after=null |
| GET /outbox | Até 100 fatos recentes, sem variables |
| GET /deliveries | Até 100 entregas recentes, sem payload cifrado |
| GET /failures | FAILED/UNSENDABLE/UNCERTAIN recentes |
| GET /logs | Até 100 registros recentes sem conteúdo/secret |
| POST /deliveries/:id/reprocess | Antecipar somente RETRY com tentativas restantes; não reinicia limite, não repete UNCERTAIN |

Os paths da tabela são relativos a `/communication`. Fase 3 adiciona limit/offset para outbox/deliveries/failures/logs e status em deliveries/failures, preservando resposta array. Consulta individual/exportação ficam para evolução administrativa; listagens não são inventário completo.

Testes/pareamento compartilham 5 ações por administrador/5min e 20 globais/5min, em AuthRateLimit PostgreSQL. Reprocessamento 10/admin/5min; gestão Meta 10/admin/5min. Nenhuma rota de teste aceita telefone/e-mail/empresa arbitrary. O teste Meta exige template aprovado e sem parâmetros dependentes de evento. `accepted:true` não significa entregue. Repetir teste é novo envio intencional, sujeito ao limite; não há retry automático de teste.

Callback externo: GET/POST `/webhooks/communication/meta`, fora de AdminGuard e autenticado conforme provider. Precisa de HTTPS, rawBody existente e appSecret/verifyToken. Não existe callback Evolution permissivo. A Fase 3 adiciona callback Gmail protegido por state/PKCE/binding e subscriptions próprias com AuthGuard; consulte PHASE3-COMMUNICATION.md.

## Worker e scheduler

Após revisão e implantação futura autorizada, gerar build e executar `npm run communication:worker` com COMMUNICATION_WORKER_ENABLED=true e ambiente dedicado. O comando cria contexto Nest sem listener HTTP; faz um lote e encerra. **Não o executar apenas para testar build**: ele conecta no banco definido no ambiente.

Agendamento proposto: systemd timer/cron externo a cada minuto, com lock operacional (`flock`) para evitar sobreposição na mesma máquina; a correção também depende de locks/claims no PostgreSQL para múltiplas máquinas. Configurar working directory, arquivo de ambiente fora do repositório, usuário sem privilégio, timeout do processo e alerta de exit não zero. Em DEV usar a mesma invocação de lote por comando manual; não precisa Redis. Nada disso foi instalado/configurado nesta tarefa.

Lote: até 100 fatos TRIAL_EXPIRING (janela fixa de 3 dias), até 20 eventos expandidos sob `FOR UPDATE SKIP LOCKED`, até 50 entregas processadas. Monitorar backlog e frequência de execução. A transação de expansão tem timeout 15s; falha de banco causa rollback e próxima execução tenta novamente.

O runner separado `npm run communication:scheduler` (COMMUNICATION_SCHEDULER_ENABLED=true) invoca LifecycleService.reconcile e a detecção temporal, sem enviar mensagens. Agendar por systemd timer/cron com flock, ambiente e supervisão separados do worker, a cada minuto conforme capacidade. Ele consulta gateways financeiros e escreve transições de domínio; não foi executado nesta entrega. A alternativa administrativa existente é `POST /billing/reconcile`, autenticada. Esse fluxo já expira trial, calcula graça e suspende assinaturas. A comunicação não substitui a reconciliação financeira nem altera estado de assinatura. Enquanto reconciliação não rodar, eventos de transição de estado ainda não existem. Não agendar pelo frontend aberto e não embutir setInterval no HTTP. Credenciais administrativas não devem ser gravadas em linha de comando/log.

PAYMENT_OVERDUE vem do status financeiro verificado; Payment não possui dueAt confiável. Não inferir atraso a partir de periodStart. TRIAL_EXPIRED só é capturado na transição TRIALING→EXPIRED com trialEndsAt vencido; conversão antecipada Premium→Pro não emite expiração temporal falsa.

## Retry, recuperação e retenção

Erros explicitamente transitórios SMTP 4xx ou HTTP 429: backoff 60/120/240/480s, máximo 5 tentativas totais. AUTH/PERMANENT/TEMPLATE/RECIPIENT terminam; timeout após possível envio e resposta sem id são UNCERTAIN (sem retry). Gmail send 5xx continua UNCERTAIN; refresh Google e respostas explícitas Web Push 5xx são transitórias conforme contratos da Fase 3. O protocolo não garante exactly-once externo. SENDING abandonado por mais de 5min é marcado UNCERTAIN; pode ter enviado. Nunca resgatar por timeout e repetir automaticamente.

Falha depois de aceitação externa antes de persistir deixa SENDING/UNCERTAIN; investigar no provedor. Não há endpoint de “marcar enviado” nem possibilidade de injetar providerMessageId. Reparar dados/permitir reenvio após investigação exige procedimento separado e autorizado.

Recipient/conteúdo renderizado são snapshot cifrado apenas durante PENDING/RETRY/SENDING; apagados no estado terminal. UNKNOWN/UNCERTAIN não preserva corpo para reenvio. Outbox conserva variáveis mínimas de negócio, companyId/userId de referência, sem contato/senha. IDs de usuário/empresa não têm cascata destrutiva: necessário manter deduplicação/histórico; registros órfãos não autorizam envio. Definir prazo de retenção e limpeza auditada de logs/outbox sem remover chaves idempotentes. Não foi criado job destrutivo de limpeza nem política legal presumida.

Alertas operacionais necessários: idade do evento não expandido, pendentes vencidos, UNSENDABLE por telefone ausente, AUTH, UNCERTAIN, falhas de worker e recibos não correlacionados. Nenhum exporter externo foi configurado. Utilizar logs estruturados sem request body, Authorization, Cookie, Set-Cookie, QR ou query de verificação.

## Extensões Fase 3

Consulte [Gmail OAuth e Web Push](PHASE3-COMMUNICATION.md) para callback URL/allowlist Web Push, endpoints, quotas, VAPID, subscriptions, preparação mobile e homologação. Nenhuma configuração real ou flag foi ativada. Scheduler separado agora também revoga subscriptions expiradas e apaga suas credenciais.
