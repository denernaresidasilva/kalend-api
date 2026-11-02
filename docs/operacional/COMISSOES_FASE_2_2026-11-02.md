# Comissões operacionais

Regra por profissional/serviço, percentual ou fixa, com snapshot na geração. Previsões usam regras vigentes e descontos rateados exatamente em centavos entre todos os itens. Valor fixo é limitado ao líquido do item; serviço integralmente gratuito não gera comissão a pagar. Geração acontece somente na finalização legítima da comanda, uma vez por item. Mudanças posteriores da regra não reescrevem valores gerados.

Estados GENERATED → liberação autorizada → PAYABLE → pagamentos parciais/PAID. OWNER/ADMIN configuram, liberam, ajustam e registram pagamentos conferidos. Profissional consulta somente suas previsões/comissões/pagamentos/histórico. Ajustes e pagamentos são append-only; uma chave idempotente não pode ser usada com outro payload.

Estornos recalculam o ganho proporcionalmente ao recebimento líquido da comanda, preservando o valor originalmente gerado e o histórico de pagamentos. Devoluções anteriores à finalização que foram repostas não diminuem indevidamente a comissão. Valores já pagos a maior aparecem como saldo a recuperar; não há débito automático em outras comissões. Pagamento de comissão em dinheiro entra como saída no caixa corrente e exige saldo; transferências não afetam dinheiro físico.

Validação local: 20 cenários PostgreSQL nativos operacionais, incluindo seis específicos de comissões e regressão dos 14 anteriores. Três testes de domínio cobrem centavos e limites monetários com BigInt. Build/lint aprovados e 40 testes direcionados API; Web: tipos/lint/build e 411 testes. Backup DEV restaurado antes da publicação: 46 tabelas/24 migrations/5 PaymentEvidence.

Fase 1 publicada: API 40e9640 / Actions 41507806192, Web a9bfced / Actions 41507993716, ambos sucesso. Quatro jornadas reais DEV aprovadas (isolamento, atendimento mobile, pagamentos divididos e finalização, estorno e fechamento de caixa). Uma primeira tentativa browser parou em seletor de método antes de haver recebimento; a fixture existente foi preservada, o seletor corrigido e a jornada retomada com sucesso. As evidências ficam no relatório operacional; nenhuma cobrança remota ou mensagem externa foi efetuada.
