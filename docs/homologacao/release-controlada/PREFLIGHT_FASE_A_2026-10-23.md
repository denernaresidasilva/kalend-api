# Fase A — plano definitivo condicionado ao preflight

Data: 23/10/2026. **NÃO EXECUTADO. FASE A NÃO LIBERADA PARA INSTALAÇÃO.**
O [procedimento canônico](INTERVENCAO_ADMINISTRATIVA.md) contém os comandos de
instalação A1–A4 e rollback. Este documento estabelece gates, ordem e evidências.

## Impedimentos que faltam resolver

1. Operador autorizado precisa acessar o console de emergência do provedor para
   ESTA VPS, provar hostname/UID administrativo e capacidade de recuperação sem
   depender do SSH/sudo/HBA em alteração. Registrar horário, método e evidência
   redigida; nenhuma senha/chave/token deve entrar em Git. Não basta ver um botão
   do painel, getty ativo, duas conexões SSH ou documentação comercial do provedor.
   Não provocar falha, ativar rescue/reboot ou trocar senha para testar.
2. Definir UMA chave pública auditora aprovada, titular e fingerprint conferidos
   fora de banda. Não reutilizar automaticamente chave root/CI. Preparar
   audit.authorized_keys com restrict,command e from= se houver origem aprovada.
   Sem origem fixa aprovada, não inventar CIDR nem declarar restrição instalada.
3. Obter autorização explícita da intervenção depois dos itens anteriores e
   repetir os gates operacionais imediatamente antes da primeira escrita.

## 1. Pré-condições e backup — administrador

- Host srv1119527; usuário root; sessão SSH atual mantida e segundo SSH conferido,
  mais recuperação independente comprovada conforme acima.
- Confirmar nenhum administrador concorrente, serviços e PIDs/HTTP, espaço/inodes,
  ausência de conta/grupo/role e de TODOS os novos paths. Qualquer colisão: parar.
- Staging /root/kalend-admin-review-stage root:root 0700, arquivos revisados e
  manifesto verificado. Não transportar secrets com o pacote. A chave pública
  definitiva é aprovada separadamente; o exemplo não é instalável.
- Executar o bloco da seção 3 do procedimento: umask 077, diretório exclusivo,
  tar --acls --xattrs --numeric-owner dos sudoers/SSH/HBA/ident e hashes.
  Conferir código de saída e leitura da listagem do arquivo, em sessão privada.
  Registrar metadados e ausência original dos alvos. Não restaurar arquivos de
  contas globais como mecanismo de rollback; não copiar dados comerciais.

## 2. Ordem de instalação e testes após cada etapa

**Todos os comandos abaixo são futuros, exclusivamente após autorização.**

1. A1: validar e instalar somente zz-kalend-audit-deny 0440 root:root.
   visudo -c deve passar e regra deve permanecer por último na política aplicável.
2. Criar apenas kalend_dev_audit, senha desabilitada, /bin/dash, grupo próprio;
   home root:root 0755. Conferir id/grupo exclusivo. Executar sudo -l -U auditor
   e consulta específica do wrapper como em A1; nenhuma execução privilegiada.
   A listagem inteira deve negar TODOS os comandos, não apenas o wrapper.
   Qualquer permissão inesperada bloqueia instalação de acesso.
3. A2: instalar somente comando forçado, SQL e diretório de chave; chave pública
   root:kalend_dev_audit 0640; diretório root:root 0755. Instalar fragmento
   /etc/ssh/sshd_config.d/90-kalend-audit.conf no Include confirmado, SEM reload.
   O nome não conflita com arquivos existentes. Não modificar sshd_config global.
   Executar check-audit-files.py do staging: exige paths root, sem symlinks,
   ACL/capability ou escrita por terceiros, modos corretos e grupo exclusivo.
4. A3: revalidar catálogos PUBLIC/SECURITY DEFINER/RLS; executar readonly-role.sql
   por stdin administrativo exclusivamente em kalend_dev. Conferir flags falsas,
   NOINHERIT/limite 2, nenhum membership/ownership e grants só nas três tabelas.
   Não testar permissões usando superuser, nem executar escrita comercial.
