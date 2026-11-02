# Gestão operacional do proprietário

API: listagem de membros elegíveis e profissionais da empresa, criação de serviços com vínculos atômicos, edição de nome/categoria/descrição/preço/duração/publicação/estado e vínculos, ativação/desativação de profissionais e substituição explícita de disponibilidade semanal. OWNER/ADMIN gerenciam; recepção pode consultar profissionais; CLIENT/PROFESSIONAL não recebem a lista administrativa de membros nem mutações de configuração.

Limite de profissionais é verificado na mesma transação Serializable da criação/reativação. Duplicatas têm conflito de domínio e não sobrescrevem perfis. Catálogo, disponibilidade e pedidos ignoram memberships que perderam papel profissional. Preços/durações/nomes antigos ficam nos snapshots dos itens; despublicar não apaga agendamentos nem histórico. UI usa somente dados persistidos e não cria contas/eleva papéis.

27 cenários PostgreSQL: 26 passaram na bateria, depois o novo caso de duplicata passou isoladamente. Incluem rollback integral de edição com vínculo estrangeiro, preservação de snapshots, limites e membership revogado. API build/lint e 47 testes direcionados aprovados; Web build/lint/tipos e 407 testes aprovados. A homologação real acompanha a publicação. Nenhuma migration nova nesta fase.

Ainda não implementado nesta gestão: convite/cadastro completo de novos colaboradores, múltiplas janelas na UI de edição semanal (backend aceita), bloqueios/férias, reagendamento/cancelamento do cliente e fechamento de atendimento. Painéis do proprietário/profissional/recepção oferecem núcleo funcional de inbox e agenda, e cliente oferece ativação e histórico, sem alegação de painéis completos. Contador e PDV continuam em fases seguintes.
