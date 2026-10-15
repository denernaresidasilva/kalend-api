import { ForbiddenException } from '@nestjs/common';

export type CompanyEligibility = {
  administrativeStatus: string;
  status: string;
  isActive: boolean;
};
export function administrativelyActive(
  company: Pick<CompanyEligibility, 'administrativeStatus'> | null | undefined,
) {
  return company?.administrativeStatus === 'ACTIVE';
}
export function assertAdministrativeAccess(
  company: Pick<CompanyEligibility, 'administrativeStatus'> | null | undefined,
) {
  if (!administrativelyActive(company))
    throw new ForbiddenException('COMPANY_ADMINISTRATIVELY_BLOCKED');
}
export function qaRecoverableCompany(
  company: CompanyEligibility | null | undefined,
) {
  return (
    !!company &&
    administrativelyActive(company) &&
    ((company.isActive && ['ACTIVE', 'TRIAL'].includes(company.status)) ||
      company.status === 'SUSPENDED')
  );
}
