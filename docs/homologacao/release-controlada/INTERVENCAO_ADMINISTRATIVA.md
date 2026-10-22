# Intervenção administrativa proposta — NÃO EXECUTADA

Escopo: remover o caminho administrativo CloudPanel somente das identidades Kalend DEV, disponibilizar consulta fixa do legado e preparar a publicação. Não autoriza deploy, migration, restart ou alteração em PROD. Nenhum arquivo deste diretório foi instalado na VPS.

## Fato operacional e requisito de segurança

22/10: SSH funcionou para kalend-dev (UID 1021) e kalend-api-dev (1022). Ambos acessam somente o próprio diretório DEV por permissões comuns; sem escrita nos diretórios PROD, Nginx, systemd ou Docker observados. Entretanto /etc/sudoers.d/cloudpanel contém `ALL ALL=(ALL) NOPASSWD: /usr/bin/clpctlWrapper`; o wrapper encaminha argumentos a clp; a mesma configuração concede `clp ALL=(ALL) NOPASSWD: ALL`. Não foi explorado esse caminho ou executado clpctl. A ausência de allowlist DEV no wrapper impede provar o isolamento exigido.

A identidade exata nos secrets DEV_SSH_USER/KEY dos workflows não é recuperável pelos logs mascarados; os históricos confirmam execução dos scripts, não o UID efetivo. Nomes DEV de secrets ou proprietários do diretório não comprovam que o job não usa root.

## Arquivos preparados e revisão necessária

- `sudoers-dev-only.conf`: negação específica de sudo para kalend-dev, kalend-api-dev e novo kalend_dev_audit. Não alterar a regra global CloudPanel nem outros usuários. O arquivo foi validado por visudo local. A ordem efetiva de includes precisa ser revisada antes e depois da aplicação; apenas remover os usuários do grupo sudo é insuficiente.
- `kalend-dev-release-gate`: comando forçado root-owned que permite somente preflight fixo por contexto. **Não implementa ativação/deploy**, que segue bloqueado pelos gates. Não chama PM2 nem inicia daemon. É uma primeira barreira de acesso verificável, não um deploy pronto.
- `kalend-dev-audit`: comando forçado root-owned que aceita somente backfill-audit e executa SQL root-owned em transação REPEATABLE READ READ ONLY, conexão fixa Unix/kalend_dev, sem ambiente herdado ou SQL fornecido pelo cliente.
- `readonly-role.sql`: role dedicada sem superuser, criação de roles/bancos, replicação, bypass RLS, ownership ou associação a roles de aplicação. SELECT somente Subscription, Payment e _prisma_migrations.
- `pg_hba.fragment.conf`: regras limitadas à nova role, peer somente em kalend_dev e rejeição em outros bancos/redes. Exige revisão da ordem e reload de configuração PostgreSQL em intervenção especificamente autorizada; não requer restart. Não substituir o arquivo inteiro.
- `authorized_keys.example`: opções restrict e command para chaves separadas. Valores são placeholders, não instalar literalmente nem copiar chave privada.
- `backfill-audit.sql`: único SELECT com CTEs, classifica todas as Subscription/Payment e sinaliza cobertura/grace ambígua. Sem PII ou payloads de provedores; IDs financeiros continuam sensíveis e o resultado real deve ficar protegido, fora do Git.

## Comandos administrativos propostos (não executar automaticamente)

Em sessão administrativa revisada, confirmar hostname srv1119527, cópia protegida das configurações tocadas e uma sessão de recuperação. Não sobrescrever authorized_keys existentes nem alterar SSH global. Preparar os arquivos revisados em staging privado; verificar hashes antes de instalar.

```sh
# Confirmar a inclusão final: regras globais posteriores poderiam reabrir sudo.
visudo -c
# Instalar somente o arquivo específico, após revisar sua posição nos includes.
install -o root -g root -m 0440 sudoers-dev-only.conf /etc/sudoers.d/zz-kalend-dev-deny
visudo -c
sudo -l -U kalend-dev
sudo -l -U kalend-api-dev
# Parar se restar qualquer caminho privilegiado; não testar comandos de escrita.

# Criar somente a nova identidade auditora, se ainda não existir.
adduser --disabled-password --gecos '' kalend_dev_audit
install -d -o root -g root -m 0755 /usr/local/share/kalend-dev-audit
install -o root -g root -m 0644 backfill-audit.sql /usr/local/share/kalend-dev-audit/backfill-audit.sql
install -o root -g root -m 0755 kalend-dev-audit /usr/local/libexec/kalend-dev-audit
install -o root -g root -m 0755 kalend-dev-release-gate /usr/local/libexec/kalend-dev-release-gate
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d kalend_dev -f readonly-role.sql
sudo -l -U kalend_dev_audit
```

