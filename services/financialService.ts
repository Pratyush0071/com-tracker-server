import type { Types } from 'mongoose';
import { runInTransaction } from '../config/db.ts';
import { EmployeeProfile } from '../models/EmployeeProfile.ts';
import type { IEmployeeProfile } from '../models/EmployeeProfile.ts';
import { SalesEntry } from '../models/SalesEntry.ts';
import { CommissionTransaction } from '../models/CommissionTransaction.ts';
import { IncentiveTransaction } from '../models/IncentiveTransaction.ts';
import { TargetAchievement } from '../models/TargetAchievement.ts';
import { TargetCycle } from '../models/TargetCycle.ts';
import type { ITargetCycle } from '../models/TargetCycle.ts';
import { Withdrawal } from '../models/Withdrawal.ts';
import { Notification } from '../models/Notification.ts';
import { User } from '../models/User.ts';
import {
  computeTargetProgress,
  ensureActiveCycleForEmployee,
  getOrCreateSystemSettings,
} from './cycleService.ts';
import { createNotification } from './notificationService.ts';
import { recordAuditLog } from './auditService.ts';
import { calculateCommissionPaise, formatINRFromPaise } from '../utils/money.ts';
import { getISTParts, parseISTDateStart } from '../utils/timezone.ts';

export function computeAvailableBalancePaise(profile: Pick<
  IEmployeeProfile,
  | 'totalCommissionPaise'
  | 'totalIncentivesPaise'
  | 'totalWithdrawnPaise'
  | 'approvedUnpaidPaise'
  | 'pendingWithdrawalPaise'
>): number {
  const totalEarnings =
    (profile.totalCommissionPaise || 0) + (profile.totalIncentivesPaise || 0);
  const lockedAndPaid =
    (profile.totalWithdrawnPaise || 0) +
    (profile.approvedUnpaidPaise || 0) +
    (profile.pendingWithdrawalPaise || 0);
  return Math.max(0, totalEarnings - lockedAndPaid);
}

async function checkAndAwardMilestonesForCycle(params: {
  profile: IEmployeeProfile;
  cycle: ITargetCycle;
  defaultTargetIncentivePaise: number;
  now: Date;
  session: Parameters<typeof runInTransaction>[0] extends (s: infer S) => unknown ? S : never;
}) {
  const { profile, cycle, defaultTargetIncentivePaise, now, session } = params;
  const newlyCompletedMilestones: Array<{ label: string; amountPaise: number; bonusPaise: number }> = [];

  for (const m of cycle.milestonesSnapshot) {
    if (cycle.totalSalesPaise >= m.amountPaise) {
      const existingAch = await TargetAchievement.findOne({
        employeeId: profile.userId,
        cycleId: cycle._id,
        milestoneAmountPaise: m.amountPaise,
      }).session(session || null);

      if (!existingAch) {
        const bonusPaise =
          m.defaultIncentivePaise !== undefined && m.defaultIncentivePaise !== null
            ? Math.max(0, m.defaultIncentivePaise)
            : Math.max(0, defaultTargetIncentivePaise || 0);

        const ach = new TargetAchievement({
          employeeId: profile.userId,
          employeeProfileId: profile._id,
          employeeCode: profile.employeeCode,
          employeeName: profile.fullName,
          cycleId: cycle._id,
          cycleKey: cycle.cycleKey,
          milestoneAmountPaise: m.amountPaise,
          milestoneLabel: m.label,
          achievedAtSalesPaise: cycle.totalSalesPaise,
          achievedAt: now,
          incentiveGranted: bonusPaise > 0,
        });
        await ach.save({ session: session || undefined });

        if (bonusPaise > 0) {
          const incentive = new IncentiveTransaction({
            employeeId: profile.userId,
            employeeProfileId: profile._id,
            employeeCode: profile.employeeCode,
            employeeName: profile.fullName,
            cycleId: cycle._id,
            cycleKey: cycle.cycleKey,
            achievementId: ach._id,
            category: 'target_completion',
            amountPaise: bonusPaise,
            reason: `Target Completion Bonus — ${m.label}`,
            authorizedByAdminId: profile.userId,
            authorizedByAdminName: 'Auto System',
            allowDuplicateOverride: false,
          });
          await incentive.save({ session: session || undefined });

          ach.incentiveId = incentive._id as Types.ObjectId;
          await ach.save({ session: session || undefined });

          profile.totalIncentivesPaise += bonusPaise;
          await profile.save({ session: session || undefined });

          cycle.totalIncentivesPaise += bonusPaise;
          await cycle.save({ session: session || undefined });
        }

        newlyCompletedMilestones.push({
          label: m.label,
          amountPaise: m.amountPaise,
          bonusPaise,
        });

        await createNotification({
          recipientId: profile.userId,
          recipientRole: 'employee',
          type: 'TARGET_ACHIEVED',
          title: `Congratulations! ${m.label} Target Completed!`,
          message:
            bonusPaise > 0
              ? `You reached ${m.label} in cycle ${cycle.label}! ${formatINRFromPaise(bonusPaise)} target bonus has been automatically added to your earnings.`
              : `You have reached ${m.label} in cycle ${cycle.label}! Keep going toward your next milestone.`,
          metadata: {
            cycleId: cycle._id.toString(),
            milestoneAmountPaise: m.amountPaise,
            bonusPaise,
          },
          session,
        });

        await createNotification({
          recipientRole: 'admin',
          type: 'EMPLOYEE_MILESTONE',
          title: `${profile.fullName} Achieved ${m.label} Target`,
          message:
            bonusPaise > 0
              ? `${profile.fullName} (${profile.employeeCode}) reached ${formatINRFromPaise(cycle.totalSalesPaise)} in cycle ${cycle.label}. ${formatINRFromPaise(bonusPaise)} bonus auto-added.`
              : `${profile.fullName} (${profile.employeeCode}) reached ${formatINRFromPaise(cycle.totalSalesPaise)} in cycle ${cycle.label}.`,
          metadata: {
            employeeId: profile.userId.toString(),
            achievementId: ach._id.toString(),
            milestoneLabel: m.label,
            bonusPaise,
          },
          session,
        });
      }
    }
  }

  return newlyCompletedMilestones;
}

