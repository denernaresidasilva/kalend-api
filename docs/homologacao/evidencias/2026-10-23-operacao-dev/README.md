# Preparação operacional DEV — sem instalação

Opção A delimitada escolhida; B exige as mesmas garantias contra CloudPanel e
credenciais legadas ou confinamento maior. Nenhum teste financeiro foi repetido.
Leituras reais: nft instalado/UFW ativo, sub-UIDs DEV existentes e disjuntos,
API ainda na role compartilhada; timer DEV ativo. Nenhum secret/valor/hash de
credencial foi impresso. Não se modificou a VPS nem GitHub.

18 grupos unitários de gates/ordem/promoção/falhas, 5 controles nft reais em nova
network namespace e 11 verificações SQL/ownership/HBA em cluster descartável
aprovados. Outros UID/porta de fixture preservados; OTHER DB sintético preservado;
rollback de ownership pré-schema restaurou dono original e removeu só roles novas.
Todos os testes foram locais. Visudo, systemd verify, YAML e Bash aprovados.

GitHub: develop remoto API b1cc220 e Web 4d86829. Um workflow em develop de cada
repo, nenhum em main; 29/22 runs retornados, todos concluídos na coleta. Não se
confunde isso com pause de futuros runs. Hooks/Apps/Actions permissions precisam
do administrador; conector não fornece esses endpoints. Arquivos locais novos
não modificam os gatilhos remotos. workflow_dispatch em branch não default não
é assumido como mecanismo funcional; o plano é humano e gate local sem SSH CI.

Procedimento exato: ../../operacao-dev/PROCEDIMENTO_UNICO.md. Não executa por si.
JSONs de gates não são fronteira de segurança nem comprovam controles instalados.
O helper de promoção não roda como root, não inicia apps, não restaura DB e não
substitui a verificação de integridade de artefatos. Backups reais não entram aqui.
