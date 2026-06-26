import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const products = await prisma.product.findMany({
    include: {
      stock: {
        include: { warehouse: true },
      },
    },
  });

  // available = total - reserved
  const result = products.map((p) => ({
    ...p,
    stock: p.stock.map((s) => ({
      ...s,
      available: s.total - s.reserved,
    })),
  }));

  return NextResponse.json(result);
}