export async function createSalesEntryForEmployee(params: {
  employeeId: Types.ObjectId | string;
  orderName: string;
  productName: string;
  amountPaise: number;
  clientRequestId?: string;
  ipAddress?: string;
}) {
  if (!Number.isInteger(params.amountPaise) || params.amountPaise <= 0) {
    throw Object.assign(new Error('Sale amount must be greater than zero'), { statusCode: 400 });
  }

  return runInTransaction(async (session) => {
    const profile = await EmployeeProfile.findOne({
      userId: params.employeeId,
      isDeleted: false,
    }).session(session || null);

    if (!profile || !profile.isActive) {
      throw Object.assign(new Error('Active employee profile not found'), { statusCode: 403 });
    }

    // Idempotency check against duplicate form submissions
    if (params.clientRequestId) {
      const existing = await SalesEntry.findOne({
        employeeId: params.employeeId,
        clientRequestId: params.clientRequestId,
      }).session(session || null);
      if (existing) {
        return { entry: existing, duplicate: true, newlyCompletedMilestones: [] };
      }
    }

    const now = new Date();
    const ist = getISTParts(now);
    const settings = await getOrCreateSystemSettings(session);
    const cycle = await ensureActiveCycleForEmployee(
      profile.userId,
      profile._id,
      session,
      now
    );

    const prevSalesPaise = cycle.totalSalesPaise;
    const prevProgress = computeTargetProgress(cycle, now);

    const commissionRateBps = settings.commissionRateBps ?? 100;
    const commissionPaise = calculateCommissionPaise(params.amountPaise, commissionRateBps);

    const entry = new SalesEntry({
      employeeId: profile.userId,
      employeeProfileId: profile._id,
      employeeCode: profile.employeeCode,
      employeeName: profile.fullName,
      cycleId: cycle._id,
      cycleKey: cycle.cycleKey,
      orderName: params.orderName.trim(),
      productName: params.productName.trim(),
      amountPaise: params.amountPaise,
      commissionRateBps,
      commissionPaise,
      entryDateIST: ist.dateStr,
      entryTimeIST: ist.timeStr,
      entryTimestamp: now,
      status: 'active',
      isDeleted: false,
      clientRequestId: params.clientRequestId || undefined,
      createdBy: profile.userId,
    });

    await entry.save({ session: session || undefined });

    // Record unique commission transaction
    const commissionTx = new CommissionTransaction({
      employeeId: profile.userId,
      employeeProfileId: profile._id,
      salesEntryId: entry._id,
      cycleId: cycle._id,
      cycleKey: cycle.cycleKey,
      type: 'earned',
      rateBps: commissionRateBps,
      baseAmountPaise: params.amountPaise,
      amountPaise: commissionPaise,
      description: `Commission (${(commissionRateBps / 100).toFixed(2)}%) on sale ${entry.productName || entry.orderName || formatINRFromPaise(params.amountPaise)}`,
      createdBy: profile.userId,
    });

    await commissionTx.save({ session: session || undefined });

    // Update totals atomically
    profile.lifetimeSalesPaise += params.amountPaise;
    profile.totalCommissionPaise += commissionPaise;
    await profile.save({ session: session || undefined });

    cycle.totalSalesPaise += params.amountPaise;
    cycle.totalCommissionPaise += commissionPaise;

    const newProgress = computeTargetProgress(cycle, now);
    cycle.currentTargetPaise = newProgress.activeTargetPaise;
    await cycle.save({ session: session || undefined });

    // Check 50% initial target crossing notification
    if (
      prevProgress.initialTargetPaise > 0 &&
      prevSalesPaise < prevProgress.initialTargetPaise * 0.5 &&
      cycle.totalSalesPaise >= prevProgress.initialTargetPaise * 0.5 &&
      cycle.totalSalesPaise < prevProgress.initialTargetPaise
    ) {
      await createNotification({
        recipientId: profile.userId,
        recipientRole: 'employee',
        type: 'TARGET_50_PERCENT',
        title: '50% Target Completed!',
        message: `Great progress! You have completed 50% of your ${formatINRFromPaise(prevProgress.initialTargetPaise)} target.`,
        metadata: { cycleKey: cycle.cycleKey },
        session,
      });
    }

    // Automatically award target completion bonus when target is completed
    const newlyCompletedMilestones = await checkAndAwardMilestonesForCycle({
      profile,
      cycle,
      defaultTargetIncentivePaise: settings.defaultTargetIncentivePaise || 50000,
      now,
      session,
    });

    // Notify employee of sale entry (without exposing commission percent/amount per entry)
    await createNotification({
      recipientId: profile.userId,
      recipientRole: 'employee',
      type: 'ENTRY_ADDED',
      title: 'Sale Entry Added',
      message: `Added sale of ${formatINRFromPaise(params.amountPaise)}.`,
      metadata: { entryId: entry._id.toString() },
      session,
    });

    await recordAuditLog({
      actorId: profile.userId,
      actorRole: 'employee',
      actorName: profile.fullName,
      action: 'SALE_CREATED',
      entityType: 'SalesEntry',
      entityId: entry._id.toString(),
      afterState: {
        amountPaise: params.amountPaise,
        commissionPaise,
        orderName: entry.orderName,
        productName: entry.productName,
        entryDateIST: entry.entryDateIST,
      },
      ipAddress: params.ipAddress,
      session,
    });

    return { entry, duplicate: false, newlyCompletedMilestones };
  });
}

