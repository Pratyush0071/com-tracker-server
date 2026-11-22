import { Router } from 'express';
import type { Response } from 'express';
import bcrypt from 'bcryptjs';
import { User } from '../models/User.js';
import { EmployeeProfile } from '../models/EmployeeProfile.js';
import { Notification } from '../models/Notification.js';
import { requireAuth, signAuthToken } from '../middleware/auth.js';
import type { AuthRequest } from '../middleware/auth.js';
import { loginLimiter } from '../middleware/rateLimit.js';
import { getOrCreateSystemSettings } from '../services/cycleService.js';
import { recordAuditLog } from '../services/auditService.js';

const router = Router();

router.get('/setup-status', async (_req, res: Response, next) => {
  try {
    const adminCount = await User.countDocuments({ role: 'admin', isDeleted: false });
    const settings = await getOrCreateSystemSettings();
    res.json({
      needsAdminSetup: adminCount === 0,
      companyName: settings.companyName,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/setup-admin', async (req, res: Response, next) => {
  try {
    const adminCount = await User.countDocuments({ role: 'admin', isDeleted: false });
    if (adminCount > 0) {
      res.status(403).json({ error: 'Administrator account already exists.' });
      return;
    }

    const { username, email, password, fullName } = req.body;
    if (!username || !email || !password || String(password).length < 4) {
      res.status(400).json({
        error: 'Username, email, and a password of at least 4 characters are required.',
      });
      return;
    }

    const passwordHash = await bcrypt.hash(String(password), 12);
    const admin = await User.create({
      username: String(username).toLowerCase().trim(),
      email: String(email).toLowerCase().trim(),
      passwordHash,
      role: 'admin',
      fullName: String(fullName || 'System Administrator').trim(),
      isActive: true,
      isDeleted: false,
    });

    const token = signAuthToken({
      userId: admin._id.toString(),
      role: admin.role,
      username: admin.username,
      fullName: admin.fullName,
    });

    res.status(201).json({
      token,
      user: {
        id: admin._id.toString(),
        username: admin.username,
        email: admin.email,
        role: admin.role,
        fullName: admin.fullName,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/login', loginLimiter, async (req, res: Response, next) => {
  try {
    const { identifier, password } = req.body;
    if (!identifier || !password) {
      res.status(400).json({ error: 'Username/email and password are required.' });
      return;
    }

    const normalized = String(identifier).toLowerCase().trim();
    const user = await User.findOne({
      $or: [{ username: normalized }, { email: normalized }],
      isDeleted: false,
    });

    if (!user) {
      res.status(401).json({ error: 'Invalid username/email or password.' });
      return;
    }

    if (!user.isActive) {
      res.status(403).json({
        error: 'Your account is currently deactivated. Please contact your administrator.',
      });
      return;
    }

    const isMatch = await bcrypt.compare(String(password), user.passwordHash);
    if (!isMatch) {
      res.status(401).json({ error: 'Invalid username/email or password.' });
      return;
    }

    user.lastLoginAt = new Date();
    await user.save();

    let employeeProfile = null;
    if (user.role === 'employee') {
      employeeProfile = await EmployeeProfile.findOne({
        userId: user._id,
        isDeleted: false,
      }).lean();
      if (!employeeProfile || !employeeProfile.isActive) {
        res.status(403).json({
          error: 'Employee profile is inactive. Please contact your administrator.',
        });
        return;
      }
    }

    const token = signAuthToken({
      userId: user._id.toString(),
      role: user.role,
      username: user.username,
      fullName: user.fullName,
    });

    res.json({
      token,
      user: {
        id: user._id.toString(),
        username: user.username,
        email: user.email,
        role: user.role,
        fullName: user.fullName,
        employeeCode: employeeProfile?.employeeCode,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireAuth, async (req: AuthRequest, res: Response, next) => {
  try {
    const user = await User.findById(req.user!.userId).select('-passwordHash').lean();
    if (!user || user.isDeleted) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const settings = await getOrCreateSystemSettings();
    let employeeProfile = null;
    if (user.role === 'employee') {
      employeeProfile = await EmployeeProfile.findOne({
        userId: user._id,
        isDeleted: false,
      }).lean();
    }

    const unreadCount =
      user.role === 'admin'
        ? await Notification.countDocuments({ recipientRole: 'admin', isRead: false })
        : await Notification.countDocuments({
            recipientId: user._id,
            recipientRole: 'employee',
            isRead: false,
          });

    res.json({
      user: {
        id: user._id.toString(),
        username: user.username,
        email: user.email,
        role: user.role,
        fullName: user.fullName,
        employeeCode: employeeProfile?.employeeCode,
      },
      employeeProfile,
      unreadNotifications: unreadCount,
      companyName: settings.companyName,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/change-password', requireAuth, async (req: AuthRequest, res: Response, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword || String(newPassword).length < 4) {
      res.status(400).json({
        error: 'Current password and new password (min 4 characters) are required.',
      });
      return;
    }

    const user = await User.findById(req.user!.userId);
    if (!user || user.isDeleted) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const valid = await bcrypt.compare(String(currentPassword), user.passwordHash);
    if (!valid) {
      res.status(400).json({ error: 'Current password is incorrect.' });
      return;
    }

    user.passwordHash = await bcrypt.hash(String(newPassword), 12);
    await user.save();

    await recordAuditLog({
      actorId: user._id,
      actorRole: user.role,
      actorName: user.fullName,
      action: 'PASSWORD_CHANGED',
      entityType: 'User',
      entityId: user._id.toString(),
      ipAddress: req.ip,
    });

    res.json({ message: 'Password updated successfully.' });
  } catch (err) {
    next(err);
  }
});

export default router;
