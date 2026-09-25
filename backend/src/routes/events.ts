import { Router } from "express";
import {
  DONATION_EVENT,
  SUBSCRIPTION_CREATED_EVENT,
  SUBSCRIPTION_CANCELLED_EVENT,
  GOAL_UPDATED_EVENT,
  DONATION_RECORDED_EVENT,
  DonationEvent,
  SubscriptionCreatedEvent,
  SubscriptionCancelledEvent,
  GoalUpdatedEvent,
  DonationRecordedEvent,
  eventBus,
} from "../services/eventBus";

const router = Router();

/**
 * Server-Sent Events stream of on-chain contract events. The frontend
 * dashboard opens this with `EventSource` to get live updates for donations,
 * subscriptions, and creator goals without polling the REST API.
 */
router.get("/", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders?.();

  // Comment ping so proxies/browsers don't time out an idle connection.
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 30000);

  const onDonation = (payload: DonationEvent) => {
    res.write(`event: donation\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  const onSubCreated = (payload: SubscriptionCreatedEvent) => {
    res.write(`event: subscription_created\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  const onSubCancelled = (payload: SubscriptionCancelledEvent) => {
    res.write(`event: subscription_cancelled\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  const onGoalUpdated = (payload: GoalUpdatedEvent) => {
    res.write(`event: goal_updated\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  const onDonationRecorded = (payload: DonationRecordedEvent) => {
    res.write(`event: donation_recorded\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  eventBus.on(DONATION_EVENT, onDonation);
  eventBus.on(SUBSCRIPTION_CREATED_EVENT, onSubCreated);
  eventBus.on(SUBSCRIPTION_CANCELLED_EVENT, onSubCancelled);
  eventBus.on(GOAL_UPDATED_EVENT, onGoalUpdated);
  eventBus.on(DONATION_RECORDED_EVENT, onDonationRecorded);

  req.on("close", () => {
    clearInterval(heartbeat);
    eventBus.off(DONATION_EVENT, onDonation);
    eventBus.off(SUBSCRIPTION_CREATED_EVENT, onSubCreated);
    eventBus.off(SUBSCRIPTION_CANCELLED_EVENT, onSubCancelled);
    eventBus.off(GOAL_UPDATED_EVENT, onGoalUpdated);
    eventBus.off(DONATION_RECORDED_EVENT, onDonationRecorded);
    res.end();
  });
});

export default router;
