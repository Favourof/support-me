jest.mock("../../prisma", () => ({
  __esModule: true,
  default: {
    emailEvent: {
      create: jest.fn(),
    },
  },
}));

import { createHmac } from "crypto";
import request from "supertest";
import app from "../../app";
import prisma from "../../prisma";

const mockedPrisma = prisma as unknown as {
  emailEvent: { create: jest.Mock };
};

const WEBHOOK_SECRET = "whsec_dGVzdHNlY3JldGtleWZvcnRlc3Rpbmc="; // base64 payload after the whsec_ prefix

function signPayload(payload: string, msgId: string, timestamp: number) {
  const secretBytes = Buffer.from(WEBHOOK_SECRET.split("_")[1], "base64");
  const toSign = `${msgId}.${timestamp}.${payload}`;
  const signature = createHmac("sha256", secretBytes).update(toSign).digest("base64");
  return {
    "svix-id": msgId,
    "svix-timestamp": timestamp.toString(),
    "svix-signature": `v1,${signature}`,
  };
}

function postWebhook(payload: object) {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const headers = signPayload(body, "msg_test123", timestamp);

  return request(app)
    .post("/api/webhooks/email/resend")
    .set("Content-Type", "application/json")
    .set(headers)
    .send(body);
}

describe("POST /api/webhooks/email/resend", () => {
  const originalSecret = process.env.RESEND_WEBHOOK_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RESEND_WEBHOOK_SECRET = WEBHOOK_SECRET;
    mockedPrisma.emailEvent.create.mockResolvedValue({});
  });

  afterAll(() => {
    process.env.RESEND_WEBHOOK_SECRET = originalSecret;
  });

  it("records a BOUNCED event for a validly signed email.bounced payload", async () => {
    const res = await postWebhook({
      type: "email.bounced",
      data: {
        email_id: "resend-abc",
        to: ["supporter@example.com"],
        subject: "Your subscription renewed",
        bounce: { message: "mailbox does not exist" },
      },
    });

    expect(res.status).toBe(200);
    expect(mockedPrisma.emailEvent.create).toHaveBeenCalledWith({
      data: {
        recipient: "supporter@example.com",
        subject: "Your subscription renewed",
        type: "BOUNCED",
        providerMessageId: "resend-abc",
        errorDetail: "mailbox does not exist",
      },
    });
  });

  it("records a DELIVERED event for a validly signed email.delivered payload", async () => {
    const res = await postWebhook({
      type: "email.delivered",
      data: { email_id: "resend-def", to: ["supporter@example.com"], subject: "Receipt" },
    });

    expect(res.status).toBe(200);
    expect(mockedPrisma.emailEvent.create).toHaveBeenCalledWith({
      data: {
        recipient: "supporter@example.com",
        subject: "Receipt",
        type: "DELIVERED",
        providerMessageId: "resend-def",
        errorDetail: undefined,
      },
    });
  });

  it("acknowledges but does not record an event type it doesn't act on", async () => {
    const res = await postWebhook({
      type: "email.sent",
      data: { email_id: "resend-ghi", to: ["supporter@example.com"], subject: "Receipt" },
    });

    expect(res.status).toBe(200);
    expect(mockedPrisma.emailEvent.create).not.toHaveBeenCalled();
  });

  it("rejects a payload with an invalid signature", async () => {
    const body = JSON.stringify({
      type: "email.bounced",
      data: { to: ["supporter@example.com"] },
    });

    const res = await request(app)
      .post("/api/webhooks/email/resend")
      .set("Content-Type", "application/json")
      .set({
        "svix-id": "msg_test123",
        "svix-timestamp": Math.floor(Date.now() / 1000).toString(),
        "svix-signature": "v1,not-a-real-signature",
      })
      .send(body);

    expect(res.status).toBe(400);
    expect(mockedPrisma.emailEvent.create).not.toHaveBeenCalled();
  });

  it("rejects when the webhook secret is not configured", async () => {
    delete process.env.RESEND_WEBHOOK_SECRET;

    const res = await postWebhook({
      type: "email.bounced",
      data: { to: ["supporter@example.com"] },
    });

    expect(res.status).toBe(500);
    expect(mockedPrisma.emailEvent.create).not.toHaveBeenCalled();
  });
});
