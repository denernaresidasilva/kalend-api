# Grace e suspensão — regra temporal corrigida

## Causa e mapa do fluxo

`BillingDomain.payment()` trata FAILED/OVERDUE. Se a assinatura vinculada não tem período pago vigente, muda somente essa assinatura para PAST_DUE. `BillingDomain.subscription()` também recebe PAST_DUE do provider. `LifecycleService.reconcile()` busca períodos/trials vencidos e tolerâncias encerradas, excluindo QA_SIMULATION; chama `BillingDomain.elapsed()`. A suspensão da empresa só ocorre sem outra assinatura que conceda acesso. Um Payment FAILED isolado não derruba uma assinatura paga válida de outra tentativa.

O fim do período pago é `currentPeriodEnd`; o fim da tolerância é `graceEndsAt`. `BILLING_GRACE_DAYS` configura dias inteiros, com zero quando ausente. Não existe coluna graceStartsAt. Havendo período contratado, ele é o início da janela. Sem período contratado, o marco é o `updatedAt` persistido ao entrar em PAST_DUE. Nenhum campo novo é necessário.

O trigger `kalend_global_communication_capture()` produz fatos duráveis. Antes, bastava PAST_DUE e graceEndsAt > CURRENT_TIMESTAMP: o relógio do início da transação podia anteceder o horário do domínio por milissegundos, gerando um falso GRACE com tolerância zero. Também faltava verificar se o fim do período contratado já havia chegado. O trigger só observava mudanças de status, portanto uma entrada PAST_DUE antecipada precisava de um produtor temporal para capturar a chegada futura do marco.

## Regra vigente

A função SQL pura `kalend_subscription_grace_due(period_end, grace_end, changed_at, observed_at)` exige simultaneamente:

- fim da tolerância maior que o início persistido da janela;
- início da janela atingido;
- fim da tolerância ainda não atingido.

Zero sem período contratado persiste graceEndsAt=NULL. Zero com período contratado mantém o próprio deadline pago, sem estendê-lo: a janela tem duração zero e não gera GRACE. Assim o acesso de uma assinatura paga em PAST_DUE não é cortado antes do término do período contratado.

O trigger observa `clock_timestamp() AT TIME ZONE 'UTC'`, coerente com as colunas Prisma timestamp sem fuso. Compara o relógio observado com a janela persistida, não com o começo da transação. Também usa esse instante para captura de TRIAL_EXPIRED e createdAt dos novos fatos. CURRENT_TIMESTAMP restante nas migrations históricas não é modificado; seus defaults/auditoria não definem elegibilidade comercial. Nos serviços de notificações ele continua usado para leitura/TTL da inbox, fora da política de grace/suspensão.

`CommunicationEngine.temporal()` continua limitado por lote e escopo. Além de TRIAL_EXPIRING, captura GRACE de assinaturas comerciais PAST_DUE quando a mesma função SQL informa que a janela começou. O modo QA não gera fatos temporais implícitos e o produtor comercial exclui gateway=QA_SIMULATION. Ingestão, expansão, claim e recovery mantêm a policy central de isolamento QA já implantada.

`BillingDomain.elapsed()` recusa antecipar o vencimento de ACTIVE/TRIALING ou o fim da tolerância de PAST_DUE. No limite final, a suspensão segue a regra real; se não há tolerância após o fim pago, ocorre diretamente, sem GRACE intermediário. Cancelamento ao fim do período e reativação com prova de pagamento permanecem nas regras existentes. Suspensões explícitas de provider/admin continuam fatos explícitos, não vencimentos inventados pelo relógio.

## Idempotência e migration

Migration nova: `20261015100000_fix_subscription_grace_timing`.

- GRACE usa businessKey por assinatura e graceEndsAt, compartilhada entre trigger e produtor temporal.
- SUSPENDED usa o deadline persistido da janela/ciclo. Repetições não geram fatos duplicados.
- Fatos GRACE legados terminados em txid são reconhecidos no mesmo ciclo pago sem reescrever seu conteúdo, timestamps ou identificação QA.
- Não há backfill, atualização de linhas existentes, alteração de schema Prisma ou de migration histórica.

## Verificação

`subscription-grace-timing.e2e-spec.ts` aplica migrations completas em PostgreSQL efêmero e verifica zero/positivo, atraso dentro da transação, instante anterior/exato/final da janela, trigger e temporal sem duplicação, legado preservado, suspensão sem antecipação, FAILED/OVERDUE preservando outro plano pago, ACTIVE/PENDING sem grace e reativação. Providers e rede não são chamados. A suíte de isolamento QA continua cobrindo todas as etapas do worker.

Na etapa de deploy, validar somente leitura: migration/funções instaladas, helper falso para janela zero, fingerprints da QA Kalend 4, Payment APPROVED, Subscription ACTIVE e métricas de receita preservados. Não executar novas transições QA nesta etapa.
