# Contador e painéis operacionais

Novo papel ACCOUNTANT, com acesso exclusivo de leitura ao relatório financeiro da empresa selecionada. Nenhum papel é atribuído automaticamente a usuários existentes. TenantGuard/ProductAccessGuard permanecem; mutações de caixa/comanda/desconto/estorno/comissão não incluem ACCOUNTANT. Cobranças SaaS e administração global continuam protegidas pelos guards anteriores.

Relatório por período de até um ano no fuso da empresa, snapshot RepeatableRead, agregados de todos os recebimentos/estornos/comissões pagas e listagem limitada, declarada na interface. CSV protege células que poderiam virar fórmula. São fluxos operacionais registrados, não declaração fiscal ou cálculo de lucro. Dados de contato/senha de clientes não são retornados.

Proprietário/recepção mantêm atendimento, produtos, comandas e caixa; profissional executa seus próprios serviços e acompanha comissões; proprietário/admin gerenciam descontos/regras/estornos. O novo painel do contador usa somente GET e exportação local. Histórico de auditoria/recibos permanece imutável.

Testes locais: cenário nativo de relatório por empresa, recusa de mutações para ACCOUNTANT e datas inválidas; suíte unitária API 930/930, build/lint/tipos aprovados. Fase anterior de comissões publicada: API e60edff / Actions 41509561472, Web 72cb875 / Actions 41509888433; três jornadas reais incluindo painel profissional mobile e recuperação de comissão já paga após estorno via SSE. Backup atualizado/restaurado: 50 tabelas/25 migrations/5 PaymentEvidence.
