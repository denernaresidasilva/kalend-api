import type { PaymentStatus, SubscriptionStatus } from '@prisma/client';

export type CommercialTrial = {
  active: boolean;
  endsAt: Date | null;
  expired: boolean;
  remainingDays: number;
};

export type CommercialFinancial = {
  requiresAction: boolean;
  status: SubscriptionStatus | null;
  paymentStatus: PaymentStatus | null;
};

export type CommercialContext = {
  systemRole: 'SUPER_ADMIN' | 'USER';
  role: import('@prisma/client').MembershipRole | null;
  commercialApplicable: boolean;
};
