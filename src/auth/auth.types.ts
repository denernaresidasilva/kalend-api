import type { Request } from 'express';
export type AuthIdentity = {
  user: {
    id: string;
    name: string;
    email: string;
    isActive: boolean;
    isSuperAdmin: boolean;
  };
  session: {
    id: string;
    selectedCompanyId: string | null;
    expiresAt: Date;
    refreshExpiresAt: Date;
  };
};
export type AuthRequest = Request & {
  auth: AuthIdentity;
  tenant?: { companyId: string; membershipId: string; role: string };
};
