import app from "./app";
import { sorobanEventListener } from "./services/sorobanEventListener";
import { subscriptionExecutor } from "./services/subscriptionExecutor";
import { goalResetScheduler } from "./services/goalResetScheduler";

const port = process.env.PORT ?? 4000;

app.listen(port, () => {
  console.log(`SupportMe backend listening on http://localhost:${port}`);
  sorobanEventListener.start();
  subscriptionExecutor.start();
  goalResetScheduler.start();
});
