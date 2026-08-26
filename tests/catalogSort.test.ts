process.env.DATABASE_URL ??= 'postgresql://aspb:aspb@localhost:5432/aspb_autowebinar?schema=test';
process.env.NODE_ENV = 'test';

import crypto from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { catalogListSchema, listCatalogWebinars } from '../src/lib/catalog.js';
import {
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_ORGANIZATION_SLUG,
  DEFAULT_SYSTEM_OWNER_EMAIL,
  DEFAULT_SYSTEM_OWNER_MEMBERSHIP_ID,
  DEFAULT_SYSTEM_OWNER_USER_ID,
} from '../src/lib/tenancy/constants.js';

beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE users, organizations, legal_practice_areas, jurisdictions CASCADE');
  await prisma.tenantRolloutPolicy.upsert({
    where: { feature: 'PUBLIC_CATALOG' },
    update: { mode: 'ENABLED', revision: 1, updatedByAdminUserId: null },
    create: { feature: 'PUBLIC_CATALOG', mode: 'ENABLED', revision: 1 },
  });
  await prisma.organization.create({
    data: { id: DEFAULT_ORGANIZATION_ID, name: 'АСПБ', slug: DEFAULT_ORGANIZATION_SLUG, status: 'ACTIVE' },
  });
  await prisma.user.create({
    data: {
      id: DEFAULT_SYSTEM_OWNER_USER_ID,
      emailNormalized: DEFAULT_SYSTEM_OWNER_EMAIL,
      displayName: 'Системный владелец АСПБ',
      kind: 'SYSTEM',
      status: 'ACTIVE',
    },
  });
  await prisma.organizationMembership.create({
    data: {
      id: DEFAULT_SYSTEM_OWNER_MEMBERSHIP_ID,
      organizationId: DEFAULT_ORGANIZATION_ID,
      userId: DEFAULT_SYSTEM_OWNER_USER_ID,
      role: 'OWNER',
      status: 'ACTIVE',
    },
  });
});

describe('CAT-006 deterministic catalog sorting', () => {
  it('uses UPCOMING by default and accepts every documented sort', () => {
    expect(catalogListSchema.parse({}).sort).toBe('UPCOMING');
    for (const sort of ['RELEVANCE', 'UPCOMING', 'NEWEST', 'UPDATED']) {
      expect(catalogListSchema.parse({ sort }).sort).toBe(sort);
    }
  });

  it('keeps stable server order and publication constraints for all sorts', async () => {
    const organization = await prisma.organization.create({
      data: { name: 'Catalog tenant', slug: `catalog-${crypto.randomUUID()}` },
    });
    const user = await prisma.user.create({
      data: {
        emailNormalized: `catalog-${crypto.randomUUID()}@example.test`,
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      },
    });
    await prisma.organizationMembership.create({
      data: { organizationId: organization.id, userId: user.id, role: 'AUTHOR' },
    });
    const profile = await prisma.authorProfile.create({
      data: {
        organizationId: organization.id,
        userId: user.id,
        slug: `catalog-author-${crypto.randomUUID()}`,
        publicName: 'Автор каталога',
        verificationStatus: 'VERIFIED',
      },
    });
    const definitions = [
      {
        id: 'sort_webinar_a',
        title: 'Договорный риск: основной разбор',
        publishedAt: '2026-08-01T00:00:00Z',
        updatedAt: '2026-08-10T00:00:00Z',
        scheduledAt: '2031-01-03T10:00:00Z',
      },
      {
        id: 'sort_webinar_b',
        title: 'Договорный риск: новая практика',
        publishedAt: '2026-08-20T00:00:00Z',
        updatedAt: '2026-08-21T00:00:00Z',
        scheduledAt: '2031-01-02T10:00:00Z',
      },
      {
        id: 'sort_webinar_c',
        title: 'Корпоративное право',
        publishedAt: '2026-08-20T00:00:00Z',
        updatedAt: '2026-08-22T00:00:00Z',
        scheduledAt: '2031-01-01T10:00:00Z',
      },
    ];
    for (const item of definitions) {
      await prisma.webinar.create({
        data: {
          id: item.id,
          organizationId: organization.id,
          authorProfileId: profile.id,
          slug: item.id.replaceAll('_', '-'),
          title: item.title,
          description: 'Опубликованное описание для сортировки.',
          contentStatus: 'PUBLISHED',
          visibility: 'PUBLIC',
          publishedAt: new Date(item.publishedAt),
          updatedAt: new Date(item.updatedAt),
          sessions: { create: { title: item.title, scheduledAt: new Date(item.scheduledAt) } },
        },
      });
    }
    await prisma.webinar.createMany({
      data: [
        {
          organizationId: organization.id,
          authorProfileId: profile.id,
          slug: 'sort-hidden-draft',
          title: 'Договорный риск: draft',
          contentStatus: 'DRAFT',
          visibility: 'PUBLIC',
        },
        {
          organizationId: organization.id,
          authorProfileId: profile.id,
          slug: 'sort-hidden-private',
          title: 'Договорный риск: private',
          contentStatus: 'PUBLISHED',
          visibility: 'PRIVATE',
          publishedAt: new Date('2026-08-23T00:00:00Z'),
        },
        {
          organizationId: organization.id,
          authorProfileId: profile.id,
          slug: 'sort-hidden-archived',
          title: 'Договорный риск: archived',
          contentStatus: 'PUBLISHED',
          visibility: 'PUBLIC',
          publishedAt: new Date('2026-08-23T00:00:00Z'),
          archivedAt: new Date('2026-08-23T01:00:00Z'),
        },
      ],
    });

    const expected: Record<string, string[]> = {
      UPCOMING: ['sort_webinar_c', 'sort_webinar_b', 'sort_webinar_a'],
      NEWEST: ['sort_webinar_c', 'sort_webinar_b', 'sort_webinar_a'],
      UPDATED: ['sort_webinar_c', 'sort_webinar_b', 'sort_webinar_a'],
      RELEVANCE: ['sort_webinar_b', 'sort_webinar_a'],
    };
    for (const sort of ['RELEVANCE', 'UPCOMING', 'NEWEST', 'UPDATED'] as const) {
      const query = sort === 'RELEVANCE' ? { sort, q: 'договорный риск' } : { sort };
      const first = await listCatalogWebinars(prisma, query);
      const second = await listCatalogWebinars(prisma, query);
      expect(first.items.map(item => item.id)).toEqual(expected[sort]);
      expect(second.items.map(item => item.id)).toEqual(expected[sort]);
      expect(first.items.map(item => item.title).join(' ')).not.toMatch(/draft|private|archived/i);
    }
  });
});
