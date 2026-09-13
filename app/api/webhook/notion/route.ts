import { enqueueWebhook, ensureWebhookQueueIndexes } from "@/bot/webhook-queue";
import { db } from "@/src/db";
import { createHmac, timingSafeEqual } from "crypto";
import { type NextRequest, NextResponse } from "next/server";

/**
 * Notion webhook receiver, deployed to Vercel.
 *
 * Notion's webhook setup goes through two phases:
 *
 * 1. Initial verification: Notion POSTs a JSON body
 *    `{ "verification_token": "..." }` to the configured URL once. The
 *    integration setup screen expects you to paste that token back.
 *    We log the token and also stash it in MongoDB
 *    (`webhook_notion_verification`) so the operator can retrieve it
 *    out-of-band without scrubbing logs.
 *
 * 2. Steady-state: signed events. The signature header is
 *    `X-Notion-Signature: sha256=<hex>` over the raw request body, keyed
 *    by the `verification_token` issued in phase 1. Set the same token
 *    as `NOTION_WEBHOOK_VERIFICATION_TOKEN` in this Vercel project so
 *    we can validate.
 *
 * @see https://developers.notion.com/reference/webhooks
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function verifyNotionSignature(rawBody: string, signature: string, token: string): boolean {
  const hmac = createHmac("sha256", token).update(rawBody).digest("hex");
  const expected = Buffer.from(`sha256=${hmac}`);
  const received = Buffer.from(signature);
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  let payload: {
    verification_token?: string;
    type?: string;
    id?: string;
    workspace_id?: string;
    [k: string]: unknown;
  };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Phase 1: verification handshake. Capture the token so we can register
  // it in env without copying from logs.
  if (typeof payload.verification_token === "string" && !payload.type) {
    try {
      await db.collection("webhook_notion_verification").insertOne({
        verification_token: payload.verification_token,
        receivedAt: new Date(),
        userAgent: request.headers.get("user-agent"),
      });
    } catch (err) {
      console.warn("notion verification token persist failed", err);
    }
    console.log(
      `[notion-webhook] verification handshake received; token starts with ${payload.verification_token.slice(0, 6)}…`,
    );
    return new NextResponse("", { status: 200 });
  }

  // Phase 2: signed events.
  const token = process.env.NOTION_WEBHOOK_VERIFICATION_TOKEN;
  if (!token) {
    console.error(
      "[notion-webhook] NOTION_WEBHOOK_VERIFICATION_TOKEN unset — accepting unsigned event for setup, but this is insecure",
    );
  } else {
    const sig = request.headers.get("x-notion-signature") ?? "";
    if (!sig || !verifyNotionSignature(rawBody, sig, token)) {
      return new NextResponse("Invalid signature", { status: 401 });
    }
  }

  await ensureWebhookQueueIndexes();

  // Notion gives every event a stable id; fall back to a synthetic one so
  // dedup still works on test deliveries that omit it.
  const eventId =
    typeof payload.id === "string" ? payload.id : `${payload.type ?? "unknown"}_${Date.now()}`;

  try {
    await db.collection("webhook_edge_dedup").insertOne({
      _id: `notion:${eventId}` as unknown as never,
      createdAt: new Date(),
    });
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 11000) {
      // Duplicate delivery — Notion retries on non-2xx, we may have already
      // enqueued. Treat as success.
      return new NextResponse("", { status: 200 });
    }
    console.warn("notion dedup insert failed, falling through", err);
  }

  await enqueueWebhook({
    source: "notion",
    eventId,
    payload,
    meta: {
      type: payload.type ?? null,
      workspace_id: payload.workspace_id ?? null,
      receivedAt: Date.now(),
    },
  });

  return new NextResponse("", { status: 200 });
}

export async function GET() {
  try {
    await db.admin().ping();
    const col = db.collection("webhook_queue");
    const total = await col.countDocuments({ source: "notion" });
    const pending = await col.countDocuments({ source: "notion", processed: false });
    const verifTokens = await db.collection("webhook_notion_verification").countDocuments();
    return NextResponse.json({
      status: "ok",
      collection: "webhook_queue",
      notion: { total, pending, verificationTokensReceived: verifTokens },
    });
  } catch (error) {
    return NextResponse.json(
      {
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
