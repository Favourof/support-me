import { z } from "zod";
import { stellarAddress } from "./common";

export const challengeSchema = z.object({
  walletAddress: stellarAddress,
});

export const verifySchema = z.object({
  walletAddress: stellarAddress,
  signedMessage: z.string().min(1, "signedMessage is required"),
});

export const magicLinkRequestSchema = z.object({
  email: z.string().trim().email("Must be a valid email address"),
});

export const magicLinkVerifySchema = z.object({
  token: z.string().min(1, "token is required"),
});
