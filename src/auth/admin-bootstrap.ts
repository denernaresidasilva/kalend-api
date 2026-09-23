import * as bcrypt from 'bcrypt';
import type { PrismaClient } from '@prisma/client';
/** Offline operator-only entry point. Never expose this through a controller/provider. */
export async function createFirstAdmin(
  prisma: PrismaClient,
  input: { email: string; name: string; password: string; promote: boolean },
) {
  const email = input.email.trim().toLowerCase();
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    email.length > 254 ||
    !input.name.trim() ||
    input.name.length > 255 ||
    input.password.length < 12 ||
    Buffer.byteLength(input.password) > 72
  )
    throw new Error(
      'Dados inválidos: use e-mail válido e senha de 12 caracteres a 72 bytes.',
    );
  const passwordHash = input.promote
    ? undefined
    : await bcrypt.hash(input.password, 12);
  return prisma.$transaction(
    async (tx) => {
      // Serialize explicit bootstrap runs, preventing two "first" administrators.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(18473, 92026)`;
      if (await tx.user.count({ where: { isSuperAdmin: true } }))
        throw new Error('Já existe Super Admin. Bootstrap recusado.');
      const existing = await tx.user.findUnique({ where: { email } });
      if (input.promote) {
        if (
          !existing?.isActive ||
          !(await bcrypt.compare(input.password, existing.passwordHash))
        )
          throw new Error(
            'Promoção recusada. Verifique usuário ativo e senha atual.',
          );
        await tx.user.update({
          where: { id: existing.id },
          data: { isSuperAdmin: true },
        });
        await tx.authSession.updateMany({
          where: { userId: existing.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      } else {
        if (existing)
          throw new Error(
            'Usuário já existe. Use promoção explícita, sem redefinir a senha.',
          );
        await tx.user.create({
          data: {
            email,
            name: input.name.trim(),
            passwordHash: passwordHash!,
            isActive: true,
            isSuperAdmin: true,
          },
        });
      }
      return { created: !input.promote, promoted: input.promote };
    },
    { timeout: 15000, isolationLevel: 'ReadCommitted' },
  );
}
