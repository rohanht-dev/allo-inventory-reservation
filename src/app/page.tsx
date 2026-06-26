"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type Stock = {
  id: string;
  warehouseId: string;
  available: number;
  warehouse: { id: string; name: string; location: string };
};

type Product = {
  id: string;
  name: string;
  description: string;
  price: number;
  stock: Stock[];
};

export default function Home() {
  const router = useRouter();
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [reserving, setReserving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/products")
      .then((r) => r.json())
      .then(setProducts)
      .finally(() => setLoading(false));
  }, []);

  async function handleReserve(productId: string, warehouseId: string) {
    setReserving(`${productId}-${warehouseId}`);
    setError(null);

    const res = await fetch("/api/reservations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId, warehouseId, quantity: 1 }),
    });

    const data = await res.json();
    setReserving(null);

    if (res.status === 409) {
      setError("Sorry, this item just sold out!");
      return;
    }
    if (!res.ok) {
      setError(data.error || "Something went wrong");
      return;
    }

    router.push(`/checkout/${data.id}`);
  }

  if (loading) return (
    <div className="flex items-center justify-center min-h-screen">
      <p className="text-gray-500">Loading products...</p>
    </div>
  );

  return (
    <main className="max-w-4xl mx-auto p-6">
      <h1 className="text-3xl font-bold mb-2">Allo Store</h1>
      <p className="text-gray-500 mb-8">Multi-warehouse inventory demo</p>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-6">
          {error}
        </div>
      )}

      <div className="grid gap-6">
        {products.map((product) => (
          <Card key={product.id}>
            <CardHeader>
              <div className="flex justify-between items-start">
                <div>
                  <CardTitle>{product.name}</CardTitle>
                  <p className="text-gray-500 text-sm mt-1">{product.description}</p>
                </div>
                <span className="text-xl font-bold">₹{product.price.toLocaleString()}</span>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-sm font-medium text-gray-700 mb-3">Available at warehouses:</p>
              <div className="flex flex-wrap gap-3">
                {product.stock.map((s) => (
                  <div key={s.id} className="flex items-center gap-2 border rounded-lg px-3 py-2">
                    <div>
                      <p className="text-sm font-medium">{s.warehouse.name}</p>
                      <p className="text-xs text-gray-500">{s.warehouse.location}</p>
                    </div>
                    <Badge variant={s.available > 3 ? "default" : s.available > 0 ? "destructive" : "secondary"}>
                      {s.available > 0 ? `${s.available} left` : "Out of stock"}
                    </Badge>
                    <Button
                      size="sm"
                      disabled={s.available === 0 || reserving === `${product.id}-${s.warehouseId}`}
                      onClick={() => handleReserve(product.id, s.warehouseId)}
                    >
                      {reserving === `${product.id}-${s.warehouseId}` ? "Reserving..." : "Reserve"}
                    </Button>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </main>
  );
}