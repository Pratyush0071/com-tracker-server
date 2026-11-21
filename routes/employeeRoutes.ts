import { Router } from 'express';
import type { Response } from 'express';
import mongoose from 'mongoose';
import { requireAuth, requireRole } from '../middleware/auth.ts';
import type { AuthRequest } from '../middleware/auth.ts';
import { EmployeeProfile } from '../models/EmployeeProfile.ts';
import { SalesEntry } from '../models/SalesEntry.ts';
import { IncentiveTransaction } from '../models/IncentiveTransaction.ts';
import { Notification } from '../models/Notification.ts';
import { TargetAchievement } from '../models/TargetAchievement.ts';
import {
  computeTargetProgress,
  ensureActiveCycleForEmployee,
  getOrCreateSystemSettings,
} from '../services/cycleService.ts';
import {
  createSalesEntryForEmployee,
  deleteSalesEntry,
  editSalesEntry,
} from '../services/financialService.ts';
import { buildSalesEntriesWorkbook } from '../services/excelService.ts';
import { rupeesToPaise } from '../utils/money.ts';
import { getISTParts } from '../utils/timezone.ts';

const router = Router();

router.use(requireAuth, requireRole('employee'));

router.get('/dashboard', async (req: AuthRequest, res: Response, next) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user!.userId);
    const profile = await EmployeeProfile.findOne({ userId, isDeleted: false });
    if (!profile) {
      res.status(404).json({ error: 'Employee profile not found' });
      return;
    }

    const now = new Date();
    const ist = getISTParts(now);
    const cycle = await ensureActiveCycleForEmployee(userId, profile._id, null, now);
    const targetProgress = computeTargetProgress(cycle, now);
    const visibilityFloor = cycle.visibilityStartAt || cycle.startTimestamp;

    const [todayAgg, achievements, recentEntries, unreadNotifications] = await Promise.all([
      SalesEntry.aggregate([
        {
          $match: {
            employeeId: userId,
            cycleId: cycle._id,
            entryDateIST: ist.dateStr,
            isDeleted: false,
          },
        },
        {
          $group: {
            _id: null,
            totalPaise: { $sum: '$amountPaise' },
            count: { $sum: 1 },
          },
        },
      ]),
      TargetAchievement.find({
        employeeId: userId,
        cycleId: cycle._id,
      })
        .sort({ milestoneAmountPaise: 1 })
        .lean(),
      SalesEntry.find({
        employeeId: userId,
        cycleId: cycle._id,
        isDeleted: false,
      })
        .select('-commissionRateBps -commissionPaise')
        .sort({ entryTimestamp: -1 })
        .limit(5)
        .lean(),
      Notification.countDocuments({
        recipientId: userId,
        recipientRole: 'employee',
        isRead: false,
        createdAt: { $gte: visibilityFloor },
      }),
    ]);

    const todaySalesPaise = todayAgg[0]?.totalPaise || 0;
    const todayEntriesCount = todayAgg[0]?.count || 0;
    const currentCycleEarningsPaise =
      (cycle.totalCommissionPaise || 0) + (cycle.totalIncentivesPaise || 0);

    res.json({
      employee: {
        employeeCode: profile.employeeCode,
        fullName: profile.fullName,
      },
      cycle: {
        id: cycle._id.toString(),
        cycleKey: cycle.cycleKey,
        label: cycle.label,
        startDateIST: cycle.startDateIST,
        endDateIST: cycle.endDateIST,
        totalSalesPaise: cycle.totalSalesPaise,
      },
      todaySalesPaise,
      todayEntriesCount,
      targetProgress,
      achievements,
      earnings: {
        currentCycleCommissionPaise: cycle.totalCommissionPaise || 0,
        currentCycleIncentivesPaise: cycle.totalIncentivesPaise || 0,
        totalEarningsPaise: currentCycleEarningsPaise,
      },
      recentEntries,
      unreadNotifications,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/sales', async (req: AuthRequest, res: Response, next) => {
  try {
    const { orderName = '', productName = '', amount, clientRequestId } = req.body;
    if (amount === undefined || amount === null || amount === '') {
      res.status(400).json({ error: 'Sale amount is required.' });
      return;
    }

    const amountPaise = rupeesToPaise(amount);
    if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
      res.status(400).json({ error: 'Amount must be greater than zero.' });
      return;
    }

    const result = await createSalesEntryForEmployee({
      employeeId: req.user!.userId,
      orderName: String(orderName || ''),
      productName: String(productName || ''),
      amountPaise,
      clientRequestId: clientRequestId ? String(clientRequestId) : undefined,
      ipAddress: req.ip,
    });

    const sanitizedEntry = result.entry
      ? {
          _id: result.entry._id,
          orderName: result.entry.orderName,
          productName: result.entry.productName,
          amountPaise: result.entry.amountPaise,
          entryDateIST: result.entry.entryDateIST,
          entryTimeIST: result.entry.entryTimeIST,
          status: result.entry.status,
          cycleKey: result.entry.cycleKey,
        }
      : null;

    res.status(result.duplicate ? 200 : 201).json({
      entry: sanitizedEntry,
      duplicate: result.duplicate,
      newlyCompletedMilestones: result.newlyCompletedMilestones,
      message: result.duplicate
        ? 'Entry already recorded.'
        : 'Sale entry saved successfully!',
    });
  } catch (err) {
    next(err);
  }
});

