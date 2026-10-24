# Sandbox de restauração — fase C, futura autorização administrativa

Não executar nesta revisão. Não é o cluster real. Dumps são dados privados e podem conter código; usar identidade OS nova sem sudo, role SQL NOSUPERUSER e namespace de rede próprio sem egress. Não instalar extensões globais, iniciar Docker, aplicação, filas ou timers. Se namespaces não forem suportados, usar VM isolada aprovada; não relaxar o isolamento.

Pré-condições: backup/manifesto já concluídos, nenhum alvo abaixo existente, inventário de owners/extensões aprovado, binários PostgreSQL 16 instalados e confiáveis, revisão do conteúdo do dump quando houver objetos executáveis. Conferir que não há role homônima no cluster real antes de criar a identidade OS. Os comandos são executados pelo administrador em sessão recuperável; não fornecidos a CI.

```sh
set -euo pipefail
umask 077
test "$(hostname -s)" = srv1119527
test "$(id -u)" = 0
if getent passwd kalend_restore_review >/dev/null; then exit 1; fi
test ! -e /etc/sudoers.d/zz-kalend-restore-deny
# Criar só esta negação e validar ordenação, antes da conta existir.
printf '%s\n' 'kalend_restore_review ALL=(ALL:ALL) !ALL' > /etc/sudoers.d/zz-kalend-restore-deny
chown root:root /etc/sudoers.d/zz-kalend-restore-deny
chmod 0440 /etc/sudoers.d/zz-kalend-restore-deny
visudo -c
useradd --system --user-group --no-create-home --home-dir /var/lib/kalend-dev-restore --shell /usr/sbin/nologin kalend_restore_review
sudo -l -U kalend_restore_review
id kalend_restore_review
# Parar se houver acesso privilegiado, grupo extra ou path preexistente.
test ! -e /var/lib/kalend-dev-restore
install -d -o kalend_restore_review -g kalend_restore_review -m 0700 /var/lib/kalend-dev-restore
restore_dir=$(mktemp -d /var/lib/kalend-dev-restore/review.XXXXXXXX)
chown kalend_restore_review:kalend_restore_review "$restore_dir"
install -d -o kalend_restore_review -g kalend_restore_review -m 0700 "$restore_dir/socket"
restore_socket="$restore_dir/socket"
restore_port=55433
restore_db=kalend_restore_review
runuser -u kalend_restore_review -- env -i PATH=/usr/bin:/bin HOME=/var/lib/kalend-dev-restore /usr/lib/postgresql/16/bin/initdb \
  -D "$restore_dir/data" -U kalend_restore_bootstrap --auth-local=trust --auth-host=reject --no-locale -E UTF8
# Trust existe SOMENTE no socket privado 0700, sem TCP; nenhum usuário de aplicação entra.
# Namespace de rede + no_new_privs aplica-se só a este servidor e seus filhos.
unshare --net -- setpriv --no-new-privs runuser -u kalend_restore_review -- env -i PATH=/usr/bin:/bin HOME=/var/lib/kalend-dev-restore \
  /usr/lib/postgresql/16/bin/pg_ctl -D "$restore_dir/data" -l "$restore_dir/server.log" \
  -o "-h '' -p $restore_port -k $restore_socket" -w start
# Bootstrap exclusivo de provisionamento, não usado nos testes/dump/restore.
runuser -u kalend_restore_review -- env -i PATH=/usr/bin:/bin HOME=/var/lib/kalend-dev-restore /usr/lib/postgresql/16/bin/psql \
  -h "$restore_socket" -p "$restore_port" -U kalend_restore_bootstrap -d postgres -X -v ON_ERROR_STOP=1 -c \
  'CREATE ROLE kalend_restore_review LOGIN NOSUPERUSER CREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; GRANT pg_read_all_settings TO kalend_restore_review; ALTER ROLE kalend_restore_bootstrap NOLOGIN;'
runuser -u kalend_restore_review -- env -i PATH=/usr/bin:/bin HOME=/var/lib/kalend-dev-restore /usr/lib/postgresql/16/bin/createdb \
  -h "$restore_socket" -p "$restore_port" -U kalend_restore_review "$restore_db"
runuser -u kalend_restore_review -- env -i PATH=/usr/bin:/bin HOME=/var/lib/kalend-dev-restore /usr/lib/postgresql/16/bin/psql \
  -h "$restore_socket" -p "$restore_port" -U kalend_restore_review -d "$restore_db" -X -c \
  'SELECT current_database(),current_user,rolsuper FROM pg_roles WHERE rolname=current_user; SHOW data_directory;'
```

Comparar saída com os valores exatos; rolsuper deve ser false, database kalend_restore_review e data_directory dentro do diretório novo. O dono pode criar bancos somente neste cluster descartável. Não há credenciais do cluster real nem memberships administrativas. Confirmar PID do postmaster pertence a kalend_restore_review, nenhum listener TCP foi criado e o servidor está no namespace distinto. NoNewPrivs deve constar em /proc/PID/status. Rejeitar namespace/atributo ausente. A abertura do socket privado pelo cliente é local; esse ambiente não tem rota para provedores.

Só então executar o pg_restore da seção C do plano, como OS/SQL kalend_restore_review. Manter stdin vindo de backup protegido; não trocar ownership/permissão do original. Não usar --create, --clean, serviços libpq, URLs ou variáveis herdadas de .env. Validar todos os manifestos do mesmo snapshot antes de aceitar recuperação. Não rodar a aplicação ou a migration candidata sem nova etapa autorizada.

Encerramento/rollback do sandbox:

```sh
# Confirmar owner/path/PID novamente; parar somente o postmaster deste diretório.
runuser -u kalend_restore_review -- env -i PATH=/usr/bin:/bin HOME=/var/lib/kalend-dev-restore /usr/lib/postgresql/16/bin/pg_ctl -D "$restore_dir/data" -m fast -w stop
```

Conservar backup, manifesto e logs protegidos. Não apagar diretórios antigos ou restaurar dados no cluster real. Não remover a negação sudo ou a conta enquanto existir processo/artefato sob esse UID. Retirada posterior: revisar ausência de processos e dependências, desabilitar somente a conta criada por esta operação e decidir retenção; não executar userdel -r ou DROP OWNED global. Nenhuma unit persistente é criada. Um erro deve disparar a parada específica deste cluster pelo operador; nunca pg_ctl/systemctl sem o destino explícito.


Atualização local 23/10/2026: o inventário remoto histórico de 22/10 confirmou o caminho CloudPanel e serviços consumidores; não comprovou ausência de dependências dinâmicas. A fase A corrigida não altera identidades existentes. Ver seção 10 de INTERVENCAO_ADMINISTRATIVA.md para ACL sem ferramenta externa, chave 0640/grupo exclusivo e recuperação obrigatória ainda pendente. Este documento não autoriza execução remota nem instalação do sandbox.
