import express from "express";
import cors from "cors";
import authRouter from "./routes/auth";
import creatorsRouter from "./routes/creators";
import donationsRouter from "./routes/donations";
import withdrawalsRouter from "./routes/withdrawals";
import subscriptionsRouter from "./routes/subscriptions";
import goalsRouter from "./routes/goals";
import eventsRouter from "./routes/events";
import adminRouter from "./routes/admin";
import activityRouter from "./routes/activity";
import accountRouter from "./routes/account";
import emailWebhooksRouter from "./routes/emailWebhooks";
import { errorHandler } from "./middleware/errorHandler";
import { requestLogger } from "./middleware/requestLogger";
import { checkSorobanRpc } from "./services/sorobanHealth";
import { executorHealth } from "./services/executorHealth";

const app = express();

app.use(requestLogger);
app.use(cors());

// Mounted with express.raw() ahead of the global express.json() below: Svix
// signature verification (see routes/emailWebhooks.ts) needs the exact raw
// request body, not one that's already been parsed and would have to be
// re-serialized (and could byte-for-byte differ from what Resend signed).
app.use("/api/webhooks/email", express.raw({ type: "application/json" }), emailWebhooksRouter);

app.use(express.json());

app.get("/health", async (req, res) => {
  const sorobanRpc = await checkSorobanRpc();
  const subscriptionExecutor = executorHealth.getHealth();
  const status =
    subscriptionExecutor.status === "unhealthy"
      ? "unhealthy"
      : sorobanRpc.status === "ok"
        ? "ok"
        : "degraded";
  return res.json({
    status,
    timestamp: new Date().toISOString(),
    dependencies: { sorobanRpc, subscriptionExecutor },
  });
});

app.get("/health/executor", (req, res) => {
  const subscriptionExecutor = executorHealth.getHealth();
  return res.json({
    status: subscriptionExecutor.status === "unhealthy" ? "unhealthy" : "ok",
    timestamp: new Date().toISOString(),
    subscriptionExecutor,
  });
});

app.use("/api/auth", authRouter);
app.use("/api/creators", creatorsRouter);
app.use("/api/donations", donationsRouter);
app.use("/api/withdrawals", withdrawalsRouter);
app.use("/api/subscriptions", subscriptionsRouter);
app.use("/api/goals", goalsRouter);
app.use("/api/events", eventsRouter);
app.use("/api/admin", adminRouter);
app.use("/api/activity", activityRouter);
app.use("/api/account", accountRouter);

app.use((req, res) => {
  return res.status(404).json({
    error: "Not Found",
    code: "NOT_FOUND",
    ...(req.requestId ? { requestId: req.requestId } : {}),
  });
});

app.use(errorHandler);

export default app;

