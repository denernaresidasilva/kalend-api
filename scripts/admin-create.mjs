// Operator-only interactive DEV bootstrap. Never run at startup or from HTTP.
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { createFirstAdmin } from '../dist/auth/admin-bootstrap.js';

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error('Terminal interativo obrigatório.');
  if (process.env.KALEND_ADMIN_TARGET !== 'dev')
    throw new Error('Exige KALEND_ADMIN_TARGET=dev.');
  let target;
  try {
    target = new URL(process.env.DATABASE_URL ?? '');
  } catch {
    throw new Error('Conexão DEV não configurada.');
  }
  if (
    !['postgres:', 'postgresql:'].includes(target.protocol) ||
    decodeURIComponent(target.pathname) !== '/kalend_dev'
  )
    throw new Error('Bootstrap limitado ao banco kalend_dev.');
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--promote') || args.length > 1)
    throw new Error(
      'Use sem argumentos para criar, ou --promote para promover explicitamente.',
    );
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  const abort = new AbortController();
  rl.on('SIGINT', () => abort.abort());
  const ask = (prompt) => rl.question(prompt, { signal: abort.signal });
  const secret = async (prompt) => {
    process.stdout.write(prompt);
    muted = true;
    try {
      return await ask('');
    } finally {
      muted = false;
      process.stdout.write('\n');
    }
  };
  let client;
  try {
    const host = (
      await ask(
        'Digite o hostname PostgreSQL DEV conferido no provedor (não a URL completa): ',
      )
    ).trim();
    if (host !== target.hostname)
      throw new Error('Host não confere. Operação cancelada.');
    const confirmation = await ask(
      'Digite CRIAR PRIMEIRO SUPER ADMIN DEV para confirmar: ',
    );
    if (confirmation !== 'CRIAR PRIMEIRO SUPER ADMIN DEV')
      throw new Error('Operação cancelada.');
    const email = await ask('E-mail: ');
    const name = await ask('Nome: ');
    const password = await secret(
      args.includes('--promote')
        ? 'Senha atual do usuário (oculta): '
        : 'Senha nova (oculta, mínimo 12 caracteres): ',
    );
    const confirm = await secret('Confirme a senha (oculta): ');
    if (password !== confirm) throw new Error('Senhas não conferem.');
    client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
    });
    await createFirstAdmin(client, {
      email,
      name,
      password,
      promote: args.includes('--promote'),
    });
    process.stdout.write(
      'Primeiro Super Admin DEV configurado. Faça login novamente.\n',
    );
  } finally {
    rl.close();
    if (client) await client.$disconnect();
  }
}
// Never print caught objects: driver errors can include connection credentials or SQL parameters.
main().catch(() => {
  process.stderr.write(
    'Bootstrap não concluído. Verifique destino DEV, confirmação, dados, migrations e existência de Super Admin. Nenhuma credencial foi registrada.\n',
  );
  process.exitCode = 1;
});
