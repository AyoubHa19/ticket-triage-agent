/**
 * Reference Convex schema for the inbox agent.
 *
 * NOT executed or type-checked where this project was built (needs `npx convex dev`, which also
 * generates ./_generated/*). It shows the data-modelling choices; see README for what is verified.
 */
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  tickets: defineTable({
    subject: v.string(),
    status: v.union(
      v.literal("open"),
      v.literal("agent_replied"),
      v.literal("escalated"),
      v.literal("closed"),
    ),
    senderRole: v.union(v.literal("tenant"), v.literal("owner"), v.literal("vendor"), v.literal("unknown")),
    property: v.optional(v.string()),
    lastMessageAt: v.number(),
  })
    // Inbox view: "all escalated tickets, newest first" is one indexed range scan.
    .index("by_status_and_lastMessageAt", ["status", "lastMessageAt"]),

  messages: defineTable({
    ticketId: v.id("tickets"),
    direction: v.union(v.literal("inbound"), v.literal("outbound")),
    author: v.union(v.literal("contact"), v.literal("agent"), v.literal("human")),
    body: v.string(),
  }).index("by_ticket", ["ticketId"]),

  // One row per inbound message the agent processed. The unique-by-message index is the
  // idempotency guard: the scheduler may run an action twice, but only one result is recorded.
  agentRuns: defineTable({
    ticketId: v.id("tickets"),
    messageId: v.id("messages"),
    action: v.union(v.literal("reply"), v.literal("escalate")),
    reasons: v.array(v.string()),
    classification: v.optional(
      v.object({
        category: v.string(),
        urgency: v.string(),
        confidence: v.number(),
        summary: v.string(),
      }),
    ),
    modelCalls: v.number(),
  })
    .index("by_message", ["messageId"])
    .index("by_ticket", ["ticketId"]),

  kbChunks: defineTable({
    title: v.string(),
    heading: v.string(),
    text: v.string(),
  }),
});
