import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { redis } from "@/lib/redis";
import { ReserveSchema } from "@/lib/schemas";

const RESERVATION_TTL = 10 * 60; // 10 minutes in seconds
const LOCK_TTL = 5000; // 5 seconds in ms

export async function POST(req: NextRequest) {
  const body = await req.json();

  // Validate input
  const parsed = ReserveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { productId, warehouseId, quantity } = parsed.data;

  // Idempotency (bonus feature)
  const idempotencyKey = req.headers.get("Idempotency-Key");
  if (idempotencyKey) {
    const existing = await prisma.reservation.findUnique({
      where: { idempotencyKey },
      include: { product: true, warehouse: true },
    });
    if (existing) {
      return NextResponse.json(existing, { status: 200 });
    }
  }

  // Distributed lock — prevents race conditions
  // Only ONE request can hold this lock at a time for this product+warehouse
  const lockKey = `lock:${productId}:${warehouseId}`;
  const lockValue = crypto.randomUUID();

  // Try to acquire lock using SET NX (only set if not exists)
  const acquired = await redis.set(lockKey, lockValue, {
    nx: true,       // only set if key doesn't exist
    px: LOCK_TTL,   // auto-expire after 5s (safety net)
  });

  if (!acquired) {
    // Another request is currently processing — tell client to retry
    return NextResponse.json(
      { error: "Server busy, please retry" },
      { status: 503 }
    );
  }

  try {
    // Use a Prisma transaction — either ALL steps succeed or NONE do
    const reservation = await prisma.$transaction(async (tx) => {
      // Lock the stock row and read it
      const stock = await tx.stock.findUnique({
        where: { productId_warehouseId: { productId, warehouseId } },
      });

      if (!stock) throw new Error("STOCK_NOT_FOUND");

      const available = stock.total - stock.reserved;
      if (available < quantity) throw new Error("INSUFFICIENT_STOCK");

      // Increment reserved count
      await tx.stock.update({
        where: { productId_warehouseId: { productId, warehouseId } },
        data: { reserved: { increment: quantity } },
      });

      // Create the reservation record
      const expiresAt = new Date(Date.now() + RESERVATION_TTL * 1000);
      return tx.reservation.create({
        data: {
          productId,
          warehouseId,
          quantity,
          expiresAt,
          status: "PENDING",
          ...(idempotencyKey ? { idempotencyKey } : {}),
        },
        include: { product: true, warehouse: true },
      });
    });

    return NextResponse.json(reservation, { status: 201 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message === "INSUFFICIENT_STOCK" || message === "STOCK_NOT_FOUND") {
      return NextResponse.json({ error: "Not enough stock available" }, { status: 409 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  } finally {
    // Always release the lock — but only if it's still ours
    const current = await redis.get(lockKey);
    if (current === lockValue) {
      await redis.del(lockKey);
    }
  }
}