Provisionar chaves públicas separadas via intervenção revisada, preservar as existentes e tornar arquivos/pastas de chaves CI/auditoria não modificáveis pela identidade restrita. Não bloquear acesso administrativo de recuperação. Inserir somente as regras HBA da nova role e validar pg_hba_file_rules antes do reload autorizado. Revisar PUBLIC grants, SECURITY DEFINER, groups/ACL, sockets e paths graváveis. Confirmar que o usuário de aplicação/migration não é superuser e não possui acesso de escrita em kalend. As credenciais privadas não serão exibidas, versionadas ou copiadas para relatórios.

O `prisma skills sync || exit 0` no postinstall da API é um hook conhecido. Npm instala scripts de terceiros; não montar credenciais de runtime/migration nem permitir acesso a provedores reais durante o build. O fluxo futuro deve separar build, migration aprovada e ativação do artefato. Workers/timers DEV compartilham schema e precisam ser inventariados antes da janela; não são alterados por esta proposta.

Após essa intervenção, repetir SOMENTE os gates operacionais: sudo efetivo negado, comandos forçados aceitam apenas entradas fixas, portas corretas, PROD sem escrita e identificação do UID no CI. Nenhum teste deve tentar escrever em PROD para demonstrar negação. A classificação real será obtida por `ssh kalend_dev_audit@72.61.47.145 backfill-audit` e armazenada com umask 077 fora do repositório. Totais e bloqueadores redigidos podem alimentar o relatório; IDs reais não devem ser enviados a GitHub.

## Backup consistente e recuperação — desenho pendente

Não há backup DEV criado/verificado nesta tarefa. Um arquivo existente ou pg_restore --list não comprova recuperação. A intervenção de backup é separada e só de kalend_dev:

```sh
# Proposta para administrador: diretório novo, protegido, sem apagar backups.
umask 077
backup_dir=$(mktemp -d /root/kalend-dev-release-backup.XXXXXXXX)
runuser -u postgres -- /usr/lib/postgresql/16/bin/pg_dump -Fc --no-owner --no-acl -d kalend_dev > "$backup_dir/kalend_dev.dump"
sha256sum "$backup_dir/kalend_dev.dump" > "$backup_dir/SHA256SUMS"
stat "$backup_dir/kalend_dev.dump" > "$backup_dir/metadata.txt"
```

pg_dump produz snapshot consistente dos dados. Registrar separadamente owners/ACL necessários à recuperação, versão de extensões, migration checksums, commits/artefatos correntes e configurações DEV, sempre em área protegida. Não incluir credenciais em relatório. O dump não substitui backup de artefatos/roles. Um cluster nativo descartável deve receber restore completo (`pg_restore --exit-on-error --no-owner --no-acl`), sem iniciar aplicação, timers ou provedores. Manter a cópia na VPS protegida se contiver dados reais; não transferir para diretório público ou para o repo local. Validar contagens, constraints e ledger de migrations, depois ensaiar a migration candidata nessa cópia e medir duração/locks. A identidade e o destino precisam ser conferidos antes da execução; nenhuma restauração pode apontar a kalend ou kalend_dev reais.

Conferir os dados comerciais por classificação antes de migrar: quaisquer BLOCK_MIGRATION_REVIEW ou outras revisões financeiras não resolvidas impedem a publicação. Conferir novamente o legado na janela final, pois o banco continua vivo. O relatório é um snapshot, não um lock que congele escritas posteriores.

## Publicação e recuperação

Manter o workflow atual sem push enquanto as condições não forem satisfeitas. A nova ativação precisa de job manual/environment protegido, acesso usuário próprio, refs/SHA fixados, sem cancelamento durante migration, build em diretório de release separado e nenhum reset do checkout ativo. Migration é etapa explícita após backup/ensaio, com timeout/lock budget revisado e sem usar runtime superuser. Somente após isso preparar o dispatcher de ativação e validá-lo; não ampliar o gate de preflight com shell livre.

Em falha antes da ativação, processos atuais permanecem. Se migration falhar, conferir rollback e ledger, não usar migrate resolve/reset cegamente. Se houver commit do schema, retornar ao código antigo não desfaz as funções comerciais; preferir correção forward ensaiada. Restore de snapshot exige janela DEV, análise das escritas posteriores e autorização específica. Nunca reverter PROD ou matar daemons globalmente.
