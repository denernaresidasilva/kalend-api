import 'reflect-metadata';
import 'dotenv/config';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service.js';
import { QaSimulationService } from './qa-simulation.service.js';
import { qaCliFailure, runQaCli } from './qa-simulation-cli.js';

@Module({ providers: [PrismaService, QaSimulationService] })
class QaSimulationCliModule {}

try {
  await runQaCli(
    process.argv.slice(2),
    async () => {
      const app = await NestFactory.createApplicationContext(
        QaSimulationCliModule,
        { logger: false, abortOnError: false },
      );
      return {
        service: app.get(QaSimulationService),
        close: () => app.close(),
      };
    },
    (result) =>
      console.log(typeof result === 'string' ? result : JSON.stringify(result)),
  );
} catch (error) {
  console.error(JSON.stringify(qaCliFailure(error)));
  process.exitCode = 1;
}
