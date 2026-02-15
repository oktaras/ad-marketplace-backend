import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting database seed...');

  // Seed categories
  const categories = [
    { slug: 'crypto', name: 'Cryptocurrency', nameRu: 'Криптовалюта', icon: '💰' },
    { slug: 'tech', name: 'Technology', nameRu: 'Технологии', icon: '💻' },
    { slug: 'finance', name: 'Finance', nameRu: 'Финансы', icon: '📊' },
    { slug: 'news', name: 'News', nameRu: 'Новости', icon: '📰' },
    { slug: 'entertainment', name: 'Entertainment', nameRu: 'Развлечения', icon: '🎬' },
    { slug: 'education', name: 'Education', nameRu: 'Образование', icon: '📚' },
    { slug: 'lifestyle', name: 'Lifestyle', nameRu: 'Лайфстайл', icon: '🌟' },
    { slug: 'gaming', name: 'Gaming', nameRu: 'Игры', icon: '🎮' },
  ];

  for (const category of categories) {
    await prisma.channelCategory.upsert({
      where: { slug: category.slug },
      update: {},
      create: category,
    });
  }

  console.log(`✅ Seeded ${categories.length} categories`);

  // Seed system config
  const configs = [
    { key: 'platform_fee_bps', value: 500 },
    { key: 'deal_negotiation_timeout_hours', value: 72 },
    { key: 'payment_timeout_hours', value: 48 },
    { key: 'creative_review_timeout_hours', value: 48 },
    { key: 'post_verification_delay_hours', value: 24 },
    { key: 'min_deal_amount_ton', value: '1' },
    { key: 'max_deal_amount_ton', value: '100000' },
  ];

  for (const config of configs) {
    await prisma.systemConfig.upsert({
      where: { key: config.key },
      update: { value: config.value },
      create: config,
    });
  }

  console.log(`✅ Seeded ${configs.length} system configs`);

  console.log('🎉 Database seed completed!');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
