import { Router } from 'express';
import { randomBytes, createHash } from 'crypto';
import { Keypair } from '@stellar/stellar-sdk';
import prisma from '../prisma';
import { generateToken } from '../middleware/auth';
import { asyncHandler } from '../middleware/asyncHandler';
import { validate } from '../middleware/validate';
import {
  challengeSchema,
  magicLinkRequestSchema,
  magicLinkVerifySchema,
  twitterCallbackSchema,
  verifySchema,
} from '../schemas/auth';
import { UnauthorizedError } from '../errors/AppError';
import { requestMagicLink, verifyMagicLink } from '../services/magicLink';
import { completeTwitterAuth, startTwitterAuth } from '../services/twitterAuth';

const router = Router();

const STELLAR_SIGNED_MESSAGE_PREFIX = 'Stellar Signed Message:\n';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

interface Challenge {
  message: string;
  expiresAt: number;
}

const challenges = new Map<string, Challenge>();

router.post(
  '/challenge',
  validate({ body: challengeSchema }),
  asyncHandler(async (req, res) => {
    const { walletAddress } = req.body;

    const nonce = randomBytes(16).toString('hex');
    const message = `Sign in to SupportMe\n\nAddress: ${walletAddress}\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;

    challenges.set(walletAddress, { message, expiresAt: Date.now() + CHALLENGE_TTL_MS });

    return res.json({ message });
  })
);

router.post(
  '/verify',
  validate({ body: verifySchema }),
  asyncHandler(async (req, res) => {
    const { walletAddress, signedMessage } = req.body;

    const challenge = challenges.get(walletAddress);
    if (!challenge || challenge.expiresAt < Date.now()) {
      challenges.delete(walletAddress);
      throw new UnauthorizedError('Challenge expired or not found, please try again');
    }

    const payload = Buffer.concat([
      Buffer.from(STELLAR_SIGNED_MESSAGE_PREFIX, 'utf-8'),
      Buffer.from(challenge.message, 'utf-8'),
    ]);
    const hash = createHash('sha256').update(payload).digest();

    let signatureValid = false;
    try {
      signatureValid = Keypair.fromPublicKey(walletAddress).verify(
        hash,
        Buffer.from(signedMessage, 'base64')
      );
    } catch (error) {
      console.error('Signature verification error:', error);
      throw new UnauthorizedError('Signature verification failed');
    }

    if (!signatureValid) {
      throw new UnauthorizedError('Invalid signature');
    }

    challenges.delete(walletAddress);

    const user = await prisma.user.upsert({
      where: { walletAddress },
      update: {},
      create: { walletAddress },
    });

    const creator = await prisma.creator.findUnique({ where: { userId: user.id } });

    const token = generateToken(user.id, user.walletAddress);
    return res.json({
      user: { id: user.id, walletAddress: user.walletAddress },
      token,
      hasProfile: !!creator,
      username: creator?.username,
    });
  })
);

// Magic link (#15): email-only sign-in, the second auth method alongside
// the wallet-signature flow above.
router.post(
  '/magic-link',
  validate({ body: magicLinkRequestSchema }),
  asyncHandler(async (req, res) => {
    const { email } = req.body;

    await requestMagicLink(email);

    // Same response for a new email and a returning one: this endpoint
    // must not be usable to enumerate which addresses already have an
    // account. A rate-limited request is the one exception, surfaced as
    // its own 429 (asyncHandler routes the thrown TooManyRequestsError to
    // the global error handler) rather than folded into this message,
    // since "you're sending too many requests" doesn't leak anything
    // about the target address's account status.
    return res.json({ message: 'If that email is valid, a sign-in link has been sent.' });
  })
);

router.post(
  '/magic-link/verify',
  validate({ body: magicLinkVerifySchema }),
  asyncHandler(async (req, res) => {
    const { token } = req.body;

    const session = await verifyMagicLink(token);

    return res.json(session);
  })
);

// Twitter/X OAuth (#14): the frontend flow in issue #10 calls these two
// endpoints — /twitter to get the URL to redirect the user to, then
// /twitter/callback once Twitter redirects back with a code.
router.get(
  '/twitter',
  asyncHandler(async (req, res) => {
    const redirectUrl = startTwitterAuth();
    return res.json({ redirectUrl });
  })
);

router.get(
  '/twitter/callback',
  validate({ query: twitterCallbackSchema }),
  asyncHandler(async (req, res) => {
    const { code, state } = req.query as unknown as { code: string; state: string };

    const session = await completeTwitterAuth(code, state);

    return res.json(session);
  })
);

export default router;
