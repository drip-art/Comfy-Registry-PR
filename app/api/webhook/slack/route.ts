import { enqueueWebhook, ensureWebhookQueueIndexes } from "@/bot/webhook-queue";
import { db } from "@/src/db";
import { createHmac, timingSafeEqual } from "crypto";
import { type NextRequest, NextResponse } from "next/server";

/**
 * Slack webhook receiver, deployed to Vercel.
 *
 * The local bot on the VM tails MongoDB's `webhook_queue` via changeStream,
 * so this endpoint stays up even when the bot is restarting/down — no
 * Slack retries get dropped.
 *
 * URL verification (initial setup): respond with the challenge directly.
 * event_callback: verify HMAC, enqueue, 200.
 *
 * @see https://docs.slack.dev/apis/events-api/
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function verifySlackSignature(
  body: string,
  timestamp: string,
  signature: string,
  secret: string,
): boolean {
  // Slack guards against >5min replay attacks; we mirror that.
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const hmac = createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex");
  const expected = Buffer.from(`v0=${hmac}`);
  const received = Buffer.from(signature);
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}

export async function POST(request: NextRequest) {
  const body = await request.text();
  const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";
  const signature = request.headers.get("x-slack-signature") ?? "";

  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) {
    console.error("SLACK_SIGNING_SECRET is not set in this Vercel deployment");
    return NextResponse.json({ error: "server misconfigured" }, { status: 500 });
  }

  if (!verifySlackSignature(body, timestamp, signature, secret)) {
    return new NextResponse("Invalid signature", { status: 401 });
  }

  let payload: {
    type?: string;
    challenge?: string;
    event?: { team?: string; channel?: string; ts?: string; event_ts?: string };
    team_id?: string;
    event_id?: string;
  };
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // URL verification challenge — Slack does this when you set the
  // Request URL in the app config.
  if (payload.type === "url_verification" && payload.challenge) {
    return NextResponse.json({ challenge: payload.challenge });
  }

  if (payload.type === "event_callback") {
    const retryNum = request.headers.get("x-slack-retry-num");
    const retryReason = request.headers.get("x-slack-retry-reason");
    const eventId =
      payload.event_id ||
      `${payload.event?.channel ?? "-"}_${payload.event?.event_ts ?? payload.event?.ts ?? "-"}`;

    // Make sure indexes exist (no-op after first request per instance).
    await ensureWebhookQueueIndexes();

    // Edge-level dedup so a Slack retry storm doesn't insert N copies.
    // The actual queue is content-deduped by the bot consumer.
    try {
      const dedupCol = db.collection("webhook_edge_dedup");
      // _id is a string; the unique constraint is built-in, so a duplicate
      // throws code 11000.
      await dedupCol.insertOne({
        _id: `slack:${eventId}` as unknown as never,
        createdAt: new Date(),
      });
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code === 11000) {
        console.log(`slack webhook dedup hit for ${eventId} (retry=${retryNum})`);
        return new NextResponse("", { status: 200 });
      }
      console.warn("dedup insert failed, falling through", err);
    }

    await enqueueWebhook({
      source: "slack",
      eventId,
      payload,
      meta: {
        retryNum: retryNum ?? null,
        retryReason: retryReason ?? null,
        receivedAt: Date.now(),
      },
    });
  }

  // Always 200 the webhook within a few seconds — Slack times out at 3s
  // and retries up to 3 times if it doesn't get one.
  return new NextResponse("", { status: 200 });
}

export async function GET() {
  try {
    await db.admin().ping();
    const col = db.collection("webhook_queue");
    const total = await col.countDocuments({ source: "slack" });
    const pending = await col.countDocuments({ source: "slack", processed: false });
    return NextResponse.json({
      status: "ok",
      collection: "webhook_queue",
      slack: { total, pending },
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
