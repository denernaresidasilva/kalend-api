# Dependências CloudPanel — inventário obrigatório antes da fase B

Esta revisão não acessou a VPS. Não é possível afirmar, a partir dos arquivos locais, quem são TODOS os consumidores dinâmicos do wrapper. Aprovar sua remoção dos usuários existentes sem esse inventário seria indevido. A fase A usa uma identidade nova, sem dependência legítima de CloudPanel; a fase B permanece condicionada.

| Identidade / consumidor | Evidência disponível | Tratamento |
|---|---|---|
| root | Administração da VPS | Não alterar acesso ou sudo |
| clp | Wrapper faz su para clp; sudo amplo conhecido | Não alterar usuário, wrapper ou regra global |
| kalend-dev (1021) | Elegível para wrapper; app/PM2 frontend DEV | Negação só após inventário de SSH, cron, unidades, CloudPanel e código executado nessa identidade |
| kalend-api-dev (1022) | Elegível para wrapper; app/PM2 API DEV | Mesmo bloqueio; verificar também jobs/timers DEV sem executá-los |
| kalend / kalend-api | Contas PROD independentes | Não modificar privilégios, chaves, paths, processos ou testes ativos |
| Demais usuários Linux/sites | Regra ALL os torna elegíveis; dependência real desconhecida | Enumerar sob revisão humana; nenhuma negação global |
| CloudPanel PHP/CLI e rotinas de manutenção | Caminho clpctlWrapper → PHP CLI → clpctl conhecido | Inventariar unidades/cron/daemons e autorizações internas, sem executar comandos de gerenciamento |
| kalend_dev_audit (novo) | Não deve executar CloudPanel | Negação de sudo antes de habilitar qualquer chave; somente consulta SQL fixa |

## Coleta administrativa somente leitura — comandos para o operador

Executar apenas na futura sessão administrativa autorizada. Armazenar em diretório 0700, sem copiar logs/configurações integrais para Git. Não mostrar argumentos de comandos com credenciais.

```sh
getent passwd | awk -F: '{print $1, $3, $4, $6, $7}'
cat /etc/sudoers
find /etc/sudoers.d -maxdepth 1 -type f -printf '%f\n'
visudo -c
getent passwd | cut -d: -f1 | while IFS= read -r account; do
  sudo -l -U "$account"
done
# Só nomes dos arquivos com referências; revisar conteúdo em sessão privada.
grep -rlF -- 'clpctlWrapper' /etc/systemd/system /etc/cron.d /etc/cron.daily /etc/cron.hourly /usr/local/bin /usr/local/sbin /home/clp/htdocs/app 2>/dev/null
systemctl list-unit-files --no-pager
systemctl list-timers --all --no-pager
crontab -u kalend-dev -l
crontab -u kalend-api-dev -l
```

Incluir também cron via spool, unidades de usuário, scripts/chaves/rc de login, tarefas CloudPanel, processos em execução e sudo logs retidos. Logs podem conter tokens em argumentos; registrar apenas contagens/identidades e comandos redigidos. Mapear User/Group/ExecStart das unidades suspeitas sem iniciar serviços. Ausência de string em um scan não exclui construção dinâmica do comando, scripts externos, jobs futuros ou logs já rotacionados.

O inventário deve resultar em: usuários elegíveis, usuários com chamadas observadas, arquivos/unidades/timers consumidores, funções CloudPanel legítimas por usuário, janela de evidência/limites e parecer humano assinado. Se um usuário DEV precisa do wrapper para uma função legítima, NÃO aplicar !ALL às cegas. Separar essa administração de site para uma identidade controlada por humano e executar build/runtime sob conta sem caminho administrativo, ou preparar um confinamento de runtime revisado. Criar uma chave CI restrita ou uma conta de deploy separada não resolve se o código implantado continuar rodando numa conta administrativa.

Não é autorizável remover globalmente ALL/clp ou testar operações de modificação de outros sites para provar negação. A proteção é demonstrada por políticas efetivas, propriedade/ACL, grupos, capabilities e ausência de endpoints administrativos acessíveis ao caminho de deploy, não por tentativa de escrita em PROD.


Atualização local 23/10/2026: o inventário remoto histórico de 22/10 confirmou o caminho CloudPanel e serviços consumidores; não comprovou ausência de dependências dinâmicas. A fase A corrigida não altera identidades existentes. Ver seção 10 de INTERVENCAO_ADMINISTRATIVA.md para ACL sem ferramenta externa, chave 0640/grupo exclusivo e recuperação obrigatória ainda pendente. Este documento não autoriza execução remota nem instalação do sandbox.
