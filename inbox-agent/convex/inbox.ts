/**
 * Reference Convex integration: an inbound message schedules the agent; the agent run is an
 * action (external model calls are only allowed in actions); results are written back in a
 * mutation that is idempotent per message.
 *
 * NOT executed or type-checked where this project was built (see README). Imports from ../src
 * assume Convex's bundler resolves them; if it does not, move the core into convex/ or a package.
 */
import { v } from "convex/values";
import { runInboxAgent } from "../src/agent.ts";
import { aiSdkModel } from "../src/ai-sdk-adapter.ts";
import { InMemoryKb } from "../src/kb.ts";
import type { Ticket } from "../src/types.ts";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery, mutation } from "./_generated/server";

export const receiveMessage = mutation({
  args: { ticketId: v.id("tickets"), body: v.string() },
  handler: async (ctx, args) => {
    const messageId = await ctx.db.insert("messages", {
      ticketId: args.ticketId,
      direction: "inbound",
      author: "contact",
      body: args.body,
    });
    await ctx.db.patch(args.ticketId, { lastMessageAt: Date.now(), status: "open" });
    // Scheduled inside the same transaction: if the mutation rolls back, the job is never queued.
    await ctx.scheduler.runAfter(0, internal.inbox.runAgent, { messageId });
    return messageId;
  },
});

export const loadContext = internalQuery({
  args: { messageId: v.id("messages") },
  handler: async (ctx, { messageId }) => {
    const message = await ctx.db.get(messageId);
    if (!message) return null;

    const alreadyProcessed = await ctx.db
      .query("agentRuns")
      .withIndex("by_message", (q) => q.eq("messageId", messageId))
      .unique();
    const ticketDoc = await ctx.db.get(message.ticketId);
    if (!ticketDoc) return null;

    const thread = await ctx.db
      .query("messages")
      .withIndex("by_ticket", (q) => q.eq("ticketId", message.ticketId))
      .collect();
    const previousContacts = thread.filter(
      (m) => m.direction === "inbound" && m._creationTime < message._creationTime,
    ).length;

    const chunks = await ctx.db.query("kbChunks").collect(); // fine for a small KB; use the kb-search retriever beyond that

    const ticket: Ticket = {
      id: ticketDoc._id,
      subject: ticketDoc.subject,
      body: message.body,
      senderRole: ticketDoc.senderRole,
      property: ticketDoc.property,
      previousContacts,
    };
    return {
      ticketId: ticketDoc._id,
      ticket,
      alreadyProcessed: alreadyProcessed !== null,
      chunks: chunks.map((c) => ({ title: c.title, heading: c.heading, text: c.text })),
    };
  },
});

export const runAgent = internalAction({
  args: { messageId: v.id("messages") },
  handler: async (ctx, { messageId }) => {
    const context = await ctx.runQuery(internal.inbox.loadContext, { messageId });
    if (!context || context.alreadyProcessed) return;

    const result = await runInboxAgent(context.ticket, {
      model: aiSdkModel(),
      kb: new InMemoryKb(context.chunks),
    });

    await ctx.runMutation(internal.inbox.recordResult, {
      messageId,
      ticketId: context.ticketId,
      action: result.decision.action,
      reply: result.decision.action === "reply" ? result.decision.reply : undefined,
      reasons: result.decision.action === "escalate" ? result.decision.reasons : [],
      classification: result.classification ?? undefined,
      modelCalls: result.modelCalls,
    });
  },
});

export const recordResult = internalMutation({
  args: {
    messageId: v.id("messages"),
    ticketId: v.id("tickets"),
    action: v.union(v.literal("reply"), v.literal("escalate")),
    reply: v.optional(v.string()),
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
  },
  handler: async (ctx, args) => {
    // Mutations are transactional, so check-then-insert cannot race with a duplicate run.
    const existing = await ctx.db
      .query("agentRuns")
      .withIndex("by_message", (q) => q.eq("messageId", args.messageId))
      .unique();
    if (existing) return;

    await ctx.db.insert("agentRuns", {
      ticketId: args.ticketId,
      messageId: args.messageId,
      action: args.action,
      reasons: args.reasons,
      classification: args.classification,
      modelCalls: args.modelCalls,
    });

    if (args.action === "reply" && args.reply) {
      // Storing the outbound message is as far as this sketch goes; actually sending it
      // (email/WhatsApp) would be its own action with its own retry policy.
      await ctx.db.insert("messages", {
        ticketId: args.ticketId,
        direction: "outbound",
        author: "agent",
        body: args.reply,
      });
      await ctx.db.patch(args.ticketId, { status: "agent_replied" });
    } else {
      await ctx.db.patch(args.ticketId, { status: "escalated" });
    }
  },
});