router.get('/sales', async (req: AuthRequest, res: Response, next) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user!.userId);
    const profile = await EmployeeProfile.findOne({ userId, isDeleted: false });
    if (!profile) {
      res.status(404).json({ error: 'Employee profile not found' });
      return;
    }

    const now = new Date();
    const cycle = await ensureActiveCycleForEmployee(userId, profile._id, null, now);
    const { startDate, endDate, search, page = '1', limit = '20' } = req.query;

    const filter: Record<string, unknown> = {
      employeeId: userId,
      cycleId: cycle._id,
      isDeleted: false,
    };

    if (startDate || endDate) {
      const dateQuery: Record<string, string> = {};
      if (startDate) dateQuery.$gte = String(startDate);
      if (endDate) dateQuery.$lte = String(endDate);
      filter.entryDateIST = dateQuery;
    }

    if (search && String(search).trim()) {
      const regex = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ orderName: regex }, { productName: regex }];
    }

    const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(String(limit), 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const ist = getISTParts(now);
    const settings = await getOrCreateSystemSettings();

    const [entries, totalCount, filteredAgg, todayAgg] = await Promise.all([
      SalesEntry.find(filter)
        .select('-commissionRateBps -commissionPaise')
        .sort({ entryTimestamp: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      SalesEntry.countDocuments(filter),
      SalesEntry.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            totalPaise: { $sum: '$amountPaise' },
          },
        },
      ]),
      SalesEntry.aggregate([
        {
          $match: {
            employeeId: userId,
            cycleId: cycle._id,
            entryDateIST: ist.dateStr,
            isDeleted: false,
          },
        },
        { $group: { _id: null, totalPaise: { $sum: '$amountPaise' } } },
      ]),
    ]);

    res.json({
      cycleLabel: cycle.label,
      entries,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalCount,
        totalPages: Math.max(1, Math.ceil(totalCount / limitNum)),
      },
      todaySalesPaise: todayAgg[0]?.totalPaise || 0,
      filteredTotalPaise: filteredAgg[0]?.totalPaise || 0,
      permissions: {
        allowEdit: settings.allowEmployeeEditEntry,
        allowDelete: settings.allowEmployeeDeleteEntry,
        editWindowHours: settings.employeeEditWindowHours,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/sales/export', async (req: AuthRequest, res: Response, next) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user!.userId);
    const profile = await EmployeeProfile.findOne({ userId, isDeleted: false });
    if (!profile) {
      res.status(404).json({ error: 'Employee profile not found' });
      return;
    }

    const cycle = await ensureActiveCycleForEmployee(userId, profile._id, null, new Date());
    const { startDate, endDate, search } = req.query;

    const filter: Record<string, unknown> = {
      employeeId: userId,
      cycleId: cycle._id,
      isDeleted: false,
    };

    if (startDate || endDate) {
      const dateQuery: Record<string, string> = {};
      if (startDate) dateQuery.$gte = String(startDate);
      if (endDate) dateQuery.$lte = String(endDate);
      filter.entryDateIST = dateQuery;
    }

    if (search && String(search).trim()) {
      const regex = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ orderName: regex }, { productName: regex }];
    }

    const entries = await SalesEntry.find(filter).sort({ entryTimestamp: -1 }).lean();
    const buffer = await buildSalesEntriesWorkbook({
      title: 'My Sales Entries',
      entries,
      includeEmployeeColumns: false,
      includeCommissionColumn: false,
    });

    const today = getISTParts().dateStr;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', `attachment; filename="my-sales-entries-${today}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

