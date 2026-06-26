import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const reservation = await prisma.reservation.findUnique({ where: { id } });

  if (!reservation) {
    return NextResponse.json({ error: "Reservation not found" }, { status: 404 });
  }
  if (reservation.status === "CONFIRMED") {
    return NextResponse.json(reservation, { status: 200 }); // idempotent
  }
  if (reservation.status === "RELEASED" || reservation.expiresAt < new Date()) {
    return NextResponse.json({ error: "Reservation has expired" }, { status: 410 });
  }

  const updated = await prisma.$transaction(async (tx) => {
    // Decrease reserved count (the sale is now permanent — reserved→sold)
    await tx.stock.update({
      where: {
        productId_warehouseId: {
          productId: reservation.productId,
          warehouseId: reservation.warehouseId,
        },
      },
      data: {
        reserved: { decrement: reservation.quantity },
        total: { decrement: reservation.quantity }, // permanently remove from total
      },
    });

    return tx.reservation.update({
      where: { id },
      data: { status: "CONFIRMED" },
      include: { product: true, warehouse: true },
    });
  });

  return NextResponse.json(updated);
}