export async function editSalesEntry(params: {
  entryId: string;
  actorId: Types.ObjectId | string;
  actorRole: 'admin' | 'employee';
  actorName: string;
  orderName?: string;
  productName?: string;
  amountPaise: number;
  ipAddress?: string;
}) {
  if (!Number.isInteger(params.amountPaise) || params.amountPaise <= 0) {
    throw Object.assign(new Error('Sale amount must be greater than zero'), { statusCode: 400 });
  }

  return runInTransaction(async (session) => {
    const entry = await SalesEntry.findById(params.entryId).session(session || null);
    if (!entry || entry.isDeleted) {
      throw Object.assign(new Error('Sales entry not found'), { statusCode: 404 });
    }

    if (
      params.actorRole === 'employee' &&
      entry.employeeId.toString() !== params.actorId.toString()
    ) {
      throw Object.assign(new Error('Unauthorized access to sales entry'), { statusCode: 403 });
    }

    const settings = await getOrCreateSystemSettings(session);
    if (params.actorRole === 'employee') {
      if (!settings.allowEmployeeEditEntry) {
        throw Object.assign(new Error('Editing sales entries is disabled by administrator'), {
          statusCode: 403,
        });
      }
      const hoursElapsed = (Date.now() - entry.entryTimestamp.getTime()) / (1000 * 60 * 60);
      if (hoursElapsed > settings.employeeEditWindowHours) {
        throw Object.assign(
          new Error(`Entries can only be edited within ${settings.employeeEditWindowHours} hours`),
          { statusCode: 403 }
        );
      }
    }

    const profile = await EmployeeProfile.findById(entry.employeeProfileId).session(
      session || null
    );
    const cycle = await TargetCycle.findById(entry.cycleId).session(session || null);
    if (!profile || !cycle) {
      throw Object.assign(new Error('Associated profile or cycle not found'), { statusCode: 404 });
    }

    if (params.actorRole === 'employee') {
      const activeCycle = await ensureActiveCycleForEmployee(profile.userId, profile._id, session);
      if (cycle._id.toString() !== activeCycle._id.toString() || cycle.status !== 'active') {
        throw Object.assign(new Error('Entries from a completed cycle cannot be modified'), {
          statusCode: 403,
        });
      }
    }

    const beforeState = {
      orderName: entry.orderName,
      productName: entry.productName,
      amountPaise: entry.amountPaise,
      commissionPaise: entry.commissionPaise,
    };

    const oldAmount = entry.amountPaise;
    const oldCommission = entry.commissionPaise;
    const newCommission = calculateCommissionPaise(params.amountPaise, entry.commissionRateBps);

    const amountDelta = params.amountPaise - oldAmount;
    const commissionDelta = newCommission - oldCommission;

    // Ensure balance won't drop below zero if commission decreased
    if (commissionDelta < 0) {
      const available = computeAvailableBalancePaise(profile);
      if (available + commissionDelta < 0) {
        throw Object.assign(
          new Error('Cannot reduce sale amount because commission has already been withdrawn or locked'),
          { statusCode: 400 }
        );
      }
    }

    entry.orderName = params.orderName !== undefined ? params.orderName.trim() : entry.orderName;
    entry.productName =
      params.productName !== undefined ? params.productName.trim() : entry.productName;
    entry.amountPaise = params.amountPaise;
    entry.commissionPaise = newCommission;
    entry.status = 'edited';
    entry.updatedBy = params.actorId as Types.ObjectId;
    await entry.save({ session: session || undefined });

    profile.lifetimeSalesPaise = Math.max(0, profile.lifetimeSalesPaise + amountDelta);
    profile.totalCommissionPaise += commissionDelta;
    await profile.save({ session: session || undefined });

    cycle.totalSalesPaise = Math.max(0, cycle.totalSalesPaise + amountDelta);
    cycle.totalCommissionPaise += commissionDelta;
    const updatedProgress = computeTargetProgress(cycle);
    cycle.currentTargetPaise = updatedProgress.activeTargetPaise;
    await cycle.save({ session: session || undefined });

    if (commissionDelta !== 0) {
      const adjTx = new CommissionTransaction({
        employeeId: profile.userId,
        employeeProfileId: profile._id,
        salesEntryId: entry._id,
        cycleId: cycle._id,
        cycleKey: cycle.cycleKey,
        type: 'adjustment',
        rateBps: entry.commissionRateBps,
        baseAmountPaise: amountDelta,
        amountPaise: commissionDelta,
        description: `Commission adjustment for edited entry (${formatINRFromPaise(oldAmount)} → ${formatINRFromPaise(params.amountPaise)})`,
        createdBy: params.actorId as Types.ObjectId,
      });
      await adjTx.save({ session: session || undefined });
    }

    if (amountDelta > 0 && cycle.status === 'active') {
      await checkAndAwardMilestonesForCycle({
        profile,
        cycle,
        defaultTargetIncentivePaise: settings.defaultTargetIncentivePaise || 50000,
        now: new Date(),
        session,
      });
    }

    await recordAuditLog({
      actorId: params.actorId,
      actorRole: params.actorRole,
      actorName: params.actorName,
      action: 'SALE_EDITED',
      entityType: 'SalesEntry',
      entityId: entry._id.toString(),
      beforeState,
      afterState: {
        orderName: entry.orderName,
        productName: entry.productName,
        amountPaise: entry.amountPaise,
        commissionPaise: entry.commissionPaise,
      },
      ipAddress: params.ipAddress,
      session,
    });

    return entry;
  });
}

export async function deleteSalesEntry(params: {
  entryId: string;
  actorId: Types.ObjectId | string;
  actorRole: 'admin' | 'employee';
  actorName: string;
  ipAddress?: string;
}) {
  return runInTransaction(async (session) => {
    const entry = await SalesEntry.findById(params.entryId).session(session || null);
    if (!entry || entry.isDeleted) {
      throw Object.assign(new Error('Sales entry not found'), { statusCode: 404 });
    }

    if (
      params.actorRole === 'employee' &&
      entry.employeeId.toString() !== params.actorId.toString()
    ) {
      throw Object.assign(new Error('Unauthorized access to sales entry'), { statusCode: 403 });
    }

    const settings = await getOrCreateSystemSettings(session);
    if (params.actorRole === 'employee' && !settings.allowEmployeeDeleteEntry) {
      throw Object.assign(new Error('Deleting sales entries is disabled by administrator'), {
        statusCode: 403,
      });
    }

    const profile = await EmployeeProfile.findById(entry.employeeProfileId).session(
      session || null
    );
    const cycle = await TargetCycle.findById(entry.cycleId).session(session || null);
    if (!profile || !cycle) {
      throw Object.assign(new Error('Associated profile or cycle not found'), { statusCode: 404 });
    }

    if (params.actorRole === 'employee') {
      const activeCycle = await ensureActiveCycleForEmployee(profile.userId, profile._id, session);
      if (cycle._id.toString() !== activeCycle._id.toString() || cycle.status !== 'active') {
        throw Object.assign(new Error('Entries from a completed cycle cannot be deleted'), {
          statusCode: 403,
        });
      }
    }

    const available = computeAvailableBalancePaise(profile);
    if (available < entry.commissionPaise) {
      throw Object.assign(
        new Error('Cannot delete entry because its commission is already withdrawn or locked'),
        { statusCode: 400 }
      );
    }

    const beforeState = {
      amountPaise: entry.amountPaise,
      commissionPaise: entry.commissionPaise,
      status: entry.status,
    };

    entry.isDeleted = true;
    entry.status = 'deleted';
    entry.updatedBy = params.actorId as Types.ObjectId;
    await entry.save({ session: session || undefined });

    profile.lifetimeSalesPaise = Math.max(0, profile.lifetimeSalesPaise - entry.amountPaise);
    profile.totalCommissionPaise = Math.max(0, profile.totalCommissionPaise - entry.commissionPaise);
    await profile.save({ session: session || undefined });

    cycle.totalSalesPaise = Math.max(0, cycle.totalSalesPaise - entry.amountPaise);
    cycle.totalCommissionPaise = Math.max(0, cycle.totalCommissionPaise - entry.commissionPaise);
    const updatedProgress = computeTargetProgress(cycle);
    cycle.currentTargetPaise = updatedProgress.activeTargetPaise;
    await cycle.save({ session: session || undefined });

    const revTx = new CommissionTransaction({
      employeeId: profile.userId,
      employeeProfileId: profile._id,
      salesEntryId: entry._id,
      cycleId: cycle._id,
      cycleKey: cycle.cycleKey,
      type: 'reversal',
      rateBps: entry.commissionRateBps,
      baseAmountPaise: -entry.amountPaise,
      amountPaise: -entry.commissionPaise,
      description: `Commission reversed due to deleted entry (${formatINRFromPaise(entry.amountPaise)})`,
      createdBy: params.actorId as Types.ObjectId,
    });
    await revTx.save({ session: session || undefined });

    await recordAuditLog({
      actorId: params.actorId,
      actorRole: params.actorRole,
      actorName: params.actorName,
      action: 'SALE_DELETED',
      entityType: 'SalesEntry',
      entityId: entry._id.toString(),
      beforeState,
      afterState: { status: 'deleted', isDeleted: true },
      ipAddress: params.ipAddress,
      session,
    });

    return entry;
  });
}

export async function createWithdrawalRequest(params: {
  employeeId: Types.ObjectId | string;
  amountPaise: number;
  employeeNote?: string;
  ipAddress?: string;
}) {
  if (!Number.isInteger(params.amountPaise) || params.amountPaise < 100) {
    throw Object.assign(new Error('Minimum withdrawal amount is ₹1'), { statusCode: 400 });
  }

  return runInTransaction(async (session) => {
    const profile = await EmployeeProfile.findOne({
      userId: params.employeeId,
      isDeleted: false,
    }).session(session || null);

    if (!profile || !profile.isActive) {
      throw Object.assign(new Error('Active employee profile not found'), { statusCode: 403 });
    }

    const available = computeAvailableBalancePaise(profile);
    if (params.amountPaise > available) {
      throw Object.assign(
        new Error(`Requested amount exceeds available balance (${formatINRFromPaise(available)})`),
        { statusCode: 400 }
      );
    }

    // Prevent rapid duplicate pending request with same amount within 2 minutes
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    const duplicate = await Withdrawal.findOne({
      employeeId: profile.userId,
      status: 'pending',
      amountPaise: params.amountPaise,
      requestedAt: { $gte: twoMinutesAgo },
    }).session(session || null);

    if (duplicate) {
      throw Object.assign(
        new Error('A matching withdrawal request was just submitted. Please wait.'),
        { statusCode: 409 }
      );
    }

    const now = new Date();
    const ist = getISTParts(now);
    const cycle = await ensureActiveCycleForEmployee(profile.userId, profile._id, session, now);

    const withdrawal = new Withdrawal({
      employeeId: profile.userId,
      employeeProfileId: profile._id,
      employeeCode: profile.employeeCode,
      employeeName: profile.fullName,
      cycleId: cycle._id,
      cycleKey: cycle.cycleKey,
      amountPaise: params.amountPaise,
      status: 'pending',
      requestedAt: now,
      requestDateIST: ist.dateStr,
      employeeNote: (params.employeeNote || '').trim(),
    });
    await withdrawal.save({ session: session || undefined });

    // Lock pending balance immediately
    profile.pendingWithdrawalPaise += params.amountPaise;
    await profile.save({ session: session || undefined });

    await createNotification({
      recipientRole: 'admin',
      type: 'WITHDRAWAL_REQUESTED',
      title: 'New Withdrawal Request',
      message: `${profile.fullName} (${profile.employeeCode}) requested a withdrawal of ${formatINRFromPaise(params.amountPaise)}.`,
      metadata: { withdrawalId: withdrawal._id.toString(), employeeId: profile.userId.toString() },
      session,
    });

    await recordAuditLog({
      actorId: profile.userId,
      actorRole: 'employee',
      actorName: profile.fullName,
      action: 'WITHDRAWAL_REQUESTED',
      entityType: 'Withdrawal',
      entityId: withdrawal._id.toString(),
      afterState: {
        amountPaise: params.amountPaise,
        status: 'pending',
        lockedPendingPaise: profile.pendingWithdrawalPaise,
      },
      ipAddress: params.ipAddress,
      session,
    });

    return withdrawal;
  });
}

export async function approveWithdrawal(params: {
  withdrawalId: string;
  adminId: Types.ObjectId | string;
  adminName: string;
  ipAddress?: string;
}) {
  return runInTransaction(async (session) => {
    const withdrawal = await Withdrawal.findById(params.withdrawalId).session(session || null);
    if (!withdrawal) {
      throw Object.assign(new Error('Withdrawal request not found'), { statusCode: 404 });
    }
    if (withdrawal.status !== 'pending') {
      throw Object.assign(
        new Error(`Only pending withdrawals can be approved (current: ${withdrawal.status})`),
        { statusCode: 400 }
      );
    }

    const profile = await EmployeeProfile.findById(withdrawal.employeeProfileId).session(
      session || null
    );
    if (!profile) {
      throw Object.assign(new Error('Employee profile not found'), { statusCode: 404 });
    }

    withdrawal.status = 'approved';
    withdrawal.reviewedAt = new Date();
    withdrawal.reviewedBy = params.adminId as Types.ObjectId;
    withdrawal.reviewedByName = params.adminName;
    await withdrawal.save({ session: session || undefined });

    profile.pendingWithdrawalPaise = Math.max(
      0,
      profile.pendingWithdrawalPaise - withdrawal.amountPaise
    );
    profile.approvedUnpaidPaise += withdrawal.amountPaise;
    await profile.save({ session: session || undefined });

    await createNotification({
      recipientId: withdrawal.employeeId,
      recipientRole: 'employee',
      type: 'WITHDRAWAL_APPROVED',
      title: 'Withdrawal Approved',
      message: `Your withdrawal request of ${formatINRFromPaise(withdrawal.amountPaise)} has been approved and is queued for payment.`,
      metadata: { withdrawalId: withdrawal._id.toString() },
      session,
    });

    await recordAuditLog({
      actorId: params.adminId,
      actorRole: 'admin',
      actorName: params.adminName,
      action: 'WITHDRAWAL_APPROVED',
      entityType: 'Withdrawal',
      entityId: withdrawal._id.toString(),
      beforeState: { status: 'pending' },
      afterState: { status: 'approved', amountPaise: withdrawal.amountPaise },
      ipAddress: params.ipAddress,
      session,
    });

    return withdrawal;
  });
}

export async function rejectWithdrawal(params: {
  withdrawalId: string;
  adminId: Types.ObjectId | string;
  adminName: string;
  reason: string;
  ipAddress?: string;
}) {
  if (!params.reason || !params.reason.trim()) {
    throw Object.assign(new Error('Rejection reason is required'), { statusCode: 400 });
  }

  return runInTransaction(async (session) => {
    const withdrawal = await Withdrawal.findById(params.withdrawalId).session(session || null);
    if (!withdrawal) {
      throw Object.assign(new Error('Withdrawal request not found'), { statusCode: 404 });
    }
    if (withdrawal.status !== 'pending') {
      throw Object.assign(
        new Error(`Only pending withdrawals can be rejected (current: ${withdrawal.status})`),
        { statusCode: 400 }
      );
    }

    const profile = await EmployeeProfile.findById(withdrawal.employeeProfileId).session(
      session || null
    );
    if (!profile) {
      throw Object.assign(new Error('Employee profile not found'), { statusCode: 404 });
    }

    withdrawal.status = 'rejected';
    withdrawal.reviewedAt = new Date();
    withdrawal.reviewedBy = params.adminId as Types.ObjectId;
    withdrawal.reviewedByName = params.adminName;
    withdrawal.rejectionReason = params.reason.trim();
    await withdrawal.save({ session: session || undefined });

    // Release locked balance back to available balance
    profile.pendingWithdrawalPaise = Math.max(
      0,
      profile.pendingWithdrawalPaise - withdrawal.amountPaise
    );
    await profile.save({ session: session || undefined });

    await createNotification({
      recipientId: withdrawal.employeeId,
      recipientRole: 'employee',
      type: 'WITHDRAWAL_REJECTED',
      title: 'Withdrawal Request Rejected',
      message: `Your withdrawal request of ${formatINRFromPaise(withdrawal.amountPaise)} was rejected. Reason: ${withdrawal.rejectionReason}`,
      metadata: { withdrawalId: withdrawal._id.toString() },
      session,
    });

    await recordAuditLog({
      actorId: params.adminId,
      actorRole: 'admin',
      actorName: params.adminName,
      action: 'WITHDRAWAL_REJECTED',
      entityType: 'Withdrawal',
      entityId: withdrawal._id.toString(),
      beforeState: { status: 'pending' },
      afterState: { status: 'rejected', rejectionReason: withdrawal.rejectionReason },
      reason: withdrawal.rejectionReason,
      ipAddress: params.ipAddress,
      session,
    });

    return withdrawal;
  });
}

export async function markWithdrawalPaid(params: {
  withdrawalId: string;
  adminId: Types.ObjectId | string;
  adminName: string;
  paymentMethod: string;
  paymentReference: string;
  paymentNotes?: string;
  ipAddress?: string;
}) {
  return runInTransaction(async (session) => {
    const withdrawal = await Withdrawal.findById(params.withdrawalId).session(session || null);
    if (!withdrawal) {
      throw Object.assign(new Error('Withdrawal request not found'), { statusCode: 404 });
    }
    if (withdrawal.status !== 'approved') {
      throw Object.assign(
        new Error('Only approved withdrawals can be marked as paid'),
        { statusCode: 400 }
      );
    }

    const profile = await EmployeeProfile.findById(withdrawal.employeeProfileId).session(
      session || null
    );
    if (!profile) {
      throw Object.assign(new Error('Employee profile not found'), { statusCode: 404 });
    }

    withdrawal.status = 'paid';
    withdrawal.paidAt = new Date();
    withdrawal.paidBy = params.adminId as Types.ObjectId;
    withdrawal.paidByName = params.adminName;
    withdrawal.paymentMethod = (params.paymentMethod || 'Bank Transfer').trim();
    withdrawal.paymentReference = (params.paymentReference || '').trim();
    withdrawal.paymentNotes = (params.paymentNotes || '').trim();
    await withdrawal.save({ session: session || undefined });

    profile.approvedUnpaidPaise = Math.max(
      0,
      profile.approvedUnpaidPaise - withdrawal.amountPaise
    );
    profile.totalWithdrawnPaise += withdrawal.amountPaise;
    await profile.save({ session: session || undefined });

    if (withdrawal.cycleId) {
      await TargetCycle.findByIdAndUpdate(
        withdrawal.cycleId,
        { $inc: { withdrawnPaise: withdrawal.amountPaise } },
        { session: session || undefined }
      );
    }

    await createNotification({
      recipientId: withdrawal.employeeId,
      recipientRole: 'employee',
      type: 'WITHDRAWAL_PAID',
      title: 'Withdrawal Payment Completed',
      message: `${formatINRFromPaise(withdrawal.amountPaise)} has been paid via ${withdrawal.paymentMethod}${withdrawal.paymentReference ? ` (Ref: ${withdrawal.paymentReference})` : ''}.`,
      metadata: { withdrawalId: withdrawal._id.toString() },
      session,
    });

    await recordAuditLog({
      actorId: params.adminId,
      actorRole: 'admin',
      actorName: params.adminName,
      action: 'WITHDRAWAL_PAID',
      entityType: 'Withdrawal',
      entityId: withdrawal._id.toString(),
      beforeState: { status: 'approved' },
      afterState: {
        status: 'paid',
        paymentMethod: withdrawal.paymentMethod,
        paymentReference: withdrawal.paymentReference,
      },
      ipAddress: params.ipAddress,
      session,
    });

    return withdrawal;
  });
}

export async function grantIncentive(params: {
  employeeId: string;
  category: 'target_completion' | 'other';
  amountPaise: number;
  reason: string;
  achievementId?: string;
  allowDuplicateOverride?: boolean;
  adminId: Types.ObjectId | string;
  adminName: string;
  ipAddress?: string;
}) {
  if (!Number.isInteger(params.amountPaise) || params.amountPaise < 100) {
    throw Object.assign(new Error('Incentive amount must be at least ₹1'), { statusCode: 400 });
  }
  if (!params.reason || !params.reason.trim()) {
    throw Object.assign(new Error('Incentive reason is required'), { statusCode: 400 });
  }

  return runInTransaction(async (session) => {
    const profile = await EmployeeProfile.findOne({
      userId: params.employeeId,
      isDeleted: false,
    }).session(session || null);
    if (!profile) {
      throw Object.assign(new Error('Employee profile not found'), { statusCode: 404 });
    }

    const cycle = await ensureActiveCycleForEmployee(profile.userId, profile._id, session);
    let achievementCycleId = cycle._id;
    let achievementCycleKey = cycle.cycleKey;

    if (params.achievementId) {
      const ach = await TargetAchievement.findById(params.achievementId).session(session || null);
      if (!ach) {
        throw Object.assign(new Error('Target achievement record not found'), { statusCode: 404 });
      }
      if (ach.employeeId.toString() !== profile.userId.toString()) {
        throw Object.assign(new Error('Achievement does not belong to selected employee'), {
          statusCode: 400,
        });
      }
      if (ach.incentiveGranted && !params.allowDuplicateOverride) {
        throw Object.assign(
          new Error(
            'An incentive has already been granted for this target achievement. Confirm duplicate override to authorize an additional incentive.'
          ),
          { statusCode: 409 }
        );
      }
      achievementCycleId = ach.cycleId;
      achievementCycleKey = ach.cycleKey;

      if (!ach.incentiveGranted) {
        ach.incentiveGranted = true;
        await ach.save({ session: session || undefined });
      }
    }

    const incentive = new IncentiveTransaction({
      employeeId: profile.userId,
      employeeProfileId: profile._id,
      employeeCode: profile.employeeCode,
      employeeName: profile.fullName,
      cycleId: achievementCycleId,
      cycleKey: achievementCycleKey,
      achievementId: params.achievementId || undefined,
      category: params.category,
      amountPaise: params.amountPaise,
      reason: params.reason.trim(),
      authorizedByAdminId: params.adminId as Types.ObjectId,
      authorizedByAdminName: params.adminName,
      allowDuplicateOverride: Boolean(params.allowDuplicateOverride),
    });

    await incentive.save({ session: session || undefined });

    if (params.achievementId) {
      await TargetAchievement.findByIdAndUpdate(
        params.achievementId,
        { $set: { incentiveGranted: true, incentiveId: incentive._id } },
        { session: session || undefined }
      );
    }

    profile.totalIncentivesPaise += params.amountPaise;
    await profile.save({ session: session || undefined });

    await TargetCycle.findByIdAndUpdate(
      achievementCycleId,
      { $inc: { totalIncentivesPaise: params.amountPaise } },
      { session: session || undefined }
    );

    await createNotification({
      recipientId: profile.userId,
      recipientRole: 'employee',
      type: 'INCENTIVE_ADDED',
      title: 'New Incentive Credited!',
      message: `Admin credited a ${params.category === 'target_completion' ? 'Target Completion' : 'Bonus'} incentive of ${formatINRFromPaise(params.amountPaise)}. Reason: ${incentive.reason}`,
      metadata: { incentiveId: incentive._id.toString() },
      session,
    });

    await recordAuditLog({
      actorId: params.adminId,
      actorRole: 'admin',
      actorName: params.adminName,
      action: 'INCENTIVE_ADDED',
      entityType: 'IncentiveTransaction',
      entityId: incentive._id.toString(),
      afterState: {
        employeeCode: profile.employeeCode,
        category: params.category,
        amountPaise: params.amountPaise,
        reason: incentive.reason,
        achievementId: params.achievementId,
      },
      reason: incentive.reason,
      ipAddress: params.ipAddress,
      session,
    });

    return incentive;
  });
}

export async function clearAllEmployeeData(params: {
  employeeId: string;
  adminId: Types.ObjectId | string;
  adminName: string;
  alsoDeleteAccount?: boolean;
  ipAddress?: string;
}) {
  return runInTransaction(async (session) => {
    const profile = await EmployeeProfile.findOne({
      userId: params.employeeId,
      isDeleted: false,
    }).session(session || null);

    if (!profile) {
      throw Object.assign(new Error('Employee not found'), { statusCode: 404 });
    }

    const empUserId = profile.userId;

    const salesDel = await SalesEntry.deleteMany({ employeeId: empUserId }).session(session || null);
    const commDel = await CommissionTransaction.deleteMany({ employeeId: empUserId }).session(session || null);
    const incDel = await IncentiveTransaction.deleteMany({ employeeId: empUserId }).session(session || null);
    const achDel = await TargetAchievement.deleteMany({ employeeId: empUserId }).session(session || null);
    const wDel = await Withdrawal.deleteMany({ employeeId: empUserId }).session(session || null);
    const cycleDel = await TargetCycle.deleteMany({ employeeId: empUserId }).session(session || null);
    const notifDel = await Notification.deleteMany({
      recipientId: empUserId,
      recipientRole: 'employee',
    }).session(session || null);

    profile.lifetimeSalesPaise = 0;
    profile.totalCommissionPaise = 0;
    profile.totalIncentivesPaise = 0;
    profile.totalWithdrawnPaise = 0;
    profile.approvedUnpaidPaise = 0;
    profile.pendingWithdrawalPaise = 0;

    if (params.alsoDeleteAccount) {
      profile.isDeleted = true;
      profile.isActive = false;
      profile.deletedAt = new Date();
      await User.findByIdAndUpdate(
        empUserId,
        { $set: { isDeleted: true, isActive: false } },
        { session: session || undefined }
      );
    }

    await profile.save({ session: session || undefined });

    if (!params.alsoDeleteAccount) {
      await ensureActiveCycleForEmployee(empUserId, profile._id, session, new Date());
    }

    await recordAuditLog({
      actorId: params.adminId,
      actorRole: 'admin',
      actorName: params.adminName,
      action: params.alsoDeleteAccount ? 'EMPLOYEE_ACCOUNT_AND_DATA_DELETED' : 'EMPLOYEE_ALL_DATA_DELETED',
      entityType: 'EmployeeProfile',
      entityId: profile._id.toString(),
      afterState: {
        employeeCode: profile.employeeCode,
        deletedSalesEntries: salesDel.deletedCount,
        deletedCommissions: commDel.deletedCount,
        deletedIncentives: incDel.deletedCount,
        deletedAchievements: achDel.deletedCount,
        deletedWithdrawals: wDel.deletedCount,
        deletedCycles: cycleDel.deletedCount,
        deletedNotifications: notifDel.deletedCount,
        accountDeleted: Boolean(params.alsoDeleteAccount),
      },
      ipAddress: params.ipAddress,
      session,
    });

    return {
      employeeCode: profile.employeeCode,
      fullName: profile.fullName,
      deletedSalesCount: salesDel.deletedCount,
    };
  });
}

