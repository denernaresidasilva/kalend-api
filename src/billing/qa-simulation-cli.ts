import { BadRequestException } from '@nestjs/common';
import {
  QA_TRANSITIONS,
  assertCommercialQaScope,
} from './qa-simulation.service.js';
import { string, uuid } from '../common/validation.js';
import type { QaSimulationService } from './qa-simulation.service.js';

export const QA_CLI_HELP = `DEV ONLY — Commercial QA Simulation
Read-only preflight:
  npm run billing:qa-simulate -- --company <uuid> --check
Create a catalog-priced QA attempt (stable key required):
  npm run billing:qa-simulate -- --company <uuid> --action PAYMENT_PENDING --plan <uuid> --interval MONTHLY --key <key>
Recovery attempt on its existing QA subscription:
  npm run billing:qa-simulate -- --company <uuid> --action PAYMENT_PENDING --subscription <uuid> --key <key>
Temporal override (DEV only, no environment mutation): append --grace-days <0..999> to PAYMENT_OVERDUE/PAYMENT_FAILED/SUBSCRIPTION_GRACE_PERIOD.
Transition/repeat an existing QA attempt:
  npm run billing:qa-simulate -- --company <uuid> --action <action> --payment <uuid>
Actions: ${QA_TRANSITIONS.join(', ')}
Requires DEV, COMMERCIAL_QA_SIMULATION_ENABLED=true, QA allowlist and active company.
No credentials, HTTP requests, external adapters or worker execution.
`;
type Command =
  | { mode: 'HELP' }
  | { mode: 'CHECK'; companyId: string }
  | {
      mode: 'SIMULATE';
      input: {
        companyId: string;
        action: string;
        paymentId?: string;
        planId?: string;
        billingInterval?: 'MONTHLY' | 'YEARLY';
        idempotencyKey?: string;
        subscriptionId?: string;
        graceDays?: number;
      };
    };

export function parseQaCli(args: readonly string[]): Command {
  if (args.length === 1 && args[0] === '--help') return { mode: 'HELP' };
  const names = [
    '--company',
    '--action',
    '--payment',
    '--plan',
    '--interval',
    '--key',
    '--check',
    '--subscription',
    '--grace-days',
  ];
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (!names.includes(name) || values.has(name))
      throw new BadRequestException('QA_CLI_ARGUMENT_INVALID');
    if (name === '--check') {
      values.set(name, 'true');
      continue;
    }
    const value = args[++index];
    if (!value || value.startsWith('--'))
      throw new BadRequestException('QA_CLI_ARGUMENT_INVALID');
    values.set(name, value);
  }
  const companyId = uuid(values.get('--company'));
  if (values.has('--check')) {
    if (values.size !== 2)
      throw new BadRequestException('QA_CLI_CHECK_ARGUMENT_INVALID');
    return { mode: 'CHECK', companyId };
  }
  const action = values.get('--action');
  if (!QA_TRANSITIONS.includes(action as (typeof QA_TRANSITIONS)[number]))
    throw new BadRequestException('QA_TRANSITION_INVALID');
  const graceDays = values.has('--grace-days')
    ? Number(values.get('--grace-days'))
    : undefined;
  if (
    graceDays !== undefined &&
    (!/^(0|[1-9]\d{0,2})$/.test(values.get('--grace-days')!) ||
      ![
        'PAYMENT_OVERDUE',
        'PAYMENT_FAILED',
        'SUBSCRIPTION_GRACE_PERIOD',
      ].includes(action!))
  )
    throw new BadRequestException('QA_GRACE_DAYS_INVALID');
  if (values.has('--payment')) {
    if (values.size !== (graceDays === undefined ? 3 : 4))
      throw new BadRequestException('QA_CLI_PAYMENT_ARGUMENT_INVALID');
    return {
      mode: 'SIMULATE',
      input: {
        companyId,
        action: action!,
        paymentId: uuid(values.get('--payment')),
        ...(graceDays === undefined ? {} : { graceDays }),
      },
    };
  }
  if (action !== 'PAYMENT_PENDING')
    throw new BadRequestException('QA_PAYMENT_REQUIRED');
  if (values.has('--subscription')) {
    if (values.size !== 4)
      throw new BadRequestException('QA_CLI_CREATION_ARGUMENT_INVALID');
    return {
      mode: 'SIMULATE',
      input: {
        companyId,
        action: action!,
        subscriptionId: uuid(values.get('--subscription')),
        idempotencyKey: string(values.get('--key'), 'idempotencyKey', 128),
      },
    };
  }
  if (
    values.size !== 5 ||
    !['MONTHLY', 'YEARLY'].includes(values.get('--interval') ?? '')
  )
    throw new BadRequestException('QA_CLI_CREATION_ARGUMENT_INVALID');
  return {
    mode: 'SIMULATE',
    input: {
      companyId,
      action,
      planId: uuid(values.get('--plan')),
      billingInterval: values.get('--interval') as 'MONTHLY' | 'YEARLY',
      idempotencyKey: string(values.get('--key'), 'idempotencyKey', 128),
    },
  };
}

/** Policy runs BEFORE constructing/connecting Prisma. Minimal context has no providers or workers. */
export async function runQaCli(
  args: readonly string[],
  open: () => Promise<{
    service: Pick<QaSimulationService, 'simulateFromCli' | 'preflightFromCli'>;
    close: () => Promise<void>;
  }>,
  output: (value: unknown) => void,
  env = process.env,
) {
  const command = parseQaCli(args);
  if (command.mode === 'HELP') {
    output(QA_CLI_HELP);
    return;
  }
  assertCommercialQaScope(
    command.mode === 'CHECK' ? command.companyId : command.input.companyId,
    env,
  );
  const context = await open();
  try {
    output(
      command.mode === 'CHECK'
        ? await context.service.preflightFromCli(command.companyId)
        : {
            execution: 'CLI',
            ...(await context.service.simulateFromCli(command.input)),
          },
    );
  } finally {
    await context.close();
  }
}

export function qaCliFailure(error: unknown) {
  const code =
    error instanceof Error && /^[A-Z][A-Z0-9_]{0,100}$/.test(error.message)
      ? error.message
      : 'COMMERCIAL_QA_CLI_FAILED';
  return { source: 'QA_SIMULATION', execution: 'CLI', status: 'BLOCKED', code };
}
