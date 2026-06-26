"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter, useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type Reservation = {
  id: string;
  status: "PENDING" | "CONFIRMED" | "RELEASED";
  expiresAt: string;
  quantity: number;
  product: { name: string; price: number; description: string };
  warehouse: { name: string; location: string };
};

export default function CheckoutPage() {
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;

  const [reservation, setReservation] = useState<Reservation | null>(null);
  const [timeLeft, setTimeLeft] = useState(0);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch reservation details
  useEffect(() => {
    fetch(`/api/reservations/${id}`)
      .then((r) => r.json())
      .then((data) => {
        setReservation(data);
        const secondsLeft = Math.floor(
          (new Date(data.expiresAt).getTime() - Date.now()) / 1000
        );
        setTimeLeft(Math.max(0, secondsLeft));
      })
      .finally(() => setLoading(false));
  }, [id]);

  // Countdown timer
  useEffect(() => {
    if (timeLeft <= 0) return;
    const interval = setInterval(() => {
      setTimeLeft((t) => {
        if (t <= 1) {
          clearInterval(interval);
          setReservation((r) => r ? { ...r, status: "RELEASED" } : r);
          return 0;
        }
        return t - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [timeLeft]);

  const handleConfirm = useCallback(async () => {
    setActionLoading(true);
    setError(null);

    const res = await fetch(`/api/reservations/${id}/confirm`, { method: "POST" });
    const data = await res.json();
    setActionLoading(false);

    if (res.status === 410) {
      setError("Your reservation expired before payment could be confirmed.");
      setReservation((r) => r ? { ...r, status: "RELEASED" } : r);
      return;
    }
    if (!res.ok) {
      setError(data.error || "Something went wrong");
      return;
    }

    setReservation(data);
  }, [id]);

  const handleCancel = useCallback(async () => {
    setActionLoading(true);
    setError(null);

    const res = await fetch(`/api/reservations/${id}/release`, { method: "POST" });
    const data = await res.json();
    setActionLoading(false);

    if (!res.ok) {
      setError(data.error || "Something went wrong");
      return;
    }

    setReservation(data);
  }, [id]);

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60).toString().padStart(2, "0");
    const sec = (s % 60).toString().padStart(2, "0");
    return `${m}:${sec}`;
  };

  if (loading) return (
    <div className="flex items-center justify-center min-h-screen">
      <p className="text-gray-500">Loading reservation...</p>
    </div>
  );

  if (!reservation) return (
    <div className="flex items-center justify-center min-h-screen">
      <p className="text-red-500">Reservation not found.</p>
    </div>
  );

  const statusColor = {
    PENDING: "default",
    CONFIRMED: "default",
    RELEASED: "secondary",
  } as const;

  return (
    <main className="max-w-lg mx-auto p-6">
      <button onClick={() => router.push("/")} className="text-sm text-blue-500 mb-6 hover:underline">
        ← Back to products
      </button>

      <Card>
        <CardHeader>
          <div className="flex justify-between items-center">
            <CardTitle>Checkout</CardTitle>
            <Badge variant={statusColor[reservation.status]}>{reservation.status}</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <p className="font-semibold text-lg">{reservation.product.name}</p>
            <p className="text-gray-500 text-sm">{reservation.product.description}</p>
            <p className="text-sm mt-1">Warehouse: {reservation.warehouse.name} — {reservation.warehouse.location}</p>
            <p className="text-xl font-bold mt-2">₹{reservation.product.price.toLocaleString()}</p>
          </div>

          {reservation.status === "PENDING" && (
            <div className={`text-center py-3 rounded-lg font-mono text-2xl font-bold ${
              timeLeft < 60 ? "bg-red-50 text-red-600" : "bg-amber-50 text-amber-700"
            }`}>
              ⏱ {formatTime(timeLeft)}
              <p className="text-sm font-normal mt-1">Time remaining to complete payment</p>
            </div>
          )}

          {reservation.status === "CONFIRMED" && (
            <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded">
              ✅ Payment confirmed! Your order is placed.
            </div>
          )}

          {reservation.status === "RELEASED" && (
            <div className="bg-gray-50 border border-gray-200 text-gray-600 px-4 py-3 rounded">
              ❌ This reservation was released. The item is available again.
            </div>
          )}

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded text-sm">
              {error}
            </div>
          )}

          {reservation.status === "PENDING" && timeLeft > 0 && (
            <div className="flex gap-3">
              <Button
                className="flex-1"
                onClick={handleConfirm}
                disabled={actionLoading}
              >
                {actionLoading ? "Processing..." : "✓ Confirm Purchase"}
              </Button>
              <Button
                variant="outline"
                className="flex-1"
                onClick={handleCancel}
                disabled={actionLoading}
              >
                Cancel
              </Button>
            </div>
          )}

          {reservation.status === "RELEASED" && (
            <Button className="w-full" onClick={() => router.push("/")}>
              Browse Products
            </Button>
          )}
        </CardContent>
      </Card>
    </main>
  );
}