export async function approveDirectPayout(params: {
  employeeId: string;
  amountPaise?: number;
  note?: string;
  adminId: Types.ObjectId | string;
  adminName: string;
  ipAddress?: string;
}) {
  return runInTransaction(async (session) => {
    const profile = await EmployeeProfile.findOne({
      userId: params.employeeId,
      isDeleted: false,
    }).session(session || null);

    if (!profile) {
      throw Object.assign(new Error('Employee profile not found'), { statusCode: 404 });
    }

    const available = computeAvailableBalancePaise(profile);
    if (available <= 0) {
      throw Object.assign(new Error('No unpaid earnings balance available for this employee.'), {
        statusCode: 400,
      });
    }

    const payAmount =
      params.amountPaise && params.amountPaise > 0
        ? Math.min(available, Math.round(params.amountPaise))
        : available;

    const now = new Date();
    const ist = getISTParts(now);
    const cycle = await ensureActiveCycleForEmployee(profile.userId, profile._id, session, now);

    const payout = new Withdrawal({
      employeeId: profile.userId,
      employeeProfileId: profile._id,
      employeeCode: profile.employeeCode,
      employeeName: profile.fullName,
      cycleId: cycle._id,
      cycleKey: cycle.cycleKey,
      amountPaise: payAmount,
      status: 'paid',
      requestedAt: now,
      requestDateIST: ist.dateStr,
      employeeNote: '',
      reviewedAt: now,
      reviewedBy: params.adminId as Types.ObjectId,
      reviewedByName: params.adminName,
      paidAt: now,
      paidBy: params.adminId as Types.ObjectId,
      paidByName: params.adminName,
      paymentMethod: 'Approved & Paid',
      paymentReference: '',
      paymentNotes: (params.note || 'Marked paid by Admin').trim(),
    });
    await payout.save({ session: session || undefined });

    profile.totalWithdrawnPaise += payAmount;
    await profile.save({ session: session || undefined });

    cycle.withdrawnPaise += payAmount;
    await cycle.save({ session: session || undefined });

    await recordAuditLog({
      actorId: params.adminId,
      actorRole: 'admin',
      actorName: params.adminName,
      action: 'ADMIN_PAYOUT_APPROVED_PAID',
      entityType: 'Withdrawal',
      entityId: payout._id.toString(),
      afterState: {
        employeeCode: profile.employeeCode,
        amountPaise: payAmount,
        status: 'paid',
      },
      ipAddress: params.ipAddress,
      session,
    });

    return payout;
  });
}

export async function deleteDataSelectively(params: {
  mode: 'date_range' | 'employee' | 'all_data';
  employeeId?: string;
  fromDate?: string;
  toDate?: string;
  alsoDeleteAccount?: boolean;
  alsoDeleteEmployeeAccounts?: boolean;
  adminId: Types.ObjectId | string;
  adminName: string;
  ipAddress?: string;
}) {
  if (params.mode === 'employee') {
    if (!params.employeeId || params.employeeId === 'all') {
      throw Object.assign(new Error('Please select an employee.'), { statusCode: 400 });
    }
    const res = await clearAllEmployeeData({
      employeeId: params.employeeId,
      adminId: params.adminId,
      adminName: params.adminName,
      alsoDeleteAccount: Boolean(params.alsoDeleteAccount),
      ipAddress: params.ipAddress,
    });
    return {
      mode: 'employee' as const,
      deletedSalesCount: res.deletedSalesCount,
      message: `Deleted all data for ${res.fullName} (${res.employeeCode}).`,
    };
  }

  return runInTransaction(async (session) => {
    if (params.mode === 'all_data') {
      const salesDel = await SalesEntry.deleteMany({}).session(session || null);
      await CommissionTransaction.deleteMany({}).session(session || null);
      await IncentiveTransaction.deleteMany({}).session(session || null);
      await TargetAchievement.deleteMany({}).session(session || null);
      await Withdrawal.deleteMany({}).session(session || null);
      await TargetCycle.deleteMany({}).session(session || null);
      await Notification.deleteMany({ recipientRole: 'employee' }).session(session || null);

      if (params.alsoDeleteEmployeeAccounts) {
        const now = new Date();
        await EmployeeProfile.updateMany(
          { isDeleted: false },
          {
            $set: {
              lifetimeSalesPaise: 0,
              totalCommissionPaise: 0,
              totalIncentivesPaise: 0,
              totalWithdrawnPaise: 0,
              approvedUnpaidPaise: 0,
              pendingWithdrawalPaise: 0,
              isDeleted: true,
              isActive: false,
              deletedAt: now,
            },
          }
        ).session(session || null);
        await User.updateMany(
          { role: 'employee', isDeleted: false },
          { $set: { isDeleted: true, isActive: false } }
        ).session(session || null);
      } else {
        await EmployeeProfile.updateMany(
          { isDeleted: false },
          {
            $set: {
              lifetimeSalesPaise: 0,
              totalCommissionPaise: 0,
              totalIncentivesPaise: 0,
              totalWithdrawnPaise: 0,
              approvedUnpaidPaise: 0,
              pendingWithdrawalPaise: 0,
            },
          }
        ).session(session || null);

        const activeProfiles = await EmployeeProfile.find({ isDeleted: false, isActive: true }).session(
          session || null
        );
        const now = new Date();
        for (const p of activeProfiles) {
          await ensureActiveCycleForEmployee(p.userId, p._id, session, now);
        }
      }

      await recordAuditLog({
        actorId: params.adminId,
        actorRole: 'admin',
        actorName: params.adminName,
        action: 'ADMIN_ALL_DATA_DELETED',
        entityType: 'System',
        entityId: 'all_data',
        afterState: {
          deletedSalesCount: salesDel.deletedCount,
          alsoDeleteEmployeeAccounts: Boolean(params.alsoDeleteEmployeeAccounts),
        },
        ipAddress: params.ipAddress,
        session,
      });

      return {
        mode: 'all_data' as const,
        deletedSalesCount: salesDel.deletedCount,
        message: 'All company transactional data has been deleted.',
      };
    }

    // mode === 'date_range'
    if (!params.fromDate || !params.toDate) {
      throw Object.assign(new Error('From Date and To Date are required.'), { statusCode: 400 });
    }
    if (params.fromDate > params.toDate) {
      throw Object.assign(new Error('From Date cannot be after To Date.'), { statusCode: 400 });
    }

    const startTs = parseISTDateStart(params.fromDate);
    const endTs = new Date(parseISTDateStart(params.toDate).getTime() + 24 * 60 * 60 * 1000);

    const salesQuery: Record<string, unknown> = {
      entryDateIST: { $gte: params.fromDate, $lte: params.toDate },
    };
    const dateRangeTsFilter: Record<string, unknown> = {
      $gte: startTs,
      $lt: endTs,
    };

    const scopedEmployeeId =
      params.employeeId && params.employeeId !== 'all' ? params.employeeId : undefined;
    if (scopedEmployeeId) {
      salesQuery.employeeId = scopedEmployeeId;
    }

    const matchingSales = await SalesEntry.find(salesQuery)
      .select('_id employeeId')
      .session(session || null)
      .lean();
    const saleIds = matchingSales.map((s) => s._id);

    const affectedEmployeeSet = new Set<string>(matchingSales.map((s) => String(s.employeeId)));
    if (scopedEmployeeId) {
      affectedEmployeeSet.add(scopedEmployeeId);
    } else {
      const incEmps = await IncentiveTransaction.distinct('employeeId', {
        createdAt: dateRangeTsFilter,
      }).session(session || null);
      const achEmps = await TargetAchievement.distinct('employeeId', {
        achievedAt: dateRangeTsFilter,
      }).session(session || null);
      const wEmps = await Withdrawal.distinct('employeeId', {
        requestDateIST: { $gte: params.fromDate, $lte: params.toDate },
      }).session(session || null);
      incEmps.forEach((id) => affectedEmployeeSet.add(String(id)));
      achEmps.forEach((id) => affectedEmployeeSet.add(String(id)));
      wEmps.forEach((id) => affectedEmployeeSet.add(String(id)));
    }

    const empScopeFilter = scopedEmployeeId ? { employeeId: scopedEmployeeId } : {};

    const salesDel = await SalesEntry.deleteMany(salesQuery).session(session || null);
    if (saleIds.length > 0) {
      await CommissionTransaction.deleteMany({ salesEntryId: { $in: saleIds } }).session(
        session || null
      );
    }
    await IncentiveTransaction.deleteMany({ ...empScopeFilter, createdAt: dateRangeTsFilter }).session(
      session || null
    );
    await TargetAchievement.deleteMany({ ...empScopeFilter, achievedAt: dateRangeTsFilter }).session(
      session || null
    );
    await Withdrawal.deleteMany({
      ...empScopeFilter,
      requestDateIST: { $gte: params.fromDate, $lte: params.toDate },
    }).session(session || null);

    // Recalculate TargetCycle & EmployeeProfile totals cleanly for every affected employee
    for (const empIdStr of affectedEmployeeSet) {
      const profile = await EmployeeProfile.findOne({ userId: empIdStr }).session(session || null);
      if (!profile) continue;

      const cycles = await TargetCycle.find({ employeeId: profile.userId }).session(session || null);
      for (const c of cycles) {
        const cSalesAgg = await SalesEntry.aggregate([
          { $match: { cycleId: c._id, isDeleted: false } },
          {
            $group: {
              _id: null,
              salesPaise: { $sum: '$amountPaise' },
              commPaise: { $sum: '$commissionPaise' },
            },
          },
        ]).session(session || null);
        const cIncAgg = await IncentiveTransaction.aggregate([
          { $match: { cycleId: c._id } },
          { $group: { _id: null, total: { $sum: '$amountPaise' } } },
        ]).session(session || null);
        const cPaidAgg = await Withdrawal.aggregate([
          { $match: { cycleId: c._id, status: 'paid' } },
          { $group: { _id: null, total: { $sum: '$amountPaise' } } },
        ]).session(session || null);

        c.totalSalesPaise = cSalesAgg[0]?.salesPaise || 0;
        c.totalCommissionPaise = cSalesAgg[0]?.commPaise || 0;
        c.totalIncentivesPaise = cIncAgg[0]?.total || 0;
        c.withdrawnPaise = cPaidAgg[0]?.total || 0;
        c.currentTargetPaise = computeTargetProgress(c).activeTargetPaise;
        await c.save({ session: session || undefined });
      }

      const pSalesAgg = await SalesEntry.aggregate([
        { $match: { employeeId: profile.userId, isDeleted: false } },
        { $group: { _id: null, total: { $sum: '$amountPaise' } } },
      ]).session(session || null);
      const pCommAgg = await CommissionTransaction.aggregate([
        { $match: { employeeId: profile.userId } },
        { $group: { _id: null, total: { $sum: '$amountPaise' } } },
      ]).session(session || null);
      const pIncAgg = await IncentiveTransaction.aggregate([
        { $match: { employeeId: profile.userId } },
        { $group: { _id: null, total: { $sum: '$amountPaise' } } },
      ]).session(session || null);
      const pPaidAgg = await Withdrawal.aggregate([
        { $match: { employeeId: profile.userId, status: 'paid' } },
        { $group: { _id: null, total: { $sum: '$amountPaise' } } },
      ]).session(session || null);
      const pAppAgg = await Withdrawal.aggregate([
        { $match: { employeeId: profile.userId, status: 'approved' } },
        { $group: { _id: null, total: { $sum: '$amountPaise' } } },
      ]).session(session || null);
      const pPendAgg = await Withdrawal.aggregate([
        { $match: { employeeId: profile.userId, status: 'pending' } },
        { $group: { _id: null, total: { $sum: '$amountPaise' } } },
      ]).session(session || null);

      profile.lifetimeSalesPaise = pSalesAgg[0]?.total || 0;
      profile.totalCommissionPaise = pCommAgg[0]?.total || 0;
      profile.totalIncentivesPaise = pIncAgg[0]?.total || 0;
      profile.totalWithdrawnPaise = pPaidAgg[0]?.total || 0;
      profile.approvedUnpaidPaise = pAppAgg[0]?.total || 0;
      profile.pendingWithdrawalPaise = pPendAgg[0]?.total || 0;
      await profile.save({ session: session || undefined });
    }

    await recordAuditLog({
      actorId: params.adminId,
      actorRole: 'admin',
      actorName: params.adminName,
      action: 'ADMIN_DATE_RANGE_DATA_DELETED',
      entityType: 'SalesEntry',
      entityId: `${params.fromDate}_to_${params.toDate}`,
      afterState: {
        fromDate: params.fromDate,
        toDate: params.toDate,
        employeeId: scopedEmployeeId || 'all',
        deletedSalesCount: salesDel.deletedCount,
      },
      ipAddress: params.ipAddress,
      session,
    });

    return {
      mode: 'date_range' as const,
      deletedSalesCount: salesDel.deletedCount,
      message: `Deleted ${salesDel.deletedCount} sales entries from ${params.fromDate} to ${params.toDate}.`,
    };
  });
}
