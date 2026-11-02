# Fidelidade operacional

Programa desativado por padrão e isolado por empresa. Proprietário/admin configura valor mínimo pago, pontos por valor completo e bônus de indicação. Cartão virtual disponível apenas ao próprio cliente autenticado/ativado. Código aleatório, sem dados pessoais. Código de indicação deve ser registrado pelo próprio indicado antes do primeiro atendimento finalizado; autoindicação, empresa diferente e troca posterior são rejeitadas.

Confirmação atômica junto à finalização da comanda: exige cliente ativado, ao menos um serviço concluído, todos os serviços concluídos e pagamento líquido integral. Apenas produtos, comandas abertas e clientes não ativados não pontuam. Indicação permanece pendente até a primeira conclusão qualificada. Não há concessão retroativa nem resgate/conversão financeira automática.

Ledger somente de acréscimo, chave única por comanda/indicação. Regras e base congeladas por lançamento. Estornos reduzem proporcionalmente os pontos da comanda, zerando abaixo do mínimo; bônus da indicação é revertido abaixo do mínimo. Histórico preservado. Alterar/desativar regras não impede reversão dos pontos antigos. Mensagem de confirmação reutiliza Outbox existente e consentimentos.

Validação local: testes PostgreSQL real em cluster efêmero (29 casos operacionais), build/lint API e Web e regressões. Publicação exclusivamente develop/Actions DEV; migration aditiva, backup DEV restaurado com sucesso antes da publicação. SaaS, PROD e outros projetos preservados.
