import { Router } from 'express';
import type { Response } from 'express';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { requireAuth, requireRole } from '../middleware/auth.js';
import type { AuthRequest } from '../middleware/auth.js';
import { User } from '../models/User.js';
import { EmployeeProfile } from '../models/EmployeeProfile.js';
import { SalesEntry } from '../models/SalesEntry.js';
import { TargetCycle } from '../models/TargetCycle.js';
import { TargetAchievement } from '../models/TargetAchievement.js';
import { CommissionTransaction } from '../models/CommissionTransaction.js';
import { IncentiveTransaction } from '../models/IncentiveTransaction.js';
import { Withdrawal } from '../models/Withdrawal.js';
import { Notification } from '../models/Notification.js';
import { AuditLog } from '../models/AuditLog.js';
import {
  computeTargetProgress,
  ensureActiveCycleForEmployee,
  getOrCreateSystemSettings,
  getOrCreateTargetConfig,
  updateEmployeeTargetCycle,
} from '../services/cycleService.js';
import {
  approveDirectPayout,
  approveWithdrawal,
  clearAllEmployeeData,
  computeAvailableBalancePaise,
  deleteDataSelectively,
  deleteSalesEntry,
  editSalesEntry,
  grantIncentive,
  markWithdrawalPaid,
  rejectWithdrawal,
} from '../services/financialService.js';
import { createNotification } from '../services/notificationService.js';
import { recordAuditLog } from '../services/auditService.js';
import {
  buildAllEmployeesCompanyWorkbook,
  buildIndividualEmployeeWorkbook,
  buildSalesEntriesWorkbook,
} from '../services/excelService.js';
import { rupeesToPaise } from '../utils/money.js';
import {
  getCalendarMonthRangeIST,
  getCycleBoundsForDate,
  getISTParts,
  getThisWeekStartISTDateStr,
  getYesterdayISTDateStr,
} from '../utils/timezone.js';

const router = Router();

router.use(requireAuth, requireRole('admin'));

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveDateRangeFromPreset(
  preset: string | undefined,
  startDate?: string,
  endDate?: string,
  cycleDay: number = 20
): { startDateIST?: string; endDateIST?: string; cycleKey?: string } {
  const now = new Date();
  const todayIST = getISTParts(now).dateStr;

  switch (preset) {
    case 'today':
      return { startDateIST: todayIST, endDateIST: todayIST };
    case 'yesterday': {
      const y = getYesterdayISTDateStr(now);
      return { startDateIST: y, endDateIST: y };
    }
    case 'this_week':
      return { startDateIST: getThisWeekStartISTDateStr(now), endDateIST: todayIST };
    case 'this_month': {
      const m = getCalendarMonthRangeIST(now, 0);
      return { startDateIST: m.startDateIST, endDateIST: m.endDateIST };
    }
    case 'previous_month': {
      const m = getCalendarMonthRangeIST(now, -1);
      return { startDateIST: m.startDateIST, endDateIST: m.endDateIST };
    }
    case 'current_cycle': {
      const bounds = getCycleBoundsForDate(now, cycleDay);
      return { cycleKey: bounds.cycleKey };
    }
    case 'lifetime':
      return {};
    case 'custom':
      return {
        startDateIST: startDate || undefined,
        endDateIST: endDate || undefined,
      };
    default:
      if (startDate || endDate) {
        return { startDateIST: startDate, endDateIST: endDate };
      }
      return {};
  }
}

// 1. ADMIN DASHBOARD
router.get('/dashboard', async (_req: AuthRequest, res: Response, next) => {
  try {
    const now = new Date();
    const ist = getISTParts(now);
    const settings = await getOrCreateSystemSettings();
    const currentBounds = getCycleBoundsForDate(now, settings.withdrawalDayOfMonth);
    const currentMonthRange = getCalendarMonthRangeIST(now, 0);

    const [
      employees,
      todayAgg,
      cycleAgg,
      monthAgg,
      withdrawalsPendingAgg,
      withdrawalsPaidAgg,
      dailyAgg,
      monthlyAgg,
      employeeCycleSalesAgg,
      employeeTodayAgg,
      employeeMonthAgg,
      unreadNotifications,
    ] = await Promise.all([
      EmployeeProfile.find({ isDeleted: false }).lean(),
      SalesEntry.aggregate([
        { $match: { entryDateIST: ist.dateStr, isDeleted: false } },
        { $group: { _id: null, total: { $sum: '$amountPaise' }, count: { $sum: 1 } } },
      ]),
      SalesEntry.aggregate([
        { $match: { cycleKey: currentBounds.cycleKey, isDeleted: false } },
        { $group: { _id: null, total: { $sum: '$amountPaise' }, count: { $sum: 1 } } },
      ]),
      SalesEntry.aggregate([
        {
          $match: {
            entryDateIST: {
              $gte: currentMonthRange.startDateIST,
              $lte: currentMonthRange.endDateIST,
            },
            isDeleted: false,
          },
        },
        { $group: { _id: null, total: { $sum: '$amountPaise' } } },
      ]),
      Withdrawal.aggregate([
        { $match: { status: 'pending' } },
        { $group: { _id: null, total: { $sum: '$amountPaise' }, count: { $sum: 1 } } },
      ]),
      Withdrawal.aggregate([
        { $match: { status: 'paid' } },
        { $group: { _id: null, total: { $sum: '$amountPaise' }, count: { $sum: 1 } } },
      ]),
      SalesEntry.aggregate([
        { $match: { isDeleted: false } },
        {
          $group: {
            _id: '$entryDateIST',
            salesPaise: { $sum: '$amountPaise' },
            entries: { $sum: 1 },
          },
        },
        { $sort: { _id: -1 } },
        { $limit: 30 },
      ]),
      SalesEntry.aggregate([
        { $match: { isDeleted: false } },
        {
          $group: {
            _id: { $substr: ['$entryDateIST', 0, 7] },
            salesPaise: { $sum: '$amountPaise' },
            entries: { $sum: 1 },
          },
        },
        { $sort: { _id: -1 } },
        { $limit: 12 },
      ]),
      SalesEntry.aggregate([
        { $match: { cycleKey: currentBounds.cycleKey, isDeleted: false } },
        {
          $group: {
            _id: '$employeeId',
            cycleSalesPaise: { $sum: '$amountPaise' },
            entries: { $sum: 1 },
          },
        },
      ]),
      SalesEntry.aggregate([
        { $match: { entryDateIST: ist.dateStr, isDeleted: false } },
        { $group: { _id: '$employeeId', todaySalesPaise: { $sum: '$amountPaise' } } },
      ]),
      SalesEntry.aggregate([
        {
          $match: {
            entryDateIST: {
              $gte: currentMonthRange.startDateIST,
              $lte: currentMonthRange.endDateIST,
            },
            isDeleted: false,
          },
        },
        { $group: { _id: '$employeeId', monthSalesPaise: { $sum: '$amountPaise' } } },
      ]),
      Notification.countDocuments({ recipientRole: 'admin', isRead: false }),
    ]);

    const cycleSalesMap = new Map<string, { cycleSalesPaise: number; entries: number }>();
    employeeCycleSalesAgg.forEach((row) => {
      cycleSalesMap.set(String(row._id), {
        cycleSalesPaise: row.cycleSalesPaise,
        entries: row.entries,
      });
    });

    const empTodayMap = new Map<string, number>();
    employeeTodayAgg.forEach((row) => empTodayMap.set(String(row._id), row.todaySalesPaise));

    const empMonthMap = new Map<string, number>();
    employeeMonthAgg.forEach((row) => empMonthMap.set(String(row._id), row.monthSalesPaise));

    const activeCycles = await TargetCycle.find({
      status: 'active',
    }).lean();
    const cycleTargetMap = new Map<string, number>();
    const activeCycleSalesMap = new Map<string, number>();
    activeCycles.forEach((c) => {
      cycleTargetMap.set(String(c.employeeId), c.currentTargetPaise);
      activeCycleSalesMap.set(String(c.employeeId), c.totalSalesPaise);
    });

    const targetConfig = await getOrCreateTargetConfig();
    const defaultTargetPaise = targetConfig.initialTargetPaise || 50000000;

    let lifetimeSalesPaise = 0;
    let totalCommissionPaise = 0;
    let totalIncentivesPaise = 0;
    let totalAvailableBalancePaise = 0;

    const employeeChartRows = employees.map((emp) => {
      const avail = computeAvailableBalancePaise(emp);
      lifetimeSalesPaise += emp.lifetimeSalesPaise;
      totalCommissionPaise += emp.totalCommissionPaise;
      totalIncentivesPaise += emp.totalIncentivesPaise;
      totalAvailableBalancePaise += avail;

      const uid = String(emp.userId);
      const cData = cycleSalesMap.get(uid) || { cycleSalesPaise: 0, entries: 0 };
      const empCycleSales = activeCycleSalesMap.has(uid)
        ? activeCycleSalesMap.get(uid)!
        : cData.cycleSalesPaise;
      const targetPaise = cycleTargetMap.get(uid) || emp.customTargetAmountPaise || defaultTargetPaise;
      const pct = targetPaise > 0 ? Math.min(100, Math.round((empCycleSales / targetPaise) * 100)) : 0;

      return {
        employeeId: uid,
        employeeCode: emp.employeeCode,
        fullName: emp.fullName,
        isActive: emp.isActive,
        todaySalesPaise: empTodayMap.get(uid) || 0,
        monthSalesPaise: empMonthMap.get(uid) || 0,
        cycleSalesPaise: cData.cycleSalesPaise,
        lifetimeSalesPaise: emp.lifetimeSalesPaise,
        totalCommissionPaise: emp.totalCommissionPaise,
        totalIncentivesPaise: emp.totalIncentivesPaise,
        availableBalancePaise: avail,
        targetPaise,
        remainingPaise: Math.max(0, targetPaise - cData.cycleSalesPaise),
        achievementPercent: pct,
        entries: cData.entries,
      };
    });

    const topPerformers = [...employeeChartRows]
      .sort((a, b) => b.cycleSalesPaise - a.cycleSalesPaise)
      .slice(0, 5);

    res.json({
      currentCycleLabel: currentBounds.label,
      currentCycleKey: currentBounds.cycleKey,
      summary: {
        totalEmployees: employees.length,
        activeEmployees: employees.filter((e) => e.isActive).length,
        todaySalesPaise: todayAgg[0]?.total || 0,
        todayEntriesCount: todayAgg[0]?.count || 0,
        currentMonthSalesPaise: monthAgg[0]?.total || 0,
        currentCycleSalesPaise: cycleAgg[0]?.total || 0,
        lifetimeSalesPaise,
        totalCommissionPaise,
        totalIncentivesPaise,
        pendingWithdrawalsPaise: withdrawalsPendingAgg[0]?.total || 0,
        pendingWithdrawalsCount: withdrawalsPendingAgg[0]?.count || 0,
        completedWithdrawalsPaise: withdrawalsPaidAgg[0]?.total || 0,
        completedWithdrawalsCount: withdrawalsPaidAgg[0]?.count || 0,
        totalOutstandingEarningsPaise: totalAvailableBalancePaise,
      },
      charts: {
        dailySales: [...dailyAgg].reverse().map((d) => ({
          date: d._id,
          salesRupees: d.salesPaise / 100,
          entries: d.entries,
        })),
        monthlySales: [...monthlyAgg].reverse().map((m) => ({
          month: m._id,
          salesRupees: m.salesPaise / 100,
          entries: m.entries,
        })),
        employeeSales: employeeChartRows.map((e) => ({
          name: e.fullName.split(' ')[0] + ` (${e.employeeCode})`,
          fullName: e.fullName,
          cycleSalesRupees: e.cycleSalesPaise / 100,
          lifetimeSalesRupees: e.lifetimeSalesPaise / 100,
        })),
        targetAchievement: employeeChartRows.map((e) => ({
          name: e.fullName.split(' ')[0],
          fullName: e.fullName,
          achievedRupees: e.cycleSalesPaise / 100,
          remainingRupees: e.remainingPaise / 100,
          achievementPercent: e.achievementPercent,
        })),
      },
      topPerformers,
      employeeQuickList: employeeChartRows,
      unreadNotifications,
    });
  } catch (err) {
    next(err);
  }
});

