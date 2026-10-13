# Agendamento do Communication Worker em DEV

Um serviço `systemd` oneshot executa o worker comercial normal em lotes limitados. O timer é exclusivo do host DEV; não instalar estes units em produção.

## Decisão

O worker atual executa `node dist/communication/worker.js`, processa um lote limitado e encerra. Um timer `systemd` combina com esse ciclo. Um processo PM2 contínuo não combina com um comando que encerra, e cron não oferece a mesma observabilidade nem a coalescência de ativações do mesmo unit.

O timer usa `OnBootSec=1min` e `OnUnitActiveSec=1min`: inicia um minuto após o boot e agenda ciclos sucessivos com intervalo de um minuto. Não há loop dentro do Node.

## Identidade e ambiente

- Usuário/grupo: `kalend-api-dev`.
- Diretório de trabalho: `/home/kalend-api-dev/htdocs/api-dev.kalend.tech/app`.
- Node/npm: instalação NVM do Node `v24.21.0`, com o diretório `bin` no `PATH`.
- O unit define apenas `COMMUNICATION_WORKER_ENABLED=true`, que é uma flag operacional, não um segredo.
- O worker carrega `dotenv/config` por meio da aplicação e do `PrismaService`; com o `WorkingDirectory` acima, usa o `.env` já existente, sem copiá-lo para um novo arquivo.
- A flag do unit habilita somente o processo oneshot. A configuração privada QA fica no `.env` da API DEV e não é copiada para o unit.

Antes da instalação, confirmar que as demais variáveis de runtime usadas pela API estão no `.env` carregado pela aplicação. Não inserir segredos em units, argumentos, logs ou este repositório.

## Concorrência e recuperação

`Type=oneshot` mantém o unit ativo até o processo terminar. Se o timer vencer enquanto esse mesmo unit ainda está ativo, o systemd não cria uma segunda instância paralela do unit; ativações perdidas não formam uma fila ilimitada. `TimeoutStartSec=15min` permite até 50 tentativas com timeout de transporte de 15 segundos, com margem para expansão e gravação, e encerra uma execução presa. Execuções manuais ou agendadores em outro host não são serializados por esse mecanismo; os claims/locks no PostgreSQL continuam necessários para proteger os registros.

O worker não tem loop nem espera interna. O systemd não inicia uma segunda instância do mesmo unit enquanto ele está ativo; um disparo vencido nesse intervalo não cria processos sobrepostos. Execuções fora do unit continuam dependendo dos locks/claims do PostgreSQL.

## Logs e observabilidade

O `ExecStartPre` escreve um marcador de início. stdout/stderr vão para o journal. Em sucesso, o worker registra um JSON com os totais do lote; em falha, registra um código genérico e o systemd registra o resultado/exit status. Consultas propostas:

```sh
systemctl list-timers kalend-communication-worker-dev.timer
systemctl show kalend-communication-worker-dev.service \
  -p Result -p ExecMainStartTimestamp -p ExecMainExitTimestamp -p ExecMainCode -p ExecMainStatus
journalctl -u kalend-communication-worker-dev.service --since today
```

Para o futuro painel Super Admin > Sistema > Diagnóstico, expor última execução, última execução bem-sucedida, duração e último erro seguro. A fonte inicial pode ser o resultado e timestamps do unit/journal; uma métrica persistente e consultável pela aplicação exigiria uma decisão de arquitetura separada. Não implementar persistência ou tela nesta etapa.

## Instalação exclusiva em DEV

Os comandos de instalação DEV:

```sh
sudo install -o root -g root -m 0644 ops/systemd/kalend-communication-worker-dev.service /etc/systemd/system/
sudo install -o root -g root -m 0644 ops/systemd/kalend-communication-worker-dev.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemd-analyze verify /etc/systemd/system/kalend-communication-worker-dev.service /etc/systemd/system/kalend-communication-worker-dev.timer
sudo systemctl enable --now kalend-communication-worker-dev.timer
```

A instalação deve ocorrer somente no host DEV. O timer executa o worker comercial `communication:worker`; QA permanece um comando manual independente. Antes de habilitar ou após mudança operacional, confira o estado com `systemctl status`, `systemctl list-timers` e `journalctl`.
