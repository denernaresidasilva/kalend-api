# PaymentEvidence — plano de publicação DEV após ensaio real

23/10/2026. Migration tecnicamente APTA no snapshot ensaiado. **Publicação ainda
BLOQUEADA operacionalmente. Nenhuma intervenção ou conexão remota nesta tarefa.**
Não fazer push para develop: ambos os workflows atuais fazem deploy automaticamente.

## Evidência técnica

Backup c6be1c513457995495a236ef54230e0163e33d2faacaef4df71c295505da6c09,
source kalend_dev, restaurado em cluster local PostgreSQL 16.15 sem rede e sem
projeto/home/SSH/sockets reais. Role de testes NOSUPERUSER. Prisma migrate deploy
aplicou 20261017090000_subscription_entitlement_evidence e concluiu ledger correto.
Segunda execução não mudou dados. Migration hash permanece
90ecbea69fa323806ccf7e39f73e03e5b544ac958684662808f0503cb2c4e1e6.

27 -> 29 tabelas; 53 -> 69 constraints; 84 -> 92 índices, zero inválidos.
26 tabelas antigas de aplicação sem mudança por fingerprint de todas as linhas;
18 entradas originais do ledger preservadas, mais a entrada nova. Backfill gerou
1 evidência APPLIED e 1 direito PAYMENT; 6 assinaturas sem direito pago; 0 grants
administrativos. Não confundir direito financeiro com acesso atual irrestrito:
trial, vigência e bloqueio administrativo continuam sendo avaliados pela política.

11 grupos do probe candidato passaram em clone migrado, sem iniciar Nest/workers
ou chamar provedores. SA-08 corrigido em ff1865537f8633d661b47f76e9864f3ec4a9cbc6:
registro inicial concorrente de webhook agora repete P2002 de forma limitada,
antes do claim transacional. 3 regressões novas; 881 unitários e 251 E2E passaram.
Web sem alterações; resultados Web/Playwright anteriores continuam históricos.
Ver evidencias/2026-10-23-migration-real-copy/resumo.json.

## Locks, orçamento e janela

Wall local Prisma/ledger ~0,65s; aplicação SQL medida separadamente ~31ms. Não são
SLA nem previsão para a VPS: snapshot pequeno, hardware/cache/carga diferentes.
Probe instrumentado reteve transação antes do COMMIT para observar locks; esse
pg_sleep é APENAS teste, não faz parte da migration versionada. ShareRowExclusive
em Company/Payment/Subscription/User bloqueou DML; leitura simples continuou.

**Requer janela DEV controlada**, com mutações comerciais e consumidores DEV
relevantes impedidos de concorrer desde a revalidação final até ativar a API nova.
Não parar serviços/workers/timers por inferência: listar identidades e obter
aprovação específica. PROD e demais sites não participam da janela.

lock_timeout=200ms e statement_timeout=200ms induzidos abortaram integralmente o
DDL no sandbox. Cancelamento antes do commit também reverteu tabelas, tipos,
trigger novo, função substituída e dados. Retry após rollback comprovado passou.
Definir limites reais explicitamente na conexão migradora durante revisão da janela
(por exemplo orçamento inicial lock 3s/statement 30s a aprovar, sem garantir suficiência).
Não aumentar timeouts indefinidamente para contornar contenção.

## Intervenção mínima ainda necessária — NÃO EXECUTADA

1. Administrador GitHub: suspender os DOIS workflows de deploy antes de qualquer
   push, registrar estado/runs e impedir corrida. Não tocar main nem publicar
   commit de teste para descobrir efeitos. Não reativar automaticamente o fluxo antigo.
2. Comprovar identidade SSH/UID real e PM2_HOME de cada serviço. O último inventário
   mostrou clpctlWrapper global e clp com sudo amplo: o código sob essas contas
   NÃO está isolado. Uma chave forçada ou novo usuário de ingresso sozinho não resolve.
3. Revisar consumidores CloudPanel legítimos; só após aprovação, negar o caminho
   privilegiado APENAS às identidades DEV de build/runtime ou separar runtime
   tecnicamente confinado. Não remover permissões globais clp/ALL de outros sites.
   Os arquivos de intervenção existentes são propostas condicionadas, não instaladores.
4. Separar ownership/migração/runtime SQL de DEV da role kalend compartilhada com
   PROD: privilégio só em kalend_dev, sem SUPERUSER/CREATEDB/CREATEROLE/BYPASSRLS,
   sem membership proprietário PROD, sem acesso a kalend por HBA/política efetiva.
   Transferências de ownership e grants devem ser por objetos/DB DEV e revisadas;
   não usar REASSIGN OWNED global ou revogações PUBLIC indiscriminadas.
