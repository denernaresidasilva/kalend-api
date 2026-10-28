# KALEND — Núcleo operacional de agenda, fase 1

**Estado:** implementado e validado localmente; ainda não publicado em DEV.

## Escopo entregue

- Catálogo público por slug em `GET /public/booking/:slug/catalog`.
- Disponibilidade semanal em `GET /public/booking/:slug/availability`.
- Solicitação pública de um ou mais serviços em `POST /public/booking/:slug/requests`.
- Inbox autenticada e isolada pelo tenant selecionado em `GET /booking/requests`.
- Aprovação e recusa com revalidação transacional em `POST /booking/requests/:id/accept` e `/reject`.
- Consulta e criação de serviços, associação de profissional e configuração semanal de disponibilidade.
- Configuração inicial atômica de um serviço, membership profissional existente e horários.
- Painel do proprietário com configuração inicial e inbox; painéis de recepção e profissional com inbox filtrada.
- Rota pública responsiva `/agendar/[slug]` com catálogo, seleção de profissional/horário, carrinho, identificação do cliente e solicitação.

## Segurança e integridade

- Rotas internas usam `TenantGuard`, `ProductAccessGuard` e papéis permitidos. O backend deriva o tenant da sessão e nunca aceita `companyId` do navegador para decidir o escopo.
- A identidade profissional precisa ser um membership ativo da mesma empresa. O cadastro público cria somente perfil de cliente da empresa, não cria conta global, sessão ou privilégios.
- Serviços, profissionais, clientes, solicitações e itens carregam `companyId`; FKs compostas impedem associação de registros de tenants diferentes.
- Cadastro público exige origem permitida, rate limit, consentimento de termos e idempotency key. Respostas públicas não incluem e-mail nem telefone do cliente.
- Preço, duração e nome do serviço são obtidos no banco e guardados como snapshot; valores enviados pelo navegador não controlam a solicitação.
- Slots são convertidos pelo fuso horário da empresa e validados novamente na criação e aprovação. Horários passados, janelas inválidas, sobreposição do cliente, do profissional e conflitos entre requests são bloqueados.
- Locks transacionais PostgreSQL são ordenados por profissional e cliente. Transações usam `Serializable`; criação repete conflitos de serialização de forma limitada. Aprovação só transiciona de `REQUESTED` uma vez.
- Solicitações pendentes reservam provisoriamente o intervalo por 10 minutos; após isso, o pedido continua registrado, a retenção do horário expira e a aprovação ainda precisa revalidar conflitos.
- Notificações persistidas são criadas para OWNER, ADMIN e RECEPCIONIST ativos. A inbox consulta novas solicitações a cada 30 segundos.

## Migration

`prisma/migrations/20261028110000_operational_booking_core`

É aditiva, transacional, não contém backfill de dados comerciais e cria os modelos operacionais e suas constraints. Foi validada por `prisma validate` e aplicada em PGlite descartável com tabelas-base mínimas. Foram conferidas as sete tabelas operacionais e uma referência cruzada entre empresas foi rejeitada pela FK composta.

PGlite não valida concorrência multiconexão PostgreSQL nativo. A migration não foi aplicada em `kalend_dev` ou `kalend`.

## Testes locais

- API: build e lint aprovados; 913 testes aprovados na última execução completa.
- Web: TypeScript, lint, build e 403 testes aprovados.
- Navegador Chromium local, viewport 390 px: catálogo → horário → carrinho → formulário → resposta de sucesso, sem overflow horizontal. As respostas HTTP foram fixtures mockadas; este teste não prova persistência ou integração real com a API.
- Capturas locais: `/tmp/kalend-booking-mobile.png` e `/tmp/kalend-booking-desktop.png`.

## Limitações e próxima fase

- Não publicado e não testado em DEV real. Nenhuma migration real foi aplicada.
- A execução de concorrência ainda requer teste em PostgreSQL nativo com conexões independentes.
- A atualização da inbox é polling, sem WebSocket/SSE e sem popup modal.
- A solicitação pública não envia e-mail, WhatsApp ou Push e não associa/ativa identidade global do cliente. A notificação interna é persistida, mas não representa entrega por canal.
- O catálogo público ainda não implementa busca/filtros/categorias avançados, imagens, bloqueios/férias/feriados nem subdomínio do estabelecimento.
- O proprietário consegue configurar o primeiro serviço e profissional; CRUD completo de equipe, serviços, clientes e agenda permanece pendente.
- Cancelamento, reagendamento, recorrência, confirmação do cliente, PDV, caixa, comandas, pagamentos, comissões, relatórios, fidelidade, painéis completos de cliente/contador e PWA operacional não fazem parte desta fase.
- A identidade de deploy DEV e os privilégios administrativos efetivos do executor não foram revalidados nesta sessão. O workflow de API roda `npm ci`, `prisma migrate deploy`, build e restart como `kalend-api-dev`; por isso não houve push automático nesta fase. O risco previamente identificado de `clpctlWrapper` permanece um controle operacional pendente, não foi alterado.

## Alterações

API: schema e migration operacionais, módulo/controller/service de booking, guards e rate limit, regressões de domínio e timeout adequado para testes PGlite existentes.

Web: rota pública `/agendar/[slug]`, carrinho e formulário, painéis do proprietário/recepção/profissional ligados à inbox, setup inicial e estilos responsivos.
