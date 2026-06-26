import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Vercel Cron will call this every minute
export async function GET(req: NextRequest) {
  // Simple auth check so random people can't call it
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const expired = await prisma.reservation.findMany({
    where: {
      status: "PENDING",
      expiresAt: { lt: new Date() },
    },
  });

  for (const r of expired) {
    await prisma.$transaction(async (tx) => {
      await tx.stock.update({
        where: {
          productId_warehouseId: {
            productId: r.productId,
            warehouseId: r.warehouseId,
          },
        },
        data: { reserved: { decrement: r.quantity } },
      });
      await tx.reservation.update({
        where: { id: r.id },
        data: { status: "RELEASED" },
      });
    });
  }

  return NextResponse.json({ released: expired.length });
}