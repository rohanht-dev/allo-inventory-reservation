import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // Clean existing data
  await prisma.reservation.deleteMany();
  await prisma.stock.deleteMany();
  await prisma.product.deleteMany();
  await prisma.warehouse.deleteMany();

  // Create warehouses
  const mumbai = await prisma.warehouse.create({
    data: { name: "Mumbai Central", location: "Mumbai, MH" },
  });
  const delhi = await prisma.warehouse.create({
    data: { name: "Delhi North", location: "Delhi, DL" },
  });

  // Create products
  const products = await Promise.all([
    prisma.product.create({
      data: {
        name: "Sony WH-1000XM5 Headphones",
        description: "Industry-leading noise cancellation headphones",
        price: 29999,
      },
    }),
    prisma.product.create({
      data: {
        name: "Apple AirPods Pro",
        description: "Active noise cancellation with transparency mode",
        price: 24999,
      },
    }),
    prisma.product.create({
      data: {
        name: "Samsung Galaxy Watch 6",
        description: "Advanced health monitoring smartwatch",
        price: 34999,
      },
    }),
  ]);

  // Create stock (some low stock to demo the race condition)
  for (const product of products) {
    await prisma.stock.create({
      data: { productId: product.id, warehouseId: mumbai.id, total: 5 },
    });
    await prisma.stock.create({
      data: { productId: product.id, warehouseId: delhi.id, total: 2 }, // low stock!
    });
  }

  console.log("✅ Database seeded!");
}

main().catch(console.error).finally(() => prisma.$disconnect());