import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { qaRuntimeEnvironment, requireQaCommunicationAllowlist } from './qa-policy.js';

// The simulator stamps this namespace in the SAME transaction as the domain fact.
// Malformed QA namespaces are quarantined from commercial processing as well.
const simulation = 'QA_SIMULATION';
const test = 'QA_COMMUNICATION_TEST';
export function communicationEventScope(qaMode = false, requested?: string[]) {
  const simulationEnabled = qaRuntimeEnvironment() === 'DEV' &&
    process.env.COMMERCIAL_QA_SIMULATION_ENABLED === 'true';
  if (qaMode) {
    const allowed = requireQaCommunicationAllowlist().companyIds;
    if (requested?.some(id => !allowed.includes(id)))
      throw new ForbiddenException('QA_COMMUNICATION_SCOPE_MISMATCH');
    const companyIds = requested ?? allowed;
    const origins: Prisma.GlobalCommunicationOutboxWhereInput[] = [
      { event: test },
      { businessKey: { startsWith: `${test}:` } },
      ...(simulationEnabled ? [
        { businessKey: { startsWith: `${simulation}:` } },
        { variables: { path: ['source'], equals: simulation } },
      ] : []),
    ];
    return {
      where: { companyId: { in: companyIds }, OR: origins } satisfies Prisma.GlobalCommunicationOutboxWhereInput,
      sql: Prisma.sql`AND "companyId" IN (${companyIds.length ? Prisma.join(companyIds) : Prisma.sql`NULL`})
        AND (event = ${test} OR "businessKey" LIKE ${`${test}:%`}
          OR (${simulationEnabled} AND ("businessKey" LIKE ${`${simulation}:%`} OR variables->>'source' = ${simulation})))`,
    };
  }
  return {
    where: { AND: [
      { NOT: { OR: [
        { event: test },
        { businessKey: { startsWith: simulation } },
        { businessKey: { startsWith: test } },
      ] } },
      { OR: [
        { variables: { path: ['source'], equals: Prisma.AnyNull } },
        { NOT: { variables: { path: ['source'], equals: simulation } } },
      ] },
      ...(requested ? [{ companyId: { in: requested } }] : []),
    ] } satisfies Prisma.GlobalCommunicationOutboxWhereInput,
    sql: Prisma.sql`AND event <> ${test} AND "businessKey" NOT LIKE ${`${simulation}%`}
      AND "businessKey" NOT LIKE ${`${test}%`} AND COALESCE(variables->>'source', '') <> ${simulation}
      ${requested ? Prisma.sql`AND "companyId" IN (${requested.length ? Prisma.join(requested) : Prisma.sql`NULL`})` : Prisma.empty}`,
  };
}