// 2. EMPLOYEE MANAGEMENT CRUD
router.get('/employees', async (req: AuthRequest, res: Response, next) => {
  try {
    const now = new Date();
    const ist = getISTParts(now);
    const settings = await getOrCreateSystemSettings();
    const bounds = getCycleBoundsForDate(now, settings.withdrawalDayOfMonth);
    const search = String(req.query.search || '').trim().toLowerCase();

    const profiles = await EmployeeProfile.find({ isDeleted: false })
      .sort({ createdAt: -1 })
      .lean();

    const userIds = profiles.map((p) => p.userId);
    const users = await User.find({ _id: { $in: userIds } })
      .select('username lastLoginAt')
      .lean();
    const userMap = new Map(users.map((u) => [String(u._id), u]));

    const [todayAgg, targetConfig] = await Promise.all([
      SalesEntry.aggregate([
        { $match: { entryDateIST: ist.dateStr, isDeleted: false } },
        { $group: { _id: '$employeeId', total: { $sum: '$amountPaise' } } },
      ]),
      getOrCreateTargetConfig(),
    ]);

    const defaultTargetPaise = targetConfig.initialTargetPaise || 50000000;
    const todayMap = new Map(todayAgg.map((r) => [String(r._id), r.total]));

    const activeCyclesList = await Promise.all(
      profiles.map((p) => ensureActiveCycleForEmployee(p.userId, p._id, null, now))
    );
    const activeCycleMap = new Map(activeCyclesList.map((c) => [String(c.employeeId), c]));

    let rows = profiles.map((p) => {
      const uid = String(p.userId);
      const u = userMap.get(uid);
      const c = activeCycleMap.get(uid);
      return {
        id: uid,
        profileId: String(p._id),
        employeeCode: p.employeeCode,
        username: u?.username || '',
        fullName: p.fullName,
        email: p.email,
        mobile: p.mobile,
        joiningDate: p.joiningDate,
        department: p.department,
        designation: p.designation,
        targetCycleDay: p.targetCycleDay || settings.withdrawalDayOfMonth || 20,
        cycleKey: c?.cycleKey || bounds.cycleKey,
        cycleLabel: c?.label || bounds.label,
        cycleStartDateIST: c?.startDateIST || bounds.startDateIST,
        cycleEndDateIST: c?.endDateIST || bounds.endDateIST,
        cycleTargetPaise: c?.initialTargetPaise || p.customTargetAmountPaise || defaultTargetPaise,
        todaySalesPaise: todayMap.get(uid) || 0,
        currentCycleSalesPaise: c?.totalSalesPaise || 0,
        lifetimeSalesPaise: p.lifetimeSalesPaise,
        totalCommissionPaise: p.totalCommissionPaise,
        totalIncentivesPaise: p.totalIncentivesPaise,
        totalWithdrawnPaise: p.totalWithdrawnPaise,
        availableBalancePaise: computeAvailableBalancePaise(p),
        isActive: p.isActive,
      };
    });

    if (search) {
      rows = rows.filter(
        (r) =>
          r.fullName.toLowerCase().includes(search) ||
          r.employeeCode.toLowerCase().includes(search) ||
          r.username.toLowerCase().includes(search) ||
          r.email.toLowerCase().includes(search) ||
          r.mobile.includes(search)
      );
    }

    res.json({
      employees: rows,
      currentCycleLabel: bounds.label,
      defaultCycleDay: settings.withdrawalDayOfMonth || 20,
      defaultCycleStartDateIST: bounds.startDateIST,
      defaultCycleEndDateIST: bounds.endDateIST,
      defaultTargetRupees: defaultTargetPaise / 100,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/employees', async (req: AuthRequest, res: Response, next) => {
  try {
    const {
      employeeCode,
      fullName,
      username,
      email,
      mobile = '',
      joiningDate,
      password,
      department = 'Sales',
      designation = 'Sales Executive',
      upiId = '',
      targetCycleDay,
      cycleStartDate,
      cycleEndDate,
      targetAmountRupees,
    } = req.body;

    if (!username || !password) {
      res.status(400).json({
        error: 'Username and password are required.',
      });
      return;
    }

    if (String(password).length < 4) {
      res.status(400).json({ error: 'Password must be at least 4 characters.' });
      return;
    }

    const normalizedUsername = String(username).toLowerCase().trim();
    const displayName = (fullName && String(fullName).trim()) || String(username).trim();
    const normalizedEmail =
      (email && String(email).toLowerCase().trim()) ||
      `${normalizedUsername.replace(/[^a-z0-9._-]/g, '')}@commissiontracker.local`;

    let code = employeeCode && String(employeeCode).trim().toUpperCase();
    if (!code) {
      const count = await EmployeeProfile.countDocuments();
      code = `EMP-${1001 + count}`;
      while (await EmployeeProfile.exists({ employeeCode: code })) {
        code = `EMP-${Math.floor(1000 + Math.random() * 9000)}`;
      }
    }

    const existingUser = await User.findOne({
      $or: [{ username: normalizedUsername }, { email: normalizedEmail }],
    });
    if (existingUser) {
      res.status(409).json({ error: 'Username or email is already registered.' });
      return;
    }

    const existingCode = await EmployeeProfile.findOne({ employeeCode: code });
    if (existingCode) {
      res.status(409).json({ error: `Employee ID ${code} already exists.` });
      return;
    }

    const parsedCycleDay =
      targetCycleDay !== undefined && targetCycleDay !== ''
        ? Math.max(1, Math.min(28, Number(targetCycleDay)))
        : undefined;
    const parsedTargetPaise =
      targetAmountRupees !== undefined && targetAmountRupees !== '' && Number(targetAmountRupees) > 0
        ? rupeesToPaise(targetAmountRupees)
        : undefined;

    const passwordHash = await bcrypt.hash(String(password), 12);
    const user = await User.create({
      username: normalizedUsername,
      email: normalizedEmail,
      passwordHash,
      role: 'employee',
      fullName: displayName,
      isActive: true,
      isDeleted: false,
    });

    const istToday = getISTParts().dateStr;
    const profile = await EmployeeProfile.create({
      userId: user._id,
      employeeCode: code,
      fullName: displayName,
      email: normalizedEmail,
      mobile: String(mobile || '').trim(),
      joiningDate: joiningDate ? String(joiningDate) : istToday,
      department: String(department).trim(),
      designation: String(designation).trim(),
      upiId: String(upiId).trim(),
      targetCycleDay: parsedCycleDay,
      customTargetAmountPaise: parsedTargetPaise,
      isActive: true,
      isDeleted: false,
    });

    if (cycleStartDate && cycleEndDate) {
      await updateEmployeeTargetCycle({
        employeeId: user._id,
        targetCycleDay: parsedCycleDay,
        startDateIST: String(cycleStartDate),
        endDateIST: String(cycleEndDate),
        targetAmountPaise: parsedTargetPaise,
      });
    } else {
      await ensureActiveCycleForEmployee(user._id, profile._id);
    }

    await createNotification({
      recipientRole: 'admin',
      type: 'EMPLOYEE_CREATED',
      title: 'New Employee Created',
      message: `${profile.fullName} (${profile.employeeCode}) account created.`,
      metadata: { employeeId: user._id.toString() },
    });

    await recordAuditLog({
      actorId: req.user!.userId,
      actorRole: 'admin',
      actorName: req.user!.fullName,
      action: 'EMPLOYEE_CREATED',
      entityType: 'EmployeeProfile',
      entityId: profile._id.toString(),
      afterState: {
        employeeCode: profile.employeeCode,
        fullName: profile.fullName,
        email: profile.email,
      },
      ipAddress: req.ip,
    });

    res.status(201).json({
      employee: {
        id: user._id.toString(),
        employeeCode: profile.employeeCode,
        fullName: profile.fullName,
        email: profile.email,
        username: user.username,
      },
      message: 'Employee account created successfully.',
    });
  } catch (err) {
    next(err);
  }
});

router.put('/employees/:id', async (req: AuthRequest, res: Response, next) => {
  try {
    const { fullName, email, mobile, joiningDate, department, designation, upiId } = req.body;
    const user = await User.findOne({ _id: req.params.id, role: 'employee', isDeleted: false });
    const profile = await EmployeeProfile.findOne({ userId: req.params.id, isDeleted: false });
    if (!user || !profile) {
      res.status(404).json({ error: 'Employee not found' });
      return;
    }

    if (email && String(email).toLowerCase().trim() !== user.email) {
      const dup = await User.findOne({
        email: String(email).toLowerCase().trim(),
        _id: { $ne: user._id },
      });
      if (dup) {
        res.status(409).json({ error: 'Email is already in use by another account.' });
        return;
      }
      user.email = String(email).toLowerCase().trim();
      profile.email = user.email;
    }

    if (fullName) {
      user.fullName = String(fullName).trim();
      profile.fullName = user.fullName;
    }
    if (mobile !== undefined) profile.mobile = String(mobile).trim();
    if (joiningDate !== undefined) profile.joiningDate = String(joiningDate);
    if (department !== undefined) profile.department = String(department).trim();
    if (designation !== undefined) profile.designation = String(designation).trim();
    if (upiId !== undefined) profile.upiId = String(upiId).trim();

    await user.save();
    await profile.save();

    await recordAuditLog({
      actorId: req.user!.userId,
      actorRole: 'admin',
      actorName: req.user!.fullName,
      action: 'EMPLOYEE_UPDATED',
      entityType: 'EmployeeProfile',
      entityId: profile._id.toString(),
      afterState: { fullName: profile.fullName, email: profile.email, mobile: profile.mobile },
      ipAddress: req.ip,
    });

    res.json({ message: 'Employee details updated.' });
  } catch (err) {
    next(err);
  }
});

router.patch('/employees/:id/status', async (req: AuthRequest, res: Response, next) => {
  try {
    const { isActive } = req.body;
    const active = Boolean(isActive);

    const user = await User.findOne({ _id: req.params.id, role: 'employee', isDeleted: false });
    const profile = await EmployeeProfile.findOne({ userId: req.params.id, isDeleted: false });
    if (!user || !profile) {
      res.status(404).json({ error: 'Employee not found' });
      return;
    }

    user.isActive = active;
    profile.isActive = active;
    await user.save();
    await profile.save();

    await recordAuditLog({
      actorId: req.user!.userId,
      actorRole: 'admin',
      actorName: req.user!.fullName,
      action: active ? 'EMPLOYEE_ACTIVATED' : 'EMPLOYEE_DEACTIVATED',
      entityType: 'EmployeeProfile',
      entityId: profile._id.toString(),
      ipAddress: req.ip,
    });

    res.json({
      isActive: active,
      message: `Employee ${active ? 'activated' : 'deactivated'} successfully.`,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/employees/:id/reset-password', async (req: AuthRequest, res: Response, next) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || String(newPassword).length < 4) {
      res.status(400).json({ error: 'New password must be at least 4 characters.' });
      return;
    }

    const user = await User.findOne({ _id: req.params.id, role: 'employee', isDeleted: false });
    if (!user) {
      res.status(404).json({ error: 'Employee not found' });
      return;
    }

    user.passwordHash = await bcrypt.hash(String(newPassword), 12);
    await user.save();

    await recordAuditLog({
      actorId: req.user!.userId,
      actorRole: 'admin',
      actorName: req.user!.fullName,
      action: 'EMPLOYEE_PASSWORD_RESET',
      entityType: 'User',
      entityId: user._id.toString(),
      ipAddress: req.ip,
    });

    res.json({ message: 'Employee password reset successfully.' });
  } catch (err) {
    next(err);
  }
});

router.delete('/employees/:id', async (req: AuthRequest, res: Response, next) => {
  try {
    const user = await User.findOne({ _id: req.params.id, role: 'employee', isDeleted: false });
    const profile = await EmployeeProfile.findOne({ userId: req.params.id, isDeleted: false });
    if (!user || !profile) {
      res.status(404).json({ error: 'Employee not found' });
      return;
    }

    user.isDeleted = true;
    user.isActive = false;
    profile.isDeleted = true;
    profile.isActive = false;
    profile.deletedAt = new Date();
    await user.save();
    await profile.save();

    await recordAuditLog({
      actorId: req.user!.userId,
      actorRole: 'admin',
      actorName: req.user!.fullName,
      action: 'EMPLOYEE_SOFT_DELETED',
      entityType: 'EmployeeProfile',
      entityId: profile._id.toString(),
      ipAddress: req.ip,
    });

    res.json({ message: 'Employee soft-deleted. Historical records preserved.' });
  } catch (err) {
    next(err);
  }
});

router.put('/employees/:id/target-cycle', async (req: AuthRequest, res: Response, next) => {
  try {
    const {
      targetCycleDay,
      startDateIST,
      endDateIST,
      targetAmountRupees,
      completeCurrentCycle,
    } = req.body;

    const updatedCycle = await updateEmployeeTargetCycle({
      employeeId: req.params.id,
      targetCycleDay:
        targetCycleDay !== undefined && targetCycleDay !== '' ? Number(targetCycleDay) : undefined,
      startDateIST: startDateIST ? String(startDateIST) : undefined,
      endDateIST: endDateIST ? String(endDateIST) : undefined,
      targetAmountPaise:
        targetAmountRupees !== undefined && targetAmountRupees !== '' && Number(targetAmountRupees) > 0
          ? rupeesToPaise(targetAmountRupees)
          : undefined,
      completeCurrentCycle: Boolean(completeCurrentCycle),
    });

    await recordAuditLog({
      actorId: req.user!.userId,
      actorRole: 'admin',
      actorName: req.user!.fullName,
      action: completeCurrentCycle ? 'EMPLOYEE_CYCLE_COMPLETED' : 'EMPLOYEE_CYCLE_UPDATED',
      entityType: 'TargetCycle',
      entityId: updatedCycle._id.toString(),
      afterState: {
        cycleKey: updatedCycle.cycleKey,
        startDateIST: updatedCycle.startDateIST,
        endDateIST: updatedCycle.endDateIST,
        initialTargetPaise: updatedCycle.initialTargetPaise,
      },
      ipAddress: req.ip,
    });

    res.json({
      cycle: updatedCycle,
      message: completeCurrentCycle
        ? 'Current cycle completed and new cycle started.'
        : 'Employee target cycle updated.',
    });
  } catch (err) {
    next(err);
  }
});

router.delete('/employees/:id/data', async (req: AuthRequest, res: Response, next) => {
  try {
    const alsoDeleteAccount =
      req.body?.alsoDeleteAccount === true || req.query.alsoDeleteAccount === 'true';

    const result = await clearAllEmployeeData({
      employeeId: req.params.id,
      adminId: req.user!.userId,
      adminName: req.user!.fullName,
      alsoDeleteAccount,
      ipAddress: req.ip,
    });

    res.json({
      ...result,
      message: `All data for ${result.fullName} (${result.employeeCode}) has been deleted.`,
    });
  } catch (err) {
    next(err);
  }
});

// 3. INDIVIDUAL EMPLOYEE DETAILS & EXPORT
router.get('/employees/:id/details', async (req: AuthRequest, res: Response, next) => {
  try {
    const empObjectId = new mongoose.Types.ObjectId(req.params.id);
    const profile = await EmployeeProfile.findOne({ userId: empObjectId, isDeleted: false }).lean();
    if (!profile) {
      res.status(404).json({ error: 'Employee not found' });
      return;
    }

    const now = new Date();
    const ist = getISTParts(now);
    const settings = await getOrCreateSystemSettings();
    const cycle = await ensureActiveCycleForEmployee(empObjectId, profile._id, null, now);
    const targetProgress = computeTargetProgress(cycle, now);
    const monthRange = getCalendarMonthRangeIST(now, 0);

    const { preset = 'lifetime', startDate, endDate } = req.query;
    const range = resolveDateRangeFromPreset(
      String(preset),
      startDate ? String(startDate) : undefined,
      endDate ? String(endDate) : undefined,
      settings.withdrawalDayOfMonth
    );

    const salesFilter: Record<string, unknown> = {
      employeeId: empObjectId,
      isDeleted: false,
    };
    if (range.cycleKey) {
      salesFilter.cycleKey = range.cycleKey;
    } else if (range.startDateIST || range.endDateIST) {
      const dq: Record<string, string> = {};
      if (range.startDateIST) dq.$gte = range.startDateIST;
      if (range.endDateIST) dq.$lte = range.endDateIST;
      salesFilter.entryDateIST = dq;
    }

    const [
      todayAgg,
      monthAgg,
      salesHistory,
      filteredSalesAgg,
      commissionHistory,
      incentiveHistory,
      withdrawalHistory,
      achievements,
    ] = await Promise.all([
      SalesEntry.aggregate([
        { $match: { employeeId: empObjectId, entryDateIST: ist.dateStr, isDeleted: false } },
        { $group: { _id: null, total: { $sum: '$amountPaise' } } },
      ]),
      SalesEntry.aggregate([
        {
          $match: {
            employeeId: empObjectId,
            entryDateIST: { $gte: monthRange.startDateIST, $lte: monthRange.endDateIST },
            isDeleted: false,
          },
        },
        { $group: { _id: null, total: { $sum: '$amountPaise' } } },
      ]),
      SalesEntry.find(salesFilter).sort({ entryTimestamp: -1 }).limit(250).lean(),
      SalesEntry.aggregate([
        { $match: salesFilter },
        { $group: { _id: null, total: { $sum: '$amountPaise' }, count: { $sum: 1 } } },
      ]),
      CommissionTransaction.find({ employeeId: empObjectId })
        .sort({ createdAt: -1 })
        .limit(100)
        .lean(),
      IncentiveTransaction.find({ employeeId: empObjectId })
        .sort({ createdAt: -1 })
        .limit(100)
        .lean(),
      Withdrawal.find({ employeeId: empObjectId }).sort({ requestedAt: -1 }).limit(100).lean(),
      TargetAchievement.find({ employeeId: empObjectId }).sort({ achievedAt: -1 }).lean(),
    ]);

    res.json({
      employee: {
        ...profile,
        userId: String(profile.userId),
        availableBalancePaise: computeAvailableBalancePaise(profile),
      },
      metrics: {
        todaySalesPaise: todayAgg[0]?.total || 0,
        monthlySalesPaise: monthAgg[0]?.total || 0,
        currentCycleSalesPaise: cycle.totalSalesPaise,
        lifetimeSalesPaise: profile.lifetimeSalesPaise,
        filteredSalesPaise: filteredSalesAgg[0]?.total || 0,
        filteredEntriesCount: filteredSalesAgg[0]?.count || 0,
      },
      currentCycle: cycle,
      targetProgress,
      salesHistory,
      commissionHistory,
      incentiveHistory,
      withdrawalHistory,
      achievements,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/employees/:id/export', async (req: AuthRequest, res: Response, next) => {
  try {
    const empObjectId = new mongoose.Types.ObjectId(req.params.id);
    const profile = await EmployeeProfile.findOne({ userId: empObjectId, isDeleted: false }).lean();
    if (!profile) {
      res.status(404).json({ error: 'Employee not found' });
      return;
    }

    const settings = await getOrCreateSystemSettings();
    const { preset = 'lifetime', startDate, endDate } = req.query;
    const range = resolveDateRangeFromPreset(
      String(preset),
      startDate ? String(startDate) : undefined,
      endDate ? String(endDate) : undefined,
      settings.withdrawalDayOfMonth
    );

    const salesFilter: Record<string, unknown> = {
      employeeId: empObjectId,
      isDeleted: false,
    };
    if (range.cycleKey) {
      salesFilter.cycleKey = range.cycleKey;
    } else if (range.startDateIST || range.endDateIST) {
      const dq: Record<string, string> = {};
      if (range.startDateIST) dq.$gte = range.startDateIST;
      if (range.endDateIST) dq.$lte = range.endDateIST;
      salesFilter.entryDateIST = dq;
    }

    const [entries, commissions, incentives, withdrawals, achievements] = await Promise.all([
      SalesEntry.find(salesFilter).sort({ entryTimestamp: -1 }).lean(),
      CommissionTransaction.find({ employeeId: empObjectId }).sort({ createdAt: -1 }).lean(),
      IncentiveTransaction.find({ employeeId: empObjectId }).sort({ createdAt: -1 }).lean(),
      Withdrawal.find({ employeeId: empObjectId }).sort({ requestedAt: -1 }).lean(),
      TargetAchievement.find({ employeeId: empObjectId }).sort({ achievedAt: -1 }).lean(),
    ]);

    const buffer = await buildIndividualEmployeeWorkbook({
      employee: {
        employeeCode: profile.employeeCode,
        fullName: profile.fullName,
        email: profile.email,
        mobile: profile.mobile,
        joiningDate: profile.joiningDate,
        lifetimeSalesPaise: profile.lifetimeSalesPaise,
        totalCommissionPaise: profile.totalCommissionPaise,
        totalIncentivesPaise: profile.totalIncentivesPaise,
        totalWithdrawnPaise: profile.totalWithdrawnPaise,
        availableBalancePaise: computeAvailableBalancePaise(profile),
      },
      entries,
      commissions,
      incentives,
      withdrawals,
      achievements,
    });

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${profile.employeeCode}-report.xlsx"`
    );
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

// 4. ALL EMPLOYEES DATA & 7-SHEET EXCEL EXPORT
async function buildAllEmployeesDataPayload(query: Record<string, unknown>, ignoreFilters = false) {
  const now = new Date();
  const ist = getISTParts(now);
  const yesterdayIST = getYesterdayISTDateStr(now);
  const currentMonthRange = getCalendarMonthRangeIST(now, 0);
  const prevMonthRange = getCalendarMonthRangeIST(now, -1);
  const settings = await getOrCreateSystemSettings();
  const currentBounds = getCycleBoundsForDate(now, settings.withdrawalDayOfMonth);
  const targetConfig = await getOrCreateTargetConfig();
  const defaultTargetPaise = targetConfig.initialTargetPaise || 50000000;

  let profiles = await EmployeeProfile.find({ isDeleted: false }).sort({ employeeCode: 1 }).lean();

  const quickFilter = !ignoreFilters && query.quickFilter ? String(query.quickFilter) : undefined;
  const startDate = !ignoreFilters && query.startDate ? String(query.startDate) : undefined;
  const endDate = !ignoreFilters && query.endDate ? String(query.endDate) : undefined;
  const employeeName = !ignoreFilters && query.employeeName ? String(query.employeeName).trim() : '';
  const employeeCode = !ignoreFilters && query.employeeCode ? String(query.employeeCode).trim() : '';
  const productName = !ignoreFilters && query.productName ? String(query.productName).trim() : '';
  const cycleKey = !ignoreFilters && query.cycleKey ? String(query.cycleKey).trim() : '';
  const salesStatus = !ignoreFilters && query.salesStatus ? String(query.salesStatus).trim() : '';

  if (employeeName) {
    const q = employeeName.toLowerCase();
    profiles = profiles.filter((p) => p.fullName.toLowerCase().includes(q));
  }
  if (employeeCode) {
    const q = employeeCode.toLowerCase();
    profiles = profiles.filter((p) => p.employeeCode.toLowerCase().includes(q));
  }

  const employeeUserIds = profiles.map((p) => p.userId);

  // Build sales filter for filtered metrics & sheet 2/3/4
  const salesMatch: Record<string, unknown> = {
    employeeId: { $in: employeeUserIds },
  };
  if (salesStatus === 'deleted') {
    salesMatch.isDeleted = true;
  } else if (salesStatus === 'active' || salesStatus === 'edited') {
    salesMatch.isDeleted = false;
    salesMatch.status = salesStatus;
  } else {
    salesMatch.isDeleted = false;
  }

  if (productName) {
    salesMatch.productName = new RegExp(escapeRegex(productName), 'i');
  }

  const resolvedRange = resolveDateRangeFromPreset(
    quickFilter,
    startDate,
    endDate,
    settings.withdrawalDayOfMonth
  );
  if (cycleKey) {
    salesMatch.cycleKey = cycleKey;
  } else if (resolvedRange.cycleKey) {
    salesMatch.cycleKey = resolvedRange.cycleKey;
  } else if (resolvedRange.startDateIST || resolvedRange.endDateIST) {
    const dq: Record<string, string> = {};
    if (resolvedRange.startDateIST) dq.$gte = resolvedRange.startDateIST;
    if (resolvedRange.endDateIST) dq.$lte = resolvedRange.endDateIST;
    salesMatch.entryDateIST = dq;
  }

  const [
    filteredEntries,
    allActiveEntriesAgg,
    todayAgg,
    yesterdayAgg,
    curMonthAgg,
    prevMonthAgg,
    curCycleAgg,
    activeCycles,
    incentives,
    withdrawals,
    achievements,
    distinctCycles,
  ] = await Promise.all([
    SalesEntry.find(salesMatch).sort({ entryTimestamp: -1 }).lean(),
    SalesEntry.aggregate([
      { $match: salesMatch },
      {
        $group: {
          _id: '$employeeId',
          count: { $sum: 1 },
          filteredSalesPaise: { $sum: '$amountPaise' },
        },
      },
    ]),
    SalesEntry.aggregate([
      { $match: { employeeId: { $in: employeeUserIds }, entryDateIST: ist.dateStr, isDeleted: false } },
      { $group: { _id: '$employeeId', total: { $sum: '$amountPaise' } } },
    ]),
    SalesEntry.aggregate([
      { $match: { employeeId: { $in: employeeUserIds }, entryDateIST: yesterdayIST, isDeleted: false } },
      { $group: { _id: '$employeeId', total: { $sum: '$amountPaise' } } },
    ]),
    SalesEntry.aggregate([
      {
        $match: {
          employeeId: { $in: employeeUserIds },
          entryDateIST: { $gte: currentMonthRange.startDateIST, $lte: currentMonthRange.endDateIST },
          isDeleted: false,
        },
      },
      { $group: { _id: '$employeeId', total: { $sum: '$amountPaise' } } },
    ]),
    SalesEntry.aggregate([
      {
        $match: {
          employeeId: { $in: employeeUserIds },
          entryDateIST: { $gte: prevMonthRange.startDateIST, $lte: prevMonthRange.endDateIST },
          isDeleted: false,
        },
      },
      { $group: { _id: '$employeeId', total: { $sum: '$amountPaise' } } },
    ]),
    SalesEntry.aggregate([
      { $match: { employeeId: { $in: employeeUserIds }, cycleKey: currentBounds.cycleKey, isDeleted: false } },
      { $group: { _id: '$employeeId', total: { $sum: '$amountPaise' } } },
    ]),
    TargetCycle.find({ employeeId: { $in: employeeUserIds }, cycleKey: currentBounds.cycleKey }).lean(),
    IncentiveTransaction.find({ employeeId: { $in: employeeUserIds } }).lean(),
    Withdrawal.find({ employeeId: { $in: employeeUserIds } }).sort({ requestedAt: -1 }).lean(),
    TargetAchievement.find({ employeeId: { $in: employeeUserIds } }).sort({ achievedAt: -1 }).lean(),
    TargetCycle.distinct('cycleKey'),
  ]);

  const toMap = (arr: Array<{ _id: unknown; total?: number; count?: number; filteredSalesPaise?: number }>) =>
    new Map(arr.map((r) => [String(r._id), r]));

  const filteredMap = toMap(allActiveEntriesAgg);
  const todayMap = toMap(todayAgg);
  const yesterdayMap = toMap(yesterdayAgg);
  const curMonthMap = toMap(curMonthAgg);
  const prevMonthMap = toMap(prevMonthAgg);
  const curCycleMap = toMap(curCycleAgg);
  const activeCycleDocMap = new Map(activeCycles.map((c) => [String(c.employeeId), c]));

  let companyFilteredSalesPaise = 0;
  let companyTodaySalesPaise = 0;
  let companyCurrentCycleSalesPaise = 0;
  let companyLifetimeSalesPaise = 0;
  let companyTotalCommissionPaise = 0;
  let companyTotalIncentivesPaise = 0;
  let companyTotalWithdrawalsPaise = 0;
  let companyTotalOutstandingPaise = 0;

  const employeeRows = profiles.map((p) => {
    const uid = String(p.userId);
    const fData = filteredMap.get(uid);
    const todaySalesPaise = todayMap.get(uid)?.total || 0;
    const yesterdaySalesPaise = yesterdayMap.get(uid)?.total || 0;
    const currentMonthSalesPaise = curMonthMap.get(uid)?.total || 0;
    const previousMonthSalesPaise = prevMonthMap.get(uid)?.total || 0;
    const currentCycleSalesPaise = curCycleMap.get(uid)?.total || 0;
    const cycleDoc = activeCycleDocMap.get(uid);
    const currentTargetPaise = cycleDoc?.currentTargetPaise || defaultTargetPaise;
    const targetAchievementPercent =
      currentTargetPaise > 0
        ? Math.min(100, Math.round((currentCycleSalesPaise / currentTargetPaise) * 1000) / 10)
        : 0;
    const totalEarningsPaise = p.totalCommissionPaise + p.totalIncentivesPaise;
    const availableBalancePaise = computeAvailableBalancePaise(p);

    companyFilteredSalesPaise += fData?.filteredSalesPaise || 0;
    companyTodaySalesPaise += todaySalesPaise;
    companyCurrentCycleSalesPaise += currentCycleSalesPaise;
    companyLifetimeSalesPaise += p.lifetimeSalesPaise;
    companyTotalCommissionPaise += p.totalCommissionPaise;
    companyTotalIncentivesPaise += p.totalIncentivesPaise;
    companyTotalWithdrawalsPaise += p.totalWithdrawnPaise;
    companyTotalOutstandingPaise += availableBalancePaise;

    return {
      employeeId: uid,
      employeeCode: p.employeeCode,
      fullName: p.fullName,
      isActive: p.isActive,
      totalEntries: fData?.count || 0,
      filteredSalesPaise: fData?.filteredSalesPaise || 0,
      todaySalesPaise,
      yesterdaySalesPaise,
      currentMonthSalesPaise,
      previousMonthSalesPaise,
      currentCycleSalesPaise,
      lifetimeSalesPaise: p.lifetimeSalesPaise,
      commissionEarnedPaise: p.totalCommissionPaise,
      incentivesEarnedPaise: p.totalIncentivesPaise,
      totalEarningsPaise,
      withdrawnAmountPaise: p.totalWithdrawnPaise,
      availableBalancePaise,
      currentTargetPaise,
      targetAchievementPercent,
    };
  });

  // Daily & Monthly aggregates from filteredEntries
  const dailyBucket = new Map<string, { entryCount: number; totalSalesPaise: number; totalCommissionPaise: number }>();
  const monthlyBucket = new Map<string, { entryCount: number; totalSalesPaise: number; totalCommissionPaise: number }>();

  for (const e of filteredEntries) {
    const d = dailyBucket.get(e.entryDateIST) || {
      entryCount: 0,
      totalSalesPaise: 0,
      totalCommissionPaise: 0,
    };
    d.entryCount += 1;
    d.totalSalesPaise += e.amountPaise;
    d.totalCommissionPaise += e.commissionPaise;
    dailyBucket.set(e.entryDateIST, d);

    const monthKey = e.entryDateIST.slice(0, 7);
    const m = monthlyBucket.get(monthKey) || {
      entryCount: 0,
      totalSalesPaise: 0,
      totalCommissionPaise: 0,
    };
    m.entryCount += 1;
    m.totalSalesPaise += e.amountPaise;
    m.totalCommissionPaise += e.commissionPaise;
    monthlyBucket.set(monthKey, m);
  }

  const dailySummaries = Array.from(dailyBucket.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, v]) => ({ date, ...v }));

  const monthlySummaries = Array.from(monthlyBucket.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([month, v]) => ({ month, ...v }));

  const incentiveByEmployee = new Map<string, { target: number; other: number }>();
  for (const inc of incentives) {
    const uid = String(inc.employeeId);
    const curr = incentiveByEmployee.get(uid) || { target: 0, other: 0 };
    if (inc.category === 'target_completion') curr.target += inc.amountPaise;
    else curr.other += inc.amountPaise;
    incentiveByEmployee.set(uid, curr);
  }

  const commissionAndIncentives = profiles.map((p) => {
    const inc = incentiveByEmployee.get(String(p.userId)) || { target: 0, other: 0 };
    return {
      employeeCode: p.employeeCode,
      employeeName: p.fullName,
      salesCommissionPaise: p.totalCommissionPaise,
      targetIncentivesPaise: inc.target,
      otherIncentivesPaise: inc.other,
      totalIncentivesPaise: p.totalIncentivesPaise,
      totalEarningsPaise: p.totalCommissionPaise + p.totalIncentivesPaise,
    };
  });

  return {
    companySummary: {
      totalCompanySalesPaise: companyFilteredSalesPaise,
      todayCompanySalesPaise: companyTodaySalesPaise,
      currentCycleCompanySalesPaise: companyCurrentCycleSalesPaise,
      lifetimeCompanySalesPaise: companyLifetimeSalesPaise,
      totalCommissionLiabilityPaise: companyTotalCommissionPaise,
      totalIncentivesPaise: companyTotalIncentivesPaise,
      totalWithdrawalsPaise: companyTotalWithdrawalsPaise,
      totalOutstandingEarningsPaise: companyTotalOutstandingPaise,
    },
    employeeRows,
    salesEntries: filteredEntries,
    dailySummaries,
    monthlySummaries,
    commissionAndIncentives,
    withdrawals: withdrawals.map((w) => ({
      requestDateIST: w.requestDateIST,
      employeeCode: w.employeeCode,
      employeeName: w.employeeName,
      amountPaise: w.amountPaise,
      status: w.status,
      paymentMethod: w.paymentMethod || '',
      paymentReference: w.paymentReference || '',
      rejectionReason: w.rejectionReason || '',
    })),
    achievements: achievements.map((a) => ({
      employeeCode: a.employeeCode,
      employeeName: a.employeeName,
      cycleKey: a.cycleKey,
      milestoneLabel: a.milestoneLabel,
      milestoneAmountPaise: a.milestoneAmountPaise,
      achievedAtSalesPaise: a.achievedAtSalesPaise,
      achievedDate: new Date(a.achievedAt).toISOString().slice(0, 10),
      incentiveGranted: a.incentiveGranted,
    })),
    availableCycles: Array.from(new Set([currentBounds.cycleKey, ...distinctCycles])).sort().reverse(),
  };
}

router.get('/all-employees-data', async (req: AuthRequest, res: Response, next) => {
  try {
    const payload = await buildAllEmployeesDataPayload(req.query as Record<string, unknown>, false);
    res.json({
      companySummary: payload.companySummary,
      employeeRows: payload.employeeRows,
      availableCycles: payload.availableCycles,
      totalFilteredEntries: payload.salesEntries.length,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/all-employees-data/export', async (req: AuthRequest, res: Response, next) => {
  try {
    const mode = String(req.query.mode || 'filtered');
    const ignoreFilters = mode === 'all';
    const payload = await buildAllEmployeesDataPayload(
      req.query as Record<string, unknown>,
      ignoreFilters
    );

    const buffer = await buildAllEmployeesCompanyWorkbook({
      employeeSummaries: payload.employeeRows,
      salesEntries: payload.salesEntries,
      dailySummaries: payload.dailySummaries,
      monthlySummaries: payload.monthlySummaries,
      commissionAndIncentives: payload.commissionAndIncentives,
      withdrawals: payload.withdrawals,
      achievements: payload.achievements,
    });

    const today = getISTParts().dateStr;
    const filename = ignoreFilters
      ? `all-employees-complete-data-${today}.xlsx`
      : `all-employees-filtered-data-${today}.xlsx`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

// 5. SALES REPORTS & ADMIN ENTRY EDIT/DELETE
router.get('/sales-reports', async (req: AuthRequest, res: Response, next) => {
  try {
    const { employeeId, startDate, endDate, productName, orderName, page = '1', limit = '25' } =
      req.query;

    const filter: Record<string, unknown> = { isDeleted: false };
    if (employeeId && String(employeeId) !== 'all') {
      filter.employeeId = new mongoose.Types.ObjectId(String(employeeId));
    }
    if (startDate || endDate) {
      const dq: Record<string, string> = {};
      if (startDate) dq.$gte = String(startDate);
      if (endDate) dq.$lte = String(endDate);
      filter.entryDateIST = dq;
    }
    if (productName && String(productName).trim()) {
      filter.productName = new RegExp(escapeRegex(String(productName).trim()), 'i');
    }
    if (orderName && String(orderName).trim()) {
      filter.orderName = new RegExp(escapeRegex(String(orderName).trim()), 'i');
    }

    const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(String(limit), 10) || 25));
    const skip = (pageNum - 1) * limitNum;

    const [entries, totalCount, summaryAgg, employeeTotals, dailyTotals, monthlyTotals, employees] =
      await Promise.all([
        SalesEntry.find(filter).sort({ entryTimestamp: -1 }).skip(skip).limit(limitNum).lean(),
        SalesEntry.countDocuments(filter),
        SalesEntry.aggregate([
          { $match: filter },
          {
            $group: {
              _id: null,
              totalSalesPaise: { $sum: '$amountPaise' },
              totalCommissionPaise: { $sum: '$commissionPaise' },
              avgSalePaise: { $avg: '$amountPaise' },
            },
          },
        ]),
        SalesEntry.aggregate([
          { $match: filter },
          {
            $group: {
              _id: '$employeeId',
              employeeCode: { $first: '$employeeCode' },
              employeeName: { $first: '$employeeName' },
              entries: { $sum: 1 },
              totalSalesPaise: { $sum: '$amountPaise' },
            },
          },
          { $sort: { totalSalesPaise: -1 } },
        ]),
        SalesEntry.aggregate([
          { $match: filter },
          {
            $group: {
              _id: '$entryDateIST',
              entries: { $sum: 1 },
              totalSalesPaise: { $sum: '$amountPaise' },
            },
          },
          { $sort: { _id: -1 } },
          { $limit: 30 },
        ]),
        SalesEntry.aggregate([
          { $match: filter },
          {
            $group: {
              _id: { $substr: ['$entryDateIST', 0, 7] },
              entries: { $sum: 1 },
              totalSalesPaise: { $sum: '$amountPaise' },
            },
          },
          { $sort: { _id: -1 } },
        ]),
        EmployeeProfile.find({ isDeleted: false })
          .select('userId employeeCode fullName')
          .sort({ fullName: 1 })
          .lean(),
      ]);

    res.json({
      entries,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalCount,
        totalPages: Math.max(1, Math.ceil(totalCount / limitNum)),
      },
      summary: {
        totalEntries: totalCount,
        totalSalesPaise: summaryAgg[0]?.totalSalesPaise || 0,
        totalCommissionPaise: summaryAgg[0]?.totalCommissionPaise || 0,
        averageSalePaise: Math.round(summaryAgg[0]?.avgSalePaise || 0),
      },
      employeeTotals,
      dailyTotals,
      monthlyTotals,
      employees: employees.map((e) => ({
        id: String(e.userId),
        employeeCode: e.employeeCode,
        fullName: e.fullName,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/sales-reports/export', async (req: AuthRequest, res: Response, next) => {
  try {
    const { employeeId, startDate, endDate, productName, orderName } = req.query;
    const filter: Record<string, unknown> = { isDeleted: false };
    if (employeeId && String(employeeId) !== 'all') {
      filter.employeeId = new mongoose.Types.ObjectId(String(employeeId));
    }
    if (startDate || endDate) {
      const dq: Record<string, string> = {};
      if (startDate) dq.$gte = String(startDate);
      if (endDate) dq.$lte = String(endDate);
      filter.entryDateIST = dq;
    }
    if (productName && String(productName).trim()) {
      filter.productName = new RegExp(escapeRegex(String(productName).trim()), 'i');
    }
    if (orderName && String(orderName).trim()) {
      filter.orderName = new RegExp(escapeRegex(String(orderName).trim()), 'i');
    }

    const entries = await SalesEntry.find(filter).sort({ entryTimestamp: -1 }).lean();
    const buffer = await buildSalesEntriesWorkbook({
      title: 'Sales Report',
      entries,
      includeEmployeeColumns: true,
    });

    const today = getISTParts().dateStr;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', `attachment; filename="sales-report-${today}.xlsx"`);
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
      actorRole: 'admin',
      actorName: req.user!.fullName,
      orderName,
      productName,
      amountPaise,
      ipAddress: req.ip,
    });
    res.json({ entry: updated, message: 'Sales entry updated by Admin.' });
  } catch (err) {
    next(err);
  }
});

router.delete('/sales/:id', async (req: AuthRequest, res: Response, next) => {
  try {
    await deleteSalesEntry({
      entryId: req.params.id,
      actorId: req.user!.userId,
      actorRole: 'admin',
      actorName: req.user!.fullName,
      ipAddress: req.ip,
    });
    res.json({ message: 'Sales entry deleted by Admin.' });
  } catch (err) {
    next(err);
  }
});

router.post('/data/delete-selective', async (req: AuthRequest, res: Response, next) => {
  try {
    const {
      mode,
      employeeId,
      fromDate,
      toDate,
      alsoDeleteAccount = false,
      alsoDeleteEmployeeAccounts = false,
    } = req.body;

    if (!mode || !['date_range', 'employee', 'all_data'].includes(String(mode))) {
      res.status(400).json({ error: 'Invalid deletion mode.' });
      return;
    }

    const result = await deleteDataSelectively({
      mode: mode as 'date_range' | 'employee' | 'all_data',
      employeeId: employeeId ? String(employeeId) : undefined,
      fromDate: fromDate ? String(fromDate) : undefined,
      toDate: toDate ? String(toDate) : undefined,
      alsoDeleteAccount: Boolean(alsoDeleteAccount),
      alsoDeleteEmployeeAccounts: Boolean(alsoDeleteEmployeeAccounts),
      adminId: req.user!.userId,
      adminName: req.user!.fullName,
      ipAddress: req.ip,
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// 6. WITHDRAWALS MANAGEMENT & PAYOUT APPROVAL
router.get('/withdrawals', async (req: AuthRequest, res: Response, next) => {
  try {
    const now = new Date();
    const settings = await getOrCreateSystemSettings();
    const currentBounds = getCycleBoundsForDate(now, settings.withdrawalDayOfMonth);

    const { cycleKey = 'active', employeeId = 'all', status = 'all' } = req.query;
    const isActiveScope = !cycleKey || String(cycleKey) === 'active';

    const reqFilter: Record<string, unknown> = {};
    if (employeeId && String(employeeId) !== 'all') {
      reqFilter.employeeId = new mongoose.Types.ObjectId(String(employeeId));
    }
    if (status && String(status) !== 'all') {
      reqFilter.status = String(status);
    }

    const empFilter: Record<string, unknown> = { isDeleted: false };
    if (employeeId && String(employeeId) !== 'all') {
      empFilter.userId = new mongoose.Types.ObjectId(String(employeeId));
    }

    const [profiles, cycles, requests, distinctCycles] = await Promise.all([
      EmployeeProfile.find(empFilter).sort({ fullName: 1 }).lean(),
      isActiveScope
        ? TargetCycle.find({ status: 'active' }).lean()
        : TargetCycle.find({ cycleKey: String(cycleKey) }).lean(),
      Withdrawal.find(reqFilter).sort({ requestedAt: -1 }).limit(200).lean(),
      TargetCycle.distinct('cycleKey'),
    ]);

    const cycleIds = cycles.map((c) => c._id);
    const [incentives, achievements] = await Promise.all([
      isActiveScope
        ? IncentiveTransaction.find({ cycleId: { $in: cycleIds } }).lean()
        : IncentiveTransaction.find({ cycleKey: String(cycleKey) }).lean(),
      isActiveScope
        ? TargetAchievement.find({ cycleId: { $in: cycleIds } })
            .sort({ milestoneAmountPaise: 1 })
            .lean()
        : TargetAchievement.find({ cycleKey: String(cycleKey) })
            .sort({ milestoneAmountPaise: 1 })
            .lean(),
    ]);

    const cycleMap = new Map(cycles.map((c) => [String(c.employeeId), c]));
    const employeeRequestsMap = new Map<string, typeof requests>();
    requests.forEach((r) => {
      const uid = String(r.employeeId);
      const list = employeeRequestsMap.get(uid) || [];
      list.push(r);
      employeeRequestsMap.set(uid, list);
    });

    const summaryRows = profiles.map((p) => {
      const uid = String(p.userId);
      const cycle = cycleMap.get(uid);
      const empIncs = incentives.filter((i) => String(i.employeeId) === uid);
      const targetIncentivePaise = empIncs
        .filter((i) => i.category === 'target_completion')
        .reduce((a, b) => a + b.amountPaise, 0);
      const otherIncentivePaise = empIncs
        .filter((i) => i.category === 'other')
        .reduce((a, b) => a + b.amountPaise, 0);

      const empAchievements = achievements.filter((a) => String(a.employeeId) === uid);
      const latestAchievement = empAchievements[empAchievements.length - 1] || null;
      const unrewardedAchievements = empAchievements.filter((a) => !a.incentiveGranted);

      const empReqs = employeeRequestsMap.get(uid) || [];
      const latestReq = empReqs[0] || null;
      const totalEarningsPaise = p.totalCommissionPaise + p.totalIncentivesPaise;
      const availableBalancePaise = computeAvailableBalancePaise(p);

      return {
        employeeId: uid,
        employeeCode: p.employeeCode,
        fullName: p.fullName,
        upiId: p.upiId,
        cycleLabel: cycle?.label || currentBounds.label,
        monthlyCycleSalesPaise: cycle?.totalSalesPaise || 0,
        commissionEarnedPaise: p.totalCommissionPaise,
        cycleCommissionPaise: cycle?.totalCommissionPaise || 0,
        targetIncentivePaise,
        otherIncentivePaise,
        totalEarningsPaise,
        previouslyWithdrawnPaise: p.totalWithdrawnPaise,
        approvedUnpaidPaise: p.approvedUnpaidPaise,
        pendingWithdrawalPaise: p.pendingWithdrawalPaise,
        availableBalancePaise,
        isPaid: availableBalancePaise === 0 && totalEarningsPaise > 0,
        withdrawalStatus: latestReq ? latestReq.status : 'none',
        completedTargetsCount: empAchievements.length,
        latestAchievement,
        unrewardedAchievements,
      };
    });

    res.json({
      selectedCycleKey: String(cycleKey),
      currentCycleLabel: currentBounds.label,
      defaultTargetIncentivePaise: settings.defaultTargetIncentivePaise,
      availableCycles: Array.from(new Set([currentBounds.cycleKey, ...distinctCycles]))
        .sort()
        .reverse(),
      summaryRows,
      requests,
      employees: profiles.map((p) => ({
        id: String(p.userId),
        employeeCode: p.employeeCode,
        fullName: p.fullName,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/employees/:id/mark-paid', async (req: AuthRequest, res: Response, next) => {
  try {
    const { amount, note } = req.body;
    const amountPaise =
      amount !== undefined && amount !== '' && Number(amount) > 0 ? rupeesToPaise(amount) : undefined;

    const payout = await approveDirectPayout({
      employeeId: req.params.id,
      amountPaise,
      note: note ? String(note) : undefined,
      adminId: req.user!.userId,
      adminName: req.user!.fullName,
      ipAddress: req.ip,
    });

    res.status(201).json({
      payout,
      message: 'Payout approved and marked as Paid.',
    });
  } catch (err) {
    next(err);
  }
});

router.post('/withdrawals/:id/approve', async (req: AuthRequest, res: Response, next) => {
  try {
    const withdrawal = await approveWithdrawal({
      withdrawalId: req.params.id,
      adminId: req.user!.userId,
      adminName: req.user!.fullName,
      ipAddress: req.ip,
    });
    res.json({ withdrawal, message: 'Withdrawal approved. Ready for payment confirmation.' });
  } catch (err) {
    next(err);
  }
});

router.post('/withdrawals/:id/reject', async (req: AuthRequest, res: Response, next) => {
  try {
    const { reason } = req.body;
    const withdrawal = await rejectWithdrawal({
      withdrawalId: req.params.id,
      adminId: req.user!.userId,
      adminName: req.user!.fullName,
      reason: String(reason || ''),
      ipAddress: req.ip,
    });
    res.json({ withdrawal, message: 'Withdrawal rejected and locked balance released.' });
  } catch (err) {
    next(err);
  }
});

router.post('/withdrawals/:id/pay', async (req: AuthRequest, res: Response, next) => {
  try {
    const { paymentMethod, paymentReference, paymentNotes } = req.body;
    const withdrawal = await markWithdrawalPaid({
      withdrawalId: req.params.id,
      adminId: req.user!.userId,
      adminName: req.user!.fullName,
      paymentMethod: String(paymentMethod || 'Bank Transfer'),
      paymentReference: String(paymentReference || ''),
      paymentNotes: String(paymentNotes || ''),
      ipAddress: req.ip,
    });
    res.json({ withdrawal, message: 'Withdrawal marked as Paid.' });
  } catch (err) {
    next(err);
  }
});

// 7. TARGET MANAGEMENT
router.get('/targets', async (_req: AuthRequest, res: Response, next) => {
  try {
    const config = await getOrCreateTargetConfig();
    const achievements = await TargetAchievement.find().sort({ achievedAt: -1 }).limit(100).lean();
    res.json({ config, achievements });
  } catch (err) {
    next(err);
  }
});

router.put('/targets', async (req: AuthRequest, res: Response, next) => {
  try {
    const { milestones, initialTargetRupees, dailyCalculationMode } = req.body;
    if (!Array.isArray(milestones) || milestones.length === 0) {
      res.status(400).json({ error: 'At least one target milestone is required.' });
      return;
    }

    const parsedMilestones = milestones
      .map((m: { amountRupees: number; label: string; defaultIncentiveRupees?: number }, idx: number) => ({
        order: idx + 1,
        amountPaise: rupeesToPaise(m.amountRupees),
        label: String(m.label || `₹${(Number(m.amountRupees) / 100000).toFixed(1)} Lakh`).trim(),
        defaultIncentivePaise: rupeesToPaise(m.defaultIncentiveRupees ?? 500),
      }))
      .sort((a, b) => a.amountPaise - b.amountPaise)
      .map((m, idx) => ({ ...m, order: idx + 1 }));

    if (parsedMilestones.some((m) => m.amountPaise <= 0)) {
      res.status(400).json({ error: 'All target amounts must be greater than zero.' });
      return;
    }

    const initialTargetPaise = initialTargetRupees
      ? rupeesToPaise(initialTargetRupees)
      : parsedMilestones[0].amountPaise;

    const config = await getOrCreateTargetConfig();
    config.milestones = parsedMilestones;
    config.initialTargetPaise = initialTargetPaise;
    if (dailyCalculationMode === 'remaining_days' || dailyCalculationMode === 'inclusive_today') {
      config.dailyCalculationMode = dailyCalculationMode;
    }
    config.updatedBy = new mongoose.Types.ObjectId(req.user!.userId);
    await config.save();

    // Update ONLY currently active cycles (historical closed cycles remain untouched!)
    const activeCycles = await TargetCycle.find({ status: 'active' });
    for (const cycle of activeCycles) {
      cycle.milestonesSnapshot = parsedMilestones;
      cycle.initialTargetPaise = initialTargetPaise;
      const progress = computeTargetProgress(cycle);
      cycle.currentTargetPaise = progress.activeTargetPaise;
      await cycle.save();
    }

    await recordAuditLog({
      actorId: req.user!.userId,
      actorRole: 'admin',
      actorName: req.user!.fullName,
      action: 'TARGET_CONFIG_UPDATED',
      entityType: 'TargetConfiguration',
      entityId: config._id.toString(),
      afterState: {
        initialTargetPaise,
        milestoneCount: parsedMilestones.length,
      },
      ipAddress: req.ip,
    });

    res.json({
      config,
      message: 'Target milestones updated for active and future cycles (historical cycles preserved).',
    });
  } catch (err) {
    next(err);
  }
});

// 8. INCENTIVE MANAGEMENT
router.get('/incentives', async (_req: AuthRequest, res: Response, next) => {
  try {
    const [incentives, achievements, employees, settings] = await Promise.all([
      IncentiveTransaction.find().sort({ createdAt: -1 }).limit(150).lean(),
      TargetAchievement.find().sort({ achievedAt: -1 }).limit(100).lean(),
      EmployeeProfile.find({ isDeleted: false, isActive: true })
        .select('userId employeeCode fullName')
        .sort({ fullName: 1 })
        .lean(),
      getOrCreateSystemSettings(),
    ]);

    res.json({
      incentives,
      achievements,
      defaultTargetIncentivePaise: settings.defaultTargetIncentivePaise,
      employees: employees.map((e) => ({
        id: String(e.userId),
        employeeCode: e.employeeCode,
        fullName: e.fullName,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/incentives', async (req: AuthRequest, res: Response, next) => {
  try {
    const {
      employeeId,
      category = 'other',
      amount,
      reason,
      achievementId,
      allowDuplicateOverride = false,
    } = req.body;

    if (!employeeId || !amount || !reason) {
      res.status(400).json({ error: 'Employee, amount, and reason are required.' });
      return;
    }

    const amountPaise = rupeesToPaise(amount);
    const incentive = await grantIncentive({
      employeeId: String(employeeId),
      category: category === 'target_completion' ? 'target_completion' : 'other',
      amountPaise,
      reason: String(reason),
      achievementId: achievementId ? String(achievementId) : undefined,
      allowDuplicateOverride: Boolean(allowDuplicateOverride),
      adminId: req.user!.userId,
      adminName: req.user!.fullName,
      ipAddress: req.ip,
    });

    res.status(201).json({
      incentive,
      message: 'Incentive credited to employee earnings.',
    });
  } catch (err) {
    next(err);
  }
});

// 9. NOTIFICATIONS
router.get('/notifications', async (_req: AuthRequest, res: Response, next) => {
  try {
    const [notifications, unreadCount] = await Promise.all([
      Notification.find({ recipientRole: 'admin' }).sort({ createdAt: -1 }).limit(100).lean(),
      Notification.countDocuments({ recipientRole: 'admin', isRead: false }),
    ]);
    res.json({ notifications, unreadCount });
  } catch (err) {
    next(err);
  }
});

router.patch('/notifications/read-all', async (_req: AuthRequest, res: Response, next) => {
  try {
    await Notification.updateMany(
      { recipientRole: 'admin', isRead: false },
      { $set: { isRead: true, readAt: new Date() } }
    );
    res.json({ message: 'All notifications marked as read.' });
  } catch (err) {
    next(err);
  }
});

router.patch('/notifications/:id/read', async (req: AuthRequest, res: Response, next) => {
  try {
    await Notification.findOneAndUpdate(
      { _id: req.params.id, recipientRole: 'admin' },
      { $set: { isRead: true, readAt: new Date() } }
    );
    res.json({ message: 'Notification marked as read.' });
  } catch (err) {
    next(err);
  }
});

// 10. SYSTEM SETTINGS & AUDIT LOGS
router.get('/settings', async (_req: AuthRequest, res: Response, next) => {
  try {
    const settings = await getOrCreateSystemSettings();
    res.json({
      settings: {
        companyName: settings.companyName,
        commissionRatePercent: settings.commissionRateBps / 100,
        allowEmployeeEditEntry: settings.allowEmployeeEditEntry,
        allowEmployeeDeleteEntry: settings.allowEmployeeDeleteEntry,
        employeeEditWindowHours: settings.employeeEditWindowHours,
        withdrawalDayOfMonth: settings.withdrawalDayOfMonth,
        defaultTargetIncentiveRupees: settings.defaultTargetIncentivePaise / 100,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.put('/settings', async (req: AuthRequest, res: Response, next) => {
  try {
    const {
      companyName,
      commissionRatePercent,
      allowEmployeeEditEntry,
      allowEmployeeDeleteEntry,
      employeeEditWindowHours,
      withdrawalDayOfMonth,
      defaultTargetIncentiveRupees,
    } = req.body;

    const settings = await getOrCreateSystemSettings();
    const beforeState = {
      commissionRateBps: settings.commissionRateBps,
      allowEmployeeEditEntry: settings.allowEmployeeEditEntry,
      allowEmployeeDeleteEntry: settings.allowEmployeeDeleteEntry,
    };

    if (companyName !== undefined && String(companyName).trim()) {
      settings.companyName = String(companyName).trim();
    }
    if (commissionRatePercent !== undefined) {
      const bps = Math.round(Number(commissionRatePercent) * 100);
      if (!Number.isFinite(bps) || bps < 0 || bps > 5000) {
        res.status(400).json({ error: 'Commission percentage must be between 0% and 50%.' });
        return;
      }
      settings.commissionRateBps = bps;
    }
    if (allowEmployeeEditEntry !== undefined) {
      settings.allowEmployeeEditEntry = Boolean(allowEmployeeEditEntry);
    }
    if (allowEmployeeDeleteEntry !== undefined) {
      settings.allowEmployeeDeleteEntry = Boolean(allowEmployeeDeleteEntry);
    }
    if (employeeEditWindowHours !== undefined) {
      settings.employeeEditWindowHours = Math.max(1, Math.min(720, Number(employeeEditWindowHours)));
    }
    if (withdrawalDayOfMonth !== undefined) {
      settings.withdrawalDayOfMonth = Math.max(1, Math.min(28, Number(withdrawalDayOfMonth)));
    }
    if (defaultTargetIncentiveRupees !== undefined) {
      settings.defaultTargetIncentivePaise = Math.max(
        0,
        rupeesToPaise(defaultTargetIncentiveRupees)
      );
    }
    settings.updatedBy = new mongoose.Types.ObjectId(req.user!.userId);
    await settings.save();

    await recordAuditLog({
      actorId: req.user!.userId,
      actorRole: 'admin',
      actorName: req.user!.fullName,
      action: 'SETTINGS_UPDATED',
      entityType: 'SystemSetting',
      entityId: settings._id.toString(),
      beforeState,
      afterState: {
        commissionRateBps: settings.commissionRateBps,
        allowEmployeeEditEntry: settings.allowEmployeeEditEntry,
        allowEmployeeDeleteEntry: settings.allowEmployeeDeleteEntry,
      },
      ipAddress: req.ip,
    });

    res.json({ message: 'System settings saved successfully.' });
  } catch (err) {
    next(err);
  }
});

router.get('/audit-logs', async (_req: AuthRequest, res: Response, next) => {
  try {
    const logs = await AuditLog.find().sort({ createdAt: -1 }).limit(100).lean();
    res.json({ logs });
  } catch (err) {
    next(err);
  }
});

export default router;
