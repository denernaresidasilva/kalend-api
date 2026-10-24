# Política de execução KALEND — decisão do proprietário em 24/10/2026

- Desenvolver, investigar, corrigir, testar, documentar e criar commits locais autonomamente.
- Preservar modificações anteriores; não usar reset destrutivo, clean ou force push.
- Publicação, migration DEV real, deploy, reinício DEV e intervenção administrativa
  exigem a aprovação interativa da operação quando o ambiente disponibilizar esse mecanismo.
  Não solicitar aprovação para tarefas locais rotineiras. Se a interface não permitir
  aprovação, informar a limitação; não fingir um Yes nem usar ausência de bloqueio como consentimento.
- Manter GitHub Actions por push em develop. Não desabilitar Actions, substituir o
  deploy por execução manual ou alterar YAML sem necessidade comprovada.
- Aprovação não permite atingir PROD, main, outros projetos, bancos ou serviços globais.
  Antes de migration real, verificar identidade, privilégios, banco-alvo e backup atualizado.
- Após publicação, homologar com QA/sandbox; corrigir localmente e repetir testes relevantes.
  Cada nova publicação passa pelo seu controle de aprovação. Não declarar jornadas não testadas.
- Após publicar Super Admin, revisar gateways com documentação oficial atualizada,
  formulários próprios, credenciais protegidas e testes sandbox. Sem cobranças reais
  ou mensagens para clientes sem autorização específica.
- Prioridade: publicação DEV e homologação Super Admin; depois gateways, painéis e
  aplicativos. Não antecipar os demais painéis enquanto o núcleo crítico não estiver homologado.

## Estado local desta aplicação da política

YAMLs restaurados byte a byte aos últimos deploys remotos bem-sucedidos: API
b1cc220a e Web 4d86829b. Somente arquivos locais foram alterados. As duas regressões
sobre a proposta manual anterior foram substituídas por testes da decisão atual:
preservação exata do workflow e validação bash -n dos scripts SSH sem executá-los.
Os demais gates de falha/recuperação permanecem. 18 grupos de testes aprovados,
manifesto SHA256 e git diff --check válidos. Nenhuma operação remota foi executada.
A conta SQL compartilhada e o caminho sudo CloudPanel seguem bloqueando a publicação;
a aprovação interativa não substituirá sua correção e comprovação.
