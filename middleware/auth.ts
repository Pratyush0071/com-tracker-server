import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.ts';
import { User } from '../models/User.ts';
import type { UserRole } from '../models/User.ts';

export interface AuthUserPayload {
  userId: string;
  role: UserRole;
  username: string;
  fullName: string;
}

export interface AuthRequest extends Request {
  user?: AuthUserPayload;
}

export function signAuthToken(payload: AuthUserPayload): string {
  if (!env.jwtSecret) {
    throw new Error('JWT_SECRET is not configured');
  }
  return jwt.sign(payload, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn as jwt.SignOptions['expiresIn'],
  });
}

export async function requireAuth(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Authentication required. Please log in.' });
      return;
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
      res.status(401).json({ error: 'Authentication token missing.' });
      return;
    }

    const decoded = jwt.verify(token, env.jwtSecret) as AuthUserPayload;
    const user = await User.findOne({
      _id: decoded.userId,
      isDeleted: false,
    }).lean();

    if (!user || !user.isActive) {
      res.status(401).json({ error: 'Account is inactive or no longer exists.' });
      return;
    }

    req.user = {
      userId: user._id.toString(),
      role: user.role,
      username: user.username,
      fullName: user.fullName,
    };

    next();
  } catch (err: unknown) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'TokenExpiredError') {
      res.status(401).json({ error: 'Session expired. Please log in again.', code: 'TOKEN_EXPIRED' });
      return;
    }
    res.status(401).json({ error: 'Invalid authentication token.' });
  }
}

export function requireRole(role: UserRole) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (req.user.role !== role) {
      res.status(403).json({ error: 'Forbidden: insufficient permissions' });
      return;
    }
    next();
  };
}
