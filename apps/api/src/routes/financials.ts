import { Router } from "express";
import { db } from "@beekeeper/db";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";

const router = Router();

const transactionSchema = z.object({
  date: z.string().datetime(),
  type: z.enum(["expense", "income"]),
  category: z.enum(["Equipment", "Bees", "Supplies", "Treatment", "Honey Sales", "Other"]),
  vendor: z.string().optional(),
  description: z.string().optional(),
  orderRef: z.string().optional(),
  subtotal: z.number().optional(),
  tax: z.number().optional(),
  total: z.number(),
  notes: z.string().optional(),
  lineItems: z.array(z.object({
    qty: z.number().nullable().optional(),
    sku: z.string().nullable().optional(),
    description: z.string(),
    unitPrice: z.number().nullable().optional(),
    amount: z.number(),
  })).optional(),
});

// GET /api/v1/financials — queen only
router.get("/", requireAuth, requireRole("queen"), async (_req, res) => {
  const transactions = await db.financialTransaction.findMany({
    include: { lineItems: true, receipts: { select: { id: true, mimeType: true, aiConfidence: true } } },
    orderBy: { date: "desc" },
  });
  res.json(transactions);
});

// POST /api/v1/financials
router.post("/", requireAuth, requireRole("queen"), async (req, res) => {
  const body = transactionSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid input", details: body.error.flatten() });

  const { lineItems, ...txData } = body.data;

  const transaction = await db.financialTransaction.create({
    data: {
      ...txData,
      date: new Date(txData.date),
      lineItems: lineItems?.length
        ? { create: lineItems.map((li) => ({ description: li.description, amount: li.amount, qty: li.qty ?? null, sku: li.sku ?? null, unitPrice: li.unitPrice ?? null })) }
        : undefined,
    },
    include: { lineItems: true },
  });
  res.status(201).json(transaction);
});

// GET /api/v1/financials/summary
router.get("/summary", requireAuth, requireRole("queen"), async (_req, res) => {
  const [expenses, income] = await Promise.all([
    db.financialTransaction.aggregate({ where: { type: "expense" }, _sum: { total: true } }),
    db.financialTransaction.aggregate({ where: { type: "income" }, _sum: { total: true } }),
  ]);
  res.json({
    totalExpenses: expenses._sum.total || 0,
    totalIncome: income._sum.total || 0,
    netProfit: (income._sum.total || 0) - (expenses._sum.total || 0),
  });
});

export { router as financialsRouter };
