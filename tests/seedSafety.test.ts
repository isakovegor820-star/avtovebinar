import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { createInitialOwnerIfMissing } from '../prisma/seed.js';

describe('production seed safety', () => {
  it('does not create a second owner when ADMIN_LOGIN changes after bootstrap', async () => {
    const adminUser = {
      findFirst: vi.fn().mockResolvedValue({ id: 'existing-admin-with-another-email' }),
      create: vi.fn(),
    };
    const $executeRaw = vi.fn().mockResolvedValue(1);

    const result = await createInitialOwnerIfMissing(
      { adminUser, $executeRaw } as unknown as Pick<Prisma.TransactionClient, 'adminUser' | '$executeRaw'>,
      'different-admin@example.com',
      'unused-password',
    );

    expect(result).toEqual({ created: false });
    expect(adminUser.create).not.toHaveBeenCalled();
  });

  it('creates an owner only when the administrator table is empty', async () => {
    const adminUser = {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'new-admin' }),
    };
    const $executeRaw = vi.fn().mockResolvedValue(1);

    const result = await createInitialOwnerIfMissing(
      { adminUser, $executeRaw } as unknown as Pick<Prisma.TransactionClient, 'adminUser' | '$executeRaw'>,
      'New.Admin@Example.COM',
      'StrongAdmin123',
    );

    expect(result).toEqual({ created: true });
    expect($executeRaw).toHaveBeenCalledOnce();
    expect(adminUser.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        email: 'new.admin@example.com',
        name: 'New.Admin@Example.COM',
        role: 'owner',
        isActive: true,
      }),
    });
  });
});
