import { Request, Response, NextFunction } from "express";
import * as jwt from "jsonwebtoken";
import { db } from "@beekeeper/db";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
    name: string | null;
  };
}

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  // Support token via query param for <img src> tags (snapshot proxy, etc.)
  const queryToken = req.query.token as string | undefined;

  if (!authHeader?.startsWith("Bearer ") && !queryToken) {
    return res.status(401).json({ error: "Missing authorization header" });
  }

  try {
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : queryToken!;
    const payload = jwt.verify(token, JWT_SECRET) as { sub: string; email: string };

    const user = await db.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, role: true, name: true, status: true },
    });

    if (!user || user.status === "suspended") {
      return res.status(401).json({ error: "User not found or suspended" });
    }

    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

export function requireRole(...roles: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    next();
  };
}
