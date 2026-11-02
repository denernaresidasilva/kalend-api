# Cliente: ativação e painel — 02/11/2026

Estado: implementação concluída localmente; publicação e evidências DEV registradas após Actions.

## Fluxo

Proprietário/admin/recepção emitem convite para um perfil de cliente da própria empresa. O token aleatório de 256 bits só é mostrado nessa resposta; o banco guarda SHA-256, autor e prazo de 24 horas. Reemissão invalida o anterior. Link usa fragmento da URL, removido da barra ao abrir a tela, e não envia token em query string ou por canal externo. O operador compartilha o link após conferir o contato do cliente; não há envio nem comprovação automática de e-mail/WhatsApp.

Ativação exige token válido, e-mail do perfil, senha e aceite de termos. Nova identidade recebe somente CLIENT na empresa do convite. Conta existente exige a senha atual: não há reset implícito, alteração de privilégios existentes, reativação de membership revogado ou associação por mera coincidência de e-mail. Consumo transacional com lock e repetição limitada impede uso simultâneo. Não é criada sessão automaticamente; login continua pelo fluxo existente. Termos são registrados sem sobrescrever consentimentos anteriores.

`GET /booking/my-requests` deriva empresa e usuário da sessão, nunca de IDs enviados no navegador. Retorna somente o histórico ligado ao cliente ativado e o fuso da empresa. Painel cliente trata troca de tenant e consultas obsoletas. Perfis já ativados exigem autenticação do mesmo usuário para novos pedidos públicos; informar o e-mail/telefone não concede esse direito.

Migration aditiva `20261102190000_customer_activation`: vínculo opcional CustomerProfile → User e tabela CustomerActivation com FK composta ao cliente/empresa, hash único e vínculo ao autor. Nenhum backfill comercial, DDL PROD ou modificação de migration aplicada.

## Correções de integração

- Agenda pública e ativação não redirecionam para login quando a consulta opcional de sessão anônima expira; proteção dos painéis permanece.
- Página pública permite usar cookies de identidade já autenticada na submissão de perfil ativado.
- Contrato do catálogo retorna nome público do profissional no campo esperado pela Web.
- Carrinho desabilita horários que se sobrepõem aos itens selecionados e respeita oito serviços.

## Verificações

21 casos PostgreSQL 16.15 nativos em cluster local descartável, incluindo uso único, expiração/rotação, e-mail diferente, consentimento, concorrência, preservação da senha/OWNER existente, negações de identidade pública e isolamento do histórico. Prisma validate/generate e builds/lints aprovados. API unitária 927/927; Web 407/407. E2E completa encontrou 5 falhas em 253 casos, todas na fixture financeira que subtraía 30 dias para representar um mês: no dia 02/11 isso criava fim de período futuro. Corrigida somente a fixture para ancorar expiração em uma hora atrás, sem alterar regras comerciais; os 38 casos desse arquivo passaram na reexecução, e os outros 215 casos já haviam passado na execução completa.

Backup DEV atualizado/restaurado após a fase SSE: 37 tabelas públicas, 22 migrations e 5 PaymentEvidence. Preflight de migration usa o mesmo guard kalend_dev_migrator e fluxo develop → Actions. Nenhuma mensagem, cobrança, conta real ou configuração administrativa foi alterada.