5. Preparar em staging uma cópia do HBA original com SOMENTE o bloco marcado
   da nova role, antes das regras genéricas. Revisar diff privado e metadados.
   Aplicar somente esse patch no hba_file confirmado, preservando owner/mode.
   Não substituir a política dos demais usuários ou alterar pg_ident.
   pg_hba_file_rules deve ficar sem erro e com ordem esperada; somente então
   SELECT pg_reload_conf() autorizado. Confirmar conexões não alvo preservadas.
6. A4: repetir checker, sshd -t e comparação sshd -T nos contextos root/clp/PROD/DEV
   e origens reais. Os não alvo devem continuar idênticos. Auditor: publickey,
   ForceCommand fixo, chave central, TTY/forwarding/rc/password/CA desabilitados.
   Só com todos os gates aprovados executar systemctl reload ssh.service.
   Não restart. Confirmar console e SSH administrativo continuam funcionais.
7. Estação sem root: executar apenas backfill-audit com host key previamente
   validada; guardar JSON em arquivo privado, validar integridade e código de saída.
   Comando inválido deve falhar sem shell. Não executar escrita de teste em PROD.
   Confirmar metadata/HBA negando outros bancos/TCP. A identidade ainda inexistente
   não foi conectada neste preflight: o aceite dinâmico pertence a essa etapa.
8. Comparar PIDs, HTTP e serviços antes/depois; nenhuma mudança em PM2/timers,
   aplicação, workers, dados comerciais ou outros sistemas. Conservar evidências.

## 3. Critérios de parada

Recuperação não comprovada; chave não aprovada; corrida administrativa; divergência
de hash/host/owner/path; symlink/ACL/capability; conta/role/arquivo preexistente;
erro de parser; sudo permitido; mudança de contexto não alvo; grants indevidos;
HBA incorreto; falha de login; relatório incompleto/RLS; degradação de serviço.
Não corrigir a VPS fora da autorização nem ampliar privilégios para passar checks.

## 4. Recuperação e rollback limitado

Usar o console comprovado se o SSH não permitir recuperação. A sessão SSH aberta
é precaução adicional, não garantia independente. Antes de qualquer reload,
remover apenas arquivos novos inválidos e desfazer o bloco marcado HBA; validar
parsers, sem restart. Depois de reload, mesma retirada limitada e reload específico
aprovado. Não restaurar sudoers/passwd/authorized_keys globais ou outros sites.

Bloquear ingresso retirando apenas nova chave/fragmento. Revogar grants exatos e
remover a role somente se criada nesta operação e sem dependências inesperadas;
sem DROP OWNED/REASSIGN OWNED global. Remover conta sem -r apenas após comprovar
que não há sessões/processos próprios; conservar backups. Manter negação sudo
até encerrar uso da identidade. Não matar processos de outros usuários.

## 5. Impacto e evidências de conclusão

Mudanças de configuração envolvem SSH (reload global de configuração, Match só
do auditor), sudoers (fragmento só do auditor) e PostgreSQL (nova role/ACL e reload
HBA). Portanto comparações dos usuários não alvo e console independente são gates.
Não há indisponibilidade planejada, mas não existe garantia absoluta contra erro
administrativo. Nginx/PM2/Redis/Docker/Evolution não recebem comandos de alteração.

Aceite requer hashes do pacote e configs, registro privado do backup, console
operacional, chave/fingerprint aprovada, id/grupos, sudo efetivamente negado,
checker e parsers aprovados, diffs limitados, flags/grants/HBA conferidos, login
forçado e comando inválido testados, JSON íntegro, HTTP/PIDs preservados. Não
promover o modelo de preflight a evidência de instalação. Backup comercial,
Fases B/C, migration e deploy continuam bloqueados e separados.


## Atualização posterior — preparação definitiva

Usuário relatou root/srv1119527 no Web Console; independência do SSH ainda pendente. Chave Ed25519 exclusiva agora preparada em audit.authorized_keys, fingerprint em audit-key-public.json; o exemplo não é usado na instalação. Aprovação da fingerprint e recuperação independente permanecem gates. Ver [preparação definitiva](PREPARACAO_FINAL_AUDITOR_2026-10-23.md). Não houve instalação.
