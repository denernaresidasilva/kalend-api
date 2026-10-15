import 'dotenv/config';
import { assertCommercialQaScope } from './qa-simulation.service.js';
import { createQaLifecycleFixture } from './qa-lifecycle-fixture.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { uuid } from '../common/validation.js';
import { qaCliFailure } from './qa-simulation-cli.js';

try {
  const args = process.argv.slice(2);
  if (
    args.length !== 4 ||
    args[0] !== '--source-company' ||
    args[2] !== '--key'
  )
    throw new Error('QA_FIXTURE_ARGUMENT_INVALID');
  const source = uuid(args[1]);
  assertCommercialQaScope(source); // Before constructing Prisma; never runs in PROD.
  const db = new PrismaService();
  try {
    console.log(
      JSON.stringify(await createQaLifecycleFixture(db, source, args[3])),
    );
  } finally {
    await db.$disconnect();
  }
} catch (error) {
  console.error(JSON.stringify(qaCliFailure(error)));
  process.exitCode = 1;
}
