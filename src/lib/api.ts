import { NextRequest, NextResponse } from "next/server";
import { prisma } from "./prisma";

/** Wrap a route handler so thrown Response objects become responses. */
export function handler(
  fn: (req: NextRequest, ctx: any) => Promise<Response> | Response
) {
  return async (req: NextRequest, ctx: any) => {
    try {
      return await fn(req, ctx);
    } catch (e) {
      if (e instanceof Response) return e;
      console.error("API error:", e);
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "Internal error" },
        { status: 500 }
      );
    }
  };
}

export const json = (data: unknown, init?: ResponseInit) =>
  NextResponse.json(data, init);

/** Get a settings blob by key, with a typed default. */
export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return row ? ((row.value as unknown) as T) : fallback;
}

export async function setSetting(key: string, value: unknown) {
  return prisma.setting.upsert({
    where: { key },
    create: { key, value: value as object },
    update: { value: value as object },
  });
}

/** Mask secret-looking values in a config object for safe display. */
export function maskSecrets<T extends Record<string, any>>(obj: T): T {
  const out: any = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v && typeof v === "object") out[k] = maskSecrets(v);
    else if (
      /(token|secret|password|key|api[_-]?key|authorization|cookie)/i.test(k) &&
      typeof v === "string" &&
      v.length > 0
    )
      out[k] = v.length <= 4 ? "****" : `${v.slice(0, 2)}••••${v.slice(-2)}`;
    else out[k] = v;
  }
  return out;
}