5. Comprovar recuperação administrativa independente e autorizar os arquivos,
   identidades e janela exatos. Nada disso foi alterado nesta tarefa.

O auditor SSH anteriormente preparado NÃO precisa ser instalado artificialmente
para repetir a evidência financeira que já foi obtida sob autorização específica.
Ele também não elimina o isolamento pendente da futura execução de código/CI.

## Sequência aprovada tecnicamente — exige autorização operacional futura

1. Conferir par de SHAs API/Web aprovado (API inclui SA-08; Web 5c7bf8c), migrations,
   checksums, diff/secrets e permissões efetivas. Preparar artefatos imutáveis fora
   dos checkouts ativos. Build sem credenciais runtime/migration; revisar hooks
   npm/postinstall antes de executá-los. Não executar nest start na API.
2. Abrir janela DEV autorizada, conter mutações comerciais/consumidores DEV listados.
   Reexecutar classificador READ ONLY no banco identificado; qualquer ambiguidade
   aborta. Gerar backup NOVO consistente e verificar recuperação conforme política
   aprovada; não assumir que o snapshot de 23/10 cobre novas escritas.
3. Capturar fingerprints/ledger, PIDs e HTTP PROD/DEV; confirmar console recuperável.
   Validar executável/UID/PM2_HOME, socket/host/porta, current_database=kalend_dev,
   current_user esperado e flags. Qualquer capacidade indevida no caminho de deploy
   ou apontamento a PROD = parar. Não imprimir DATABASE_URL/.env.
4. Em conexão migradora restrita, examinar status: exatamente a migration esperada
   pendente, nenhuma tentativa falhada, checksum aprovado. Aplicar com Prisma
   migrate deploy e limites de conexão/statement/lock aprovados. Registrar log
   privado e código de saída; não cancelar job por novo push durante schema/ativação.
5. Confirmar ledger concluído, 2 tabelas, constraints/índices íntegros e efeitos
   financeiros previstos pelo snapshot NOVO. Não deixar a API antiga processando
   pagamentos entre schema novo e ativação: ela não mantém PaymentEvidence.
6. Ativar o par de artefatos e reiniciar somente kalend-api-dev/kalend-web-dev no
   usuário autorizado, comando Node dist/main.js, sem PM2 global/Mailpit. Revisar
   a persistência existente sem sobrescrever dumps indiscriminadamente.
7. Validar /health, Web, SHAs realmente implantados, logs, restart loops, PIDs PROD
   e serviços externos preservados. Ainda na janela, executar login/tenants A/B,
   fluxo financeiro sandbox e comunicação QA allowlisted; não clientes reais.
8. Monitorar a estabilidade pelos checks aprovados; liberar tráfego/consumidores
   DEV somente após consistência. Nenhum serviço PROD deve ser reiniciado.

## Recuperação de schema, ledger, aplicação e dados

- Falha antes de schema/ativação: manter artefato atual, sem tocar PROD.
- Erro/timeouts antes do COMMIT: primeiro comprovar ausência das novas tabelas/tipos,
  retorno da função anterior, fingerprints e ledger. Prisma pode registrar tentativa
  iniciada sem final; a CLI testada mostrou sintoma de transação abortada enquanto
  o log PostgreSQL confirmou lock timeout. Não diagnosticar só pelo texto da CLI.
- Tentativa falhada no ledger produz P3009 ao repetir. Somente após provar rollback
  completo e revisar logs/checksum, autorização específica pode permitir marcar
  ESSA migration --rolled-back e repetir. Isso foi executado só no sandbox.
- Perda de conexão perto/depois do COMMIT é ambígua: consultar schema/dados/ledger;
  não assumir rollback e não usar resolve --applied/--rolled-back cegamente.
- DDL bruto não é reentrante: a segunda execução aborta por objeto já existente.
  O caminho suportado usa o ledger Prisma. Nunca editar migration já aplicada.
- Se o COMMIT ocorreu e ativação falhou, voltar apenas o código NÃO reverte a função
  comercial nem os dados/schema. Manter mutações DEV bloqueadas e preferir correção
  forward validada. Restore do backup exige autorização própria, avaliação de
  escritas posteriores e janela DEV; não sobrescrever dados reais automaticamente.
- Preservar artefatos, logs privados e backups. Rollback só de DEV. Não usar reset,
  seed, DROP/clean global, PM2 all, reinício PostgreSQL/VPS ou rollback PROD.

## Critério de liberação

Migration tecnicamente aprovada neste snapshot. Release só é publicável após
isolamento efetivo, janela/recuperação autorizados e snapshot revalidado. Super Admin
continua sem homologação final em DEV da candidata; demais painéis permanecem bloqueados.