router.put('/sales/:id', async (req: AuthRequest, res: Response, next) => {
  try {
    const { orderName, productName, amount } = req.body;
    const amountPaise = rupeesToPaise(amount);

    const updated = await editSalesEntry({
      entryId: req.params.id,
      actorId: req.user!.userId,
      actorRole: 'employee',
      actorName: req.user!.fullName,
      orderName,
      productName,
      amountPaise,
      ipAddress: req.ip,
    });

    res.json({ entry: updated, message: 'Sales entry updated.' });
  } catch (err) {
    next(err);
  }
});

router.delete('/sales/:id', async (req: AuthRequest, res: Response, next) => {
  try {
    await deleteSalesEntry({
      entryId: req.params.id,
      actorId: req.user!.userId,
      actorRole: 'employee',
      actorName: req.user!.fullName,
      ipAddress: req.ip,
    });
    res.json({ message: 'Sales entry deleted.' });
  } catch (err) {
    next(err);
  }
});

router.get('/earnings', async (req: AuthRequest, res: Response, next) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user!.userId);
    const profile = await EmployeeProfile.findOne({ userId, isDeleted: false });
    if (!profile) {
      res.status(404).json({ error: 'Employee profile not found' });
      return;
    }

    const cycle = await ensureActiveCycleForEmployee(userId, profile._id, null, new Date());
    const incentives = await IncentiveTransaction.find({
      employeeId: userId,
      cycleId: cycle._id,
    }).lean();

    const targetIncentivesPaise = incentives
      .filter((i) => i.category === 'target_completion')
      .reduce((acc, i) => acc + i.amountPaise, 0);

    const otherIncentivesPaise = incentives
      .filter((i) => i.category === 'other')
      .reduce((acc, i) => acc + i.amountPaise, 0);

    const totalCommissionPaise = cycle.totalCommissionPaise || 0;
    const totalIncentivesPaise = cycle.totalIncentivesPaise || 0;
    const totalEarningsPaise = totalCommissionPaise + totalIncentivesPaise;

    res.json({
      cycleLabel: cycle.label,
      summary: {
        salesCommissionPaise: totalCommissionPaise,
        targetIncentivesPaise,
        otherIncentivesPaise,
        totalIncentivesPaise,
        totalEarningsPaise,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/notifications', async (req: AuthRequest, res: Response, next) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user!.userId);
    const profile = await EmployeeProfile.findOne({ userId, isDeleted: false });
    if (!profile) {
      res.status(404).json({ error: 'Employee profile not found' });
      return;
    }

    const cycle = await ensureActiveCycleForEmployee(userId, profile._id, null, new Date());
    const visibilityFloor = cycle.visibilityStartAt || cycle.startTimestamp;

    const filter = {
      recipientId: userId,
      recipientRole: 'employee' as const,
      createdAt: { $gte: visibilityFloor },
    };

    const [notifications, unreadCount] = await Promise.all([
      Notification.find(filter).sort({ createdAt: -1 }).limit(50).lean(),
      Notification.countDocuments({
        ...filter,
        isRead: false,
      }),
    ]);

    res.json({ notifications, unreadCount });
  } catch (err) {
    next(err);
  }
});

router.patch('/notifications/read-all', async (req: AuthRequest, res: Response, next) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user!.userId);
    await Notification.updateMany(
      { recipientId: userId, recipientRole: 'employee', isRead: false },
      { $set: { isRead: true, readAt: new Date() } }
    );
    res.json({ message: 'All notifications marked as read.' });
  } catch (err) {
    next(err);
  }
});

router.patch('/notifications/:id/read', async (req: AuthRequest, res: Response, next) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user!.userId);
    await Notification.findOneAndUpdate(
      { _id: req.params.id, recipientId: userId },
      { $set: { isRead: true, readAt: new Date() } }
    );
    res.json({ message: 'Notification marked as read.' });
  } catch (err) {
    next(err);
  }
});

export default router;
