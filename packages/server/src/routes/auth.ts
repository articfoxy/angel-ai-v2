import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import { prisma } from '../index';
import { generateToken, generateRefreshToken, authenticateToken, AuthRequest } from '../middleware/auth';

export const authRouter = Router();

const appleJwksClient = jwksClient({
  jwksUri: 'https://appleid.apple.com/auth/keys',
  cache: true,
  rateLimit: true,
});

// Register
authRouter.post('/register', async (req: Request, res: Response) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password) {
      res.status(400).json({ error: 'Email and password required' });
      return;
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      res.status(409).json({ error: 'Email already registered' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: { email, passwordHash, name, provider: 'email' },
    });

    // Create empty core memory
    await prisma.coreMemory.create({ data: { userId: user.id } });

    const accessToken = generateToken(user.id);
    const refreshToken = generateRefreshToken(user.id);

    res.json({
      success: true,
      data: {
        accessToken,
        refreshToken,
        user: { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt },
      },
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login
authRouter.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    if (!user.passwordHash) {
      res.status(401).json({ error: 'This account uses Apple Sign In. Please sign in with Apple.' });
      return;
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const accessToken = generateToken(user.id);
    const refreshToken = generateRefreshToken(user.id);

    res.json({
      success: true,
      data: {
        accessToken,
        refreshToken,
        user: { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt },
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Apple Sign In
authRouter.post('/apple', async (req: Request, res: Response) => {
  try {
    const { identityToken, fullName } = req.body;
    if (!identityToken) {
      res.status(400).json({ error: 'Identity token required' });
      return;
    }

    // Decode header to get kid
    const decoded = jwt.decode(identityToken, { complete: true });
    if (!decoded || !decoded.header.kid) {
      res.status(401).json({ error: 'Invalid Apple token' });
      return;
    }

    // Get signing key
    const key = await appleJwksClient.getSigningKey(decoded.header.kid);
    const signingKey = key.getPublicKey();

    // Verify token
    const payload = jwt.verify(identityToken, signingKey, {
      algorithms: ['RS256'],
      issuer: 'https://appleid.apple.com',
    }) as { sub: string; email?: string };

    // Find or create user
    let user = await prisma.user.findFirst({
      where: { provider: 'apple', providerUserId: payload.sub },
    });

    if (!user && payload.email) {
      user = await prisma.user.findUnique({ where: { email: payload.email } });
      if (user) {
        user = await prisma.user.update({
          where: { id: user.id },
          data: { provider: 'apple', providerUserId: payload.sub },
        });
      }
    }

    if (!user) {
      const name = fullName
        ? [fullName.givenName, fullName.familyName].filter(Boolean).join(' ')
        : undefined;

      user = await prisma.user.create({
        data: {
          email: payload.email,
          name: name || null,
          provider: 'apple',
          providerUserId: payload.sub,
        },
      });

      // Create empty core memory
      await prisma.coreMemory.create({ data: { userId: user.id } });
    }

    const accessToken = generateToken(user.id);
    const refreshToken = generateRefreshToken(user.id);

    res.json({
      success: true,
      data: {
        accessToken,
        refreshToken,
        user: { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt },
      },
    });
  } catch (err) {
    console.error('Apple auth error:', err);
    res.status(401).json({ error: 'Apple authentication failed' });
  }
});

// Refresh token
authRouter.post('/refresh', async (req: Request, res: Response) => {
  try {
    const { refreshToken: token } = req.body;
    if (!token) {
      res.status(400).json({ error: 'Refresh token required' });
      return;
    }

    const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev-secret') as {
      userId: string;
      type: string;
    };

    if (payload.type !== 'refresh') {
      res.status(401).json({ error: 'Invalid refresh token' });
      return;
    }

    const accessToken = generateToken(payload.userId);
    const newRefreshToken = generateRefreshToken(payload.userId);

    res.json({ success: true, data: { accessToken, refreshToken: newRefreshToken } });
  } catch {
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

// Get current user
authRouter.get('/me', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({
      success: true,
      data: { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt },
    });
  } catch {
    res.status(500).json({ error: 'Failed to get user' });
  }
});
