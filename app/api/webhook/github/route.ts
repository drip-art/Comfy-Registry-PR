import { enqueueWebhook } from "@/bot/webhook-queue";
import { db } from "@/src/db";
import { createHmac } from "crypto";
import { type NextRequest, NextResponse } from "next/server";

/**
 * Verify GitHub webhook signature
 * @see https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
 */
function verifySignature(payload: string, signature: string | null): boolean {
  const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;

  if (!WEBHOOK_SECRET) {
    console.warn("GITHUB_WEBHOOK_SECRET is not set, skipping signature verification");
    return true; // Allow in development without secret
  }

  if (!signature) {
    return false;
  }

  const hmac = createHmac("sha256", WEBHOOK_SECRET);
  const digest = "sha256=" + hmac.update(payload).digest("hex");

  // Use timing-safe comparison
  if (signature.length !== digest.length) {
    return false;
  }

  // Constant-time comparison
  let result = 0;
  for (let i = 0; i < signature.length; i++) {
    result |= signature.charCodeAt(i) ^ digest.charCodeAt(i);
  }
  return result === 0;
}

/**
 * GitHub Webhook Handler
 * Stores all webhook events to MongoDB collection: GithubWebhookEvents
 */
export async function POST(request: NextRequest) {
  try {
    // Get raw body for signature verification
    const rawBody = await request.text();

    // Verify signature
    const signature = request.headers.get("x-hub-signature-256");
    if (!verifySignature(rawBody, signature)) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    // Parse the JSON payload
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch (_error) {
      return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    // Extract GitHub webhook headers
    const eventType = request.headers.get("x-github-event");
    const deliveryId = request.headers.get("x-github-delivery");
    const hookId = request.headers.get("x-github-hook-id");
    const hookInstallationTargetId = request.headers.get("x-github-hook-installation-target-id");
    const hookInstallationTargetType = request.headers.get(
      "x-github-hook-installation-target-type",
    );

    // Create event document
    const eventDocument = {
      // GitHub webhook metadata
      eventType,
      deliveryId,
      hookId,
      hookInstallationTargetId,
      hookInstallationTargetType,

      // Payload
      payload,

      // Timestamps
      receivedAt: new Date(),

      // Request metadata
      userAgent: request.headers.get("user-agent"),

      // Processing status
      processed: false,
    };

    // Store to MongoDB. Dual-write: keep the historical
    // `GithubWebhookEvents` collection for back-compat, and also push into
    // the unified `webhook_queue` so the VM bot's changeStream consumer can
    // pick GitHub events up alongside Slack.
    const collection = db.collection("GithubWebhookEvents");
    const result = await collection.insertOne(eventDocument);

    if (deliveryId) {
      try {
        await enqueueWebhook({
          source: "github",
          eventId: deliveryId,
          payload,
          meta: {
            eventType,
            hookId,
            hookInstallationTargetId,
            hookInstallationTargetType,
            userAgent: request.headers.get("user-agent"),
            legacyId: result.insertedId.toString(),
          },
        });
      } catch (qerr) {
        console.warn("Failed to enqueue github webhook to webhook_queue", qerr);
      }
    }

    console.log(
      `Stored GitHub webhook event: ${eventType} (delivery: ${deliveryId}, _id: ${result.insertedId})`,
    );

    // Return success response
    return NextResponse.json(
      {
        success: true,
        eventId: result.insertedId,
        eventType,
        deliveryId,
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("Error processing GitHub webhook:", error);

    return NextResponse.json(
      {
        error: "Internal server error",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}

// Health check endpoint
export async function GET() {
  try {
    // Test database connection
    await db.admin().ping();

    const collection = db.collection("GithubWebhookEvents");
    const count = await collection.countDocuments();

    return NextResponse.json({
      status: "ok",
      message: "GitHub webhook endpoint is ready",
      eventsStored: count,
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
