// utils/wron.ts
import { Prisma } from '@prisma/client';

/**
 * Atomically allocate up to `requested` WRON from the RewardBank.
 * Returns { granted, newAvailable } where granted <= requested.
 * Must be called inside an existing transaction (tx).
 */
export async function allocateWron(
  tx: Prisma.TransactionClient,
  requested: number
): Promise<{ granted: number; newAvailable: number }> {
  if (requested <= 0) return { granted: 0, newAvailable: Number.NaN };

  // Use NUMERIC for safety; assume RewardBank.available is DECIMAL(36,18)
  // CTE locks the row and computes the capped deduction.
  const rows = await tx.$queryRaw<Array<{ granted: Prisma.Decimal; new_available: Prisma.Decimal }>>`
    WITH src AS (
      SELECT "available"
      FROM "RewardBank"
      WHERE "id" = 'WRON'
      FOR UPDATE
    )
    UPDATE "RewardBank" AS rb
    SET "available" = src."available" - LEAST(src."available", ${requested}::numeric)
    FROM src
    WHERE rb."id" = 'WRON'
    RETURNING LEAST(src."available", ${requested}::numeric) AS granted,
              rb."available" AS new_available
  `;

  const row = rows[0];
  if (!row) {
    // Bank row missing → no WRON can be granted
    return { granted: 0, newAvailable: 0 };
  }

  return {
    granted: Number(row.granted),
    newAvailable: Number(row.new_available),
  };
}
