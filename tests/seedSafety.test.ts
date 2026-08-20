import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { createInitialOwnerIfMissing, ensureLegacyTenantBootstrap } from '../prisma/seed.js';

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

  it('creates the ASPB compatibility tenant once and is idempotent on repeat', async () => {
    const organization = {
      findUnique: vi.fn().mockResolvedValueOnce(null).mockResolvedValue({ id: 'org_aspb' }),
      create: vi.fn().mockResolvedValue({ id: 'org_aspb' }),
    };
    const user = {
      upsert: vi.fn().mockResolvedValue({ id: 'user_aspb_system_owner' }),
    };
    const organizationMembership = {
      create: vi.fn().mockResolvedValue({ id: 'membership_aspb_system_owner' }),
      findUnique: vi.fn().mockResolvedValue({ id: 'membership_aspb_system_owner' }),
      findFirst: vi.fn(),
    };
    const $executeRaw = vi.fn().mockResolvedValue(1);
    const client = {
      organization,
      user,
      organizationMembership,
      $executeRaw,
    } as unknown as Pick<Prisma.TransactionClient, 'organization' | 'user' | 'organizationMembership' | '$executeRaw'>;

    await expect(ensureLegacyTenantBootstrap(client)).resolves.toEqual({ created: true });
    await expect(ensureLegacyTenantBootstrap(client)).resolves.toEqual({ created: false });
    expect(organization.create).toHaveBeenCalledTimes(1);
    expect(user.upsert).toHaveBeenCalledTimes(1);
    expect(organizationMembership.create).toHaveBeenCalledTimes(1);
    expect($executeRaw).toHaveBeenCalledTimes(2);
  });

  it('does not silently re-grant tenant ownership when an existing ASPB organization has no owner', async () => {
    const organization = {
      findUnique: vi.fn().mockResolvedValue({ id: 'org_aspb' }),
      create: vi.fn(),
    };
    const user = { upsert: vi.fn() };
    const organizationMembership = {
      create: vi.fn(),
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
    };
    const $executeRaw = vi.fn().mockResolvedValue(1);

    await expect(
      ensureLegacyTenantBootstrap({
        organization,
        user,
        organizationMembership,
        $executeRaw,
      } as unknown as Pick<
        Prisma.TransactionClient,
        'organization' | 'user' | 'organizationMembership' | '$executeRaw'
      >),
    ).rejects.toThrow('refusing to grant tenant ownership during seed');
    expect(organization.create).not.toHaveBeenCalled();
    expect(user.upsert).not.toHaveBeenCalled();
    expect(organizationMembership.create).not.toHaveBeenCalled();
  });
});
