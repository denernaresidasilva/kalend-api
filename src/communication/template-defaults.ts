import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { EVENTS, type Channel } from './contracts.js';
import type { Prisma } from '@prisma/client';

type Copy = { subject?: string; title?: string; text: string };
type EventCopy = { EMAIL: Copy; WHATSAPP: Copy; PUSH: Copy };
type DefaultEvent = (typeof EVENTS)[number];

const footer = '\n\nKalend\nOrganize. Atenda. Cresça.';
export const DEFAULT_TEMPLATE_COPY: Record<DefaultEvent, EventCopy> = {
  OWNER_WELCOME: {
    EMAIL: { subject: 'Bem-vindo ao Kalend! Sua conta está pronta.', text: 'Olá, {{nome}}!\n\nSua conta no Kalend foi criada com sucesso.\n\nEmpresa: {{empresa}}\nPlano: {{plano}}\nTeste grátis até: {{vencimento}}\n\nAcesse sua conta pelo endereço oficial do Kalend e comece a configurar seu negócio. Nenhuma senha ou código de acesso será enviado por e-mail.\n\nEquipe Kalend.' + footer },
    WHATSAPP: { text: 'Olá, {{nome}}! 👋\n\nSeja bem-vindo ao *Kalend*. ✨\n\nA empresa *{{empresa}}* já está pronta para começar.\n\nAgora você pode configurar:\n\n📅 Agenda\n👥 Equipe\n✂️ Serviços\n🕐 Horários\n📲 Comunicações\n📊 Gestão da empresa\n\nAcesse o Kalend e comece suas configurações.\n\nBem-vindo! 🚀' },
    PUSH: { title: 'Bem-vindo ao Kalend! 🎉', text: 'A empresa {{empresa}} está pronta. Comece agora a configurar seu Kalend.' },
  },
  TRIAL_STARTED: {
    EMAIL: { subject: 'Seu período de teste no Kalend começou 🚀', text: 'Olá, {{nome}}!\n\nO período de teste da empresa {{empresa}} foi iniciado.\n\nEste é o momento ideal para conhecer os recursos do Kalend e configurar sua operação.\n\nConfigure seus serviços, horários, equipe e agenda para aproveitar melhor sua experiência.\n\nDurante o período de teste você poderá conhecer os recursos disponíveis e decidir qual plano combina melhor com sua empresa.' + footer },
    WHATSAPP: { text: 'Olá, {{nome}}! 🚀\n\nO período de teste da *{{empresa}}* no Kalend começou.\n\nAproveite para configurar:\n\n📅 Agenda\n✂️ Serviços\n👥 Equipe\n🕐 Horários\n📲 Comunicações\n\nExplore o Kalend e conheça os recursos disponíveis para sua empresa.' },
    PUSH: { title: 'Seu teste começou 🚀', text: 'Explore o Kalend e configure a {{empresa}} durante seu período de teste.' },
  },
  TRIAL_EXPIRING: {
    EMAIL: { subject: 'Seu período de teste está chegando ao fim', text: 'Olá, {{nome}}!\n\nO período de teste da empresa {{empresa}} está próximo do fim.\n\nEsperamos que você esteja aproveitando o Kalend para organizar melhor sua operação.\n\nPara continuar utilizando os recursos do sistema sem interrupções, acesse sua conta e escolha o plano mais adequado para sua empresa.\n\nVocê poderá consultar os planos e regularizar sua assinatura diretamente pelo Kalend.' + footer },
    WHATSAPP: { text: 'Olá, {{nome}}! ⏰\n\nO período de teste da *{{empresa}}* está chegando ao fim.\n\nPara continuar utilizando o Kalend sem interrupções, acesse sua conta e escolha o plano ideal para sua empresa.' },
    PUSH: { title: 'Seu teste está terminando ⏰', text: 'Escolha um plano para continuar utilizando o Kalend sem interrupções.' },
  },
  TRIAL_EXPIRED: {
    EMAIL: { subject: 'Seu período de teste no Kalend terminou', text: 'Olá, {{nome}}!\n\nO período de teste da empresa {{empresa}} chegou ao fim.\n\nSua conta continua disponível para que você possa escolher um plano e regularizar o acesso.\n\nAcesse o Kalend, consulte os planos disponíveis e escolha a opção ideal para continuar utilizando a plataforma.\n\nAssim que a assinatura for regularizada, os recursos correspondentes ao plano serão liberados novamente.' + footer },
    WHATSAPP: { text: 'Olá, {{nome}}!\n\nO período de teste da *{{empresa}}* chegou ao fim.\n\nVocê ainda pode acessar o Kalend para escolher um plano e regularizar sua assinatura.\n\nAssim que a regularização for concluída, seu acesso será liberado conforme o plano contratado. 🚀' },
    PUSH: { title: 'Seu período de teste terminou', text: 'Escolha um plano para continuar utilizando o Kalend.' },
  },
  PAYMENT_PENDING: {
    EMAIL: { subject: 'Pagamento pendente no Kalend', text: 'Olá, {{nome}}!\n\nIdentificamos um pagamento pendente relacionado à assinatura da empresa {{empresa}}.\n\nSe você já realizou o pagamento, aguarde a confirmação do processamento.\n\nCaso ainda não tenha concluído, acesse o Kalend para verificar os detalhes e finalizar a regularização.' + footer },
    WHATSAPP: { text: 'Olá, {{nome}}! 💳\n\nExiste um pagamento pendente relacionado à assinatura da *{{empresa}}*.\n\nSe você já efetuou o pagamento, aguarde a confirmação.\n\nCaso contrário, acesse o Kalend para consultar e regularizar a situação.' },
    PUSH: { title: 'Pagamento pendente', text: 'Existe um pagamento pendente para a assinatura da {{empresa}}.' },
  },
  PAYMENT_APPROVED: {
    EMAIL: { subject: 'Pagamento aprovado ✅', text: 'Olá, {{nome}}!\n\nO pagamento relacionado à assinatura da empresa {{empresa}} foi aprovado com sucesso.\n\nSua assinatura está regularizada conforme as condições do plano contratado.\n\nObrigado por continuar com o Kalend.' + footer },
    WHATSAPP: { text: 'Olá, {{nome}}! ✅\n\nPagamento aprovado!\n\nA assinatura da *{{empresa}}* foi regularizada com sucesso.\n\nObrigado por continuar com o Kalend. 🚀' },
    PUSH: { title: 'Pagamento aprovado ✅', text: 'O pagamento da {{empresa}} foi confirmado com sucesso.' },
  },
  PAYMENT_FAILED: {
    EMAIL: { subject: 'Não foi possível concluir seu pagamento', text: 'Olá, {{nome}}!\n\nNão foi possível concluir o pagamento relacionado à assinatura da empresa {{empresa}}.\n\nIsso pode acontecer por diferentes motivos relacionados ao método de pagamento utilizado.\n\nAcesse sua conta no Kalend para verificar a situação e tentar novamente.' + footer },
    WHATSAPP: { text: 'Olá, {{nome}}!\n\n⚠️ Não conseguimos concluir o pagamento da assinatura da *{{empresa}}*.\n\nAcesse o Kalend para verificar a situação e tentar novamente.' },
    PUSH: { title: 'Falha no pagamento', text: 'Não foi possível concluir o pagamento da {{empresa}}. Verifique sua conta.' },
  },
  PAYMENT_OVERDUE: {
    EMAIL: { subject: 'Pagamento em atraso no Kalend', text: 'Olá, {{nome}}!\n\nIdentificamos que existe um pagamento em atraso relacionado à assinatura da empresa {{empresa}}.\n\nPara evitar limitações ou interrupção dos serviços, acesse sua conta e regularize a situação.\n\nSe o pagamento já foi realizado, aguarde a confirmação.' + footer },
    WHATSAPP: { text: 'Olá, {{nome}}! ⚠️\n\nExiste um pagamento em atraso relacionado à assinatura da *{{empresa}}*.\n\nAcesse o Kalend para regularizar e evitar interrupções no serviço.' },
    PUSH: { title: 'Pagamento em atraso ⚠️', text: 'Regularize a assinatura da {{empresa}} para evitar interrupções.' },
  },
  SUBSCRIPTION_GRACE_PERIOD: {
    EMAIL: { subject: 'Sua assinatura entrou no período de tolerância', text: 'Olá, {{nome}}!\n\nA assinatura da empresa {{empresa}} entrou no período de tolerância.\n\nDurante esse período, recomendamos que você regularize a situação o quanto antes para evitar a suspensão do acesso aos recursos do Kalend.\n\nAcesse sua conta para verificar a assinatura e concluir a regularização.' + footer },
    WHATSAPP: { text: 'Olá, {{nome}}! ⏳\n\nA assinatura da *{{empresa}}* entrou no período de tolerância.\n\nRegularize sua assinatura o quanto antes para evitar a suspensão do acesso ao Kalend.' },
    PUSH: { title: 'Período de tolerância ⏳', text: 'Regularize a assinatura da {{empresa}} para evitar a suspensão.' },
  },
  SUBSCRIPTION_SUSPENDED: {
    EMAIL: { subject: 'Assinatura suspensa no Kalend', text: 'Olá, {{nome}}!\n\nA assinatura da empresa {{empresa}} foi suspensa.\n\nSeu acesso aos recursos comerciais do Kalend pode estar temporariamente limitado.\n\nVocê ainda pode acessar sua conta para verificar a situação da assinatura, escolher um plano ou regularizar o pagamento.\n\nAssim que a situação for regularizada, o acesso poderá ser restabelecido conforme as regras da assinatura.' + footer },
    WHATSAPP: { text: 'Olá, {{nome}}!\n\nA assinatura da *{{empresa}}* foi suspensa.\n\nSeu acesso ao Kalend pode estar limitado, mas você ainda pode entrar na conta para regularizar a situação.' },
    PUSH: { title: 'Assinatura suspensa', text: 'Acesse o Kalend para regularizar a assinatura da {{empresa}}.' },
  },
  SUBSCRIPTION_REACTIVATED: {
    EMAIL: { subject: 'Sua assinatura foi reativada ✅', text: 'Olá, {{nome}}!\n\nA assinatura da empresa {{empresa}} foi reativada com sucesso.\n\nO acesso aos recursos correspondentes ao seu plano está novamente disponível.\n\nObrigado por continuar com o Kalend.' + footer },
    WHATSAPP: { text: 'Olá, {{nome}}! 🎉\n\nA assinatura da *{{empresa}}* foi reativada com sucesso.\n\nSeu acesso aos recursos do Kalend está novamente disponível. ✅' },
    PUSH: { title: 'Assinatura reativada ✅', text: 'A assinatura da {{empresa}} foi reativada com sucesso.' },
  },
  SUBSCRIPTION_CANCELLED: {
    EMAIL: { subject: 'Sua assinatura foi cancelada', text: 'Olá, {{nome}}!\n\nA assinatura da empresa {{empresa}} foi cancelada.\n\nVocê poderá consultar sua conta e as opções disponíveis no Kalend caso queira contratar ou reativar um plano novamente.\n\nAgradecemos por ter utilizado o Kalend.' + footer },
    WHATSAPP: { text: 'Olá, {{nome}}!\n\nA assinatura da *{{empresa}}* foi cancelada.\n\nCaso queira utilizar o Kalend novamente, acesse sua conta para consultar as opções disponíveis.\n\nEsperamos ter você de volta em breve.' },
    PUSH: { title: 'Assinatura cancelada', text: 'A assinatura da {{empresa}} foi cancelada. Consulte sua conta para ver as opções disponíveis.' },
  },
  SECURITY_PASSWORD_CHANGED: {
    EMAIL: { subject: 'Sua senha do Kalend foi alterada', text: 'Olá, {{nome}}!\n\nA senha da sua conta Kalend foi alterada com sucesso.\n\nSe você realizou essa alteração, nenhuma ação adicional é necessária.\n\nSe você não reconhece essa alteração, recomendamos que revise imediatamente a segurança da sua conta.' + footer },
    WHATSAPP: { text: 'Olá, {{nome}}! 🔐\n\nA senha da sua conta Kalend foi alterada com sucesso.\n\nSe foi você, nenhuma ação é necessária.\n\nSe você não reconhece essa alteração, revise a segurança da sua conta imediatamente.' },
    PUSH: { title: 'Senha alterada 🔐', text: 'A senha da sua conta Kalend foi alterada.' },
  },
};

const providerFor: Record<Channel, 'SMTP' | 'EVOLUTION' | 'PUSH_PENDING'> = {
  EMAIL: 'SMTP',
  WHATSAPP: 'EVOLUTION',
  PUSH: 'PUSH_PENDING',
};

export const GLOBAL_TEMPLATE_DEFAULTS = EVENTS.flatMap((event) =>
  (['EMAIL', 'WHATSAPP', 'PUSH'] as const).map((channel) => ({
    scope: 'GLOBAL' as const,
    event,
    channel,
    provider: providerFor[channel],
    enabled: true,
    content: DEFAULT_TEMPLATE_COPY[event][channel],
  })),
);

@Injectable()
export class GlobalTemplateDefaults {
  constructor(@Inject(PrismaService) private readonly db: PrismaService) {}

  async ensure(db: Pick<Prisma.TransactionClient, 'globalCommunicationTemplate'> = this.db) {
    const result = await db.globalCommunicationTemplate.createMany({
      data: GLOBAL_TEMPLATE_DEFAULTS,
      skipDuplicates: true,
    });
    return result.count;
  }
}
