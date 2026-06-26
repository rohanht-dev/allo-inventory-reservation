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
  if (reservation.status === "RELEASED") {
    return NextResponse.json(reservation, { status: 200 }); // idempotent
  }
  if (reservation.status === "CONFIRMED") {
    return NextResponse.json({ error: "Cannot release a confirmed reservation" }, { status: 409 });
  }

  const updated = await prisma.$transaction(async (tx) => {
    await tx.stock.update({
      where: {
        productId_warehouseId: {
          productId: reservation.productId,
          warehouseId: reservation.warehouseId,
        },
      },
      data: { reserved: { decrement: reservation.quantity } },
    });

    return tx.reservation.update({
      where: { id },
      data: { status: "RELEASED" },
      include: { product: true, warehouse: true },
    });
  });

  return NextResponse.json(updated);
}