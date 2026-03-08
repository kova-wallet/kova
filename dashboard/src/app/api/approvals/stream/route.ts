import { NextRequest } from "next/server";
import { getApprovalChannel } from "@/lib/wallet-manager";
import { requireDashboardAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = requireDashboardAuth(req);
  if (!auth.authenticated) return auth.response;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // Send initial connected event so the client knows the stream is alive
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "connected" })}\n\n`));

      const channel = getApprovalChannel();

      // Send any currently pending approvals
      const pending = channel?.getPendingApprovals() ?? [];
      for (const req of pending) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "new", approval: req })}\n\n`
          )
        );
      }

      // Register listener for new approval requests
      const listener = (request: unknown) => {
        try {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "new", approval: request })}\n\n`
            )
          );
        } catch {
          // Connection closed — will be cleaned up
          channel?.removeListener(listener);
        }
      };

      channel?.addListener(listener);

      // Heartbeat every 15s to keep connection alive and detect disconnects
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          clearInterval(heartbeat);
          channel?.removeListener(listener);
        }
      }, 15_000);

      // Re-check the channel periodically in case the wallet was created
      // after the SSE connection was established (Next.js dev mode timing)
      let currentChannel = channel;
      const recheckInterval = setInterval(() => {
        const latestChannel = getApprovalChannel();
        if (latestChannel && latestChannel !== currentChannel) {
          currentChannel?.removeListener(listener);
          currentChannel = latestChannel;
          currentChannel.addListener(listener);
          // Send any pending approvals from the new channel
          for (const req of currentChannel.getPendingApprovals()) {
            try {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "new", approval: req })}\n\n`
                )
              );
            } catch {
              // ignore
            }
          }
        }
      }, 3_000);

    },
    cancel() {
      // Called when the client disconnects
      // Intervals and listeners are cleaned up via their catch blocks
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
