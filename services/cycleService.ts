import type { ClientSession, Types } from 'mongoose';
import { TargetCycle } from '../models/TargetCycle.ts';
import type { ITargetCycle, ICycleMilestoneSnapshot } from '../models/TargetCycle.ts';
import { TargetConfiguration } from '../models/TargetConfiguration.ts';
import { EmployeeProfile } from '../models/EmployeeProfile.ts';
import { SalesEntry } from '../models/SalesEntry.ts';
import { SystemSetting } from '../models/SystemSetting.ts';
import { createNotification } from './notificationService.ts';
import {
  formatISTDateLabel,
  getCycleBoundsForDate,
  getISTParts,
  getRemainingDaysInCycle,
  parseISTDateStart,
} from '../utils/timezone.ts';

export async function getOrCreateSystemSettings(session?: ClientSession | null) {
  let settings = await SystemSetting.findOne({ key: 'global' }).session(session || null);
  if (!settings) {
    settings = new SystemSetting({ key: 'global' });
    await settings.save({ session: session || undefined });
  }
  return settings;
}

export async function getOrCreateTargetConfig(session?: ClientSession | null) {
  let config = await TargetConfiguration.findOne({ key: 'default' }).session(session || null);
  if (!config) {
    config = new TargetConfiguration({ key: 'default' });
    await config.save({ session: session || undefined });
  }
  return config;
}

function buildMilestonesWithCustomInitial(
  baseMilestones: ICycleMilestoneSnapshot[],
  customInitialTargetPaise?: number | null
): { initialTargetPaise: number; milestonesSnapshot: ICycleMilestoneSnapshot[] } {
  const sorted = [...baseMilestones].sort((a, b) => a.amountPaise - b.amountPaise);
  if (customInitialTargetPaise && customInitialTargetPaise > 0) {
    const filtered = sorted.filter((m) => m.amountPaise > customInitialTargetPaise);
    const labelRupees = customInitialTargetPaise / 100;
    const customLabel =
      labelRupees >= 100000
        ? `₹${Number((labelRupees / 100000).toFixed(2))} Lakh`
        : `₹${labelRupees.toLocaleString('en-IN')}`;
    const list: ICycleMilestoneSnapshot[] = [
      {
        order: 1,
        amountPaise: customInitialTargetPaise,
        label: customLabel,
        defaultIncentivePaise: sorted[0]?.defaultIncentivePaise ?? 50000,
      },
      ...filtered.map((m, idx) => ({
        order: idx + 2,
        amountPaise: m.amountPaise,
        label: m.label,
        defaultIncentivePaise: m.defaultIncentivePaise,
      })),
    ];
    return { initialTargetPaise: customInitialTargetPaise, milestonesSnapshot: list };
  }

  return {
    initialTargetPaise: sorted.length > 0 ? sorted[0].amountPaise : 50000000,
    milestonesSnapshot: sorted.map((m, idx) => ({ ...m, order: idx + 1 })),
  };
}

async function generateUniqueCycleKey(
  employeeId: Types.ObjectId | string,
  baseKey: string,
  excludeCycleId?: Types.ObjectId,
  session?: ClientSession | null
): Promise<string> {
  let candidate = baseKey;
  let counter = 2;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const query: Record<string, unknown> = { employeeId, cycleKey: candidate };
    if (excludeCycleId) {
      query._id = { $ne: excludeCycleId };
    }
    const exists = await TargetCycle.findOne(query).session(session || null);
    if (!exists) {
      return candidate;
    }
    candidate = `${baseKey}_v${counter}`;
    counter += 1;
  }
}

export async function ensureActiveCycleForEmployee(
  employeeId: Types.ObjectId | string,
  employeeProfileId: Types.ObjectId | string,
  session?: ClientSession | null,
  now: Date = new Date()
): Promise<ITargetCycle> {
  const settings = await getOrCreateSystemSettings(session);
  const config = await getOrCreateTargetConfig(session);
  const profile = await EmployeeProfile.findById(employeeProfileId).session(session || null);

  const cycleDay = profile?.targetCycleDay || settings.withdrawalDayOfMonth || 20;

  // Check if there is an active cycle right now
  const activeCycles = await TargetCycle.find({
    employeeId,
    status: 'active',
  })
    .sort({ createdAt: -1 })
    .session(session || null);

  let validActiveCycle: ITargetCycle | null = null;
  let closedAny = false;

  for (const c of activeCycles) {
    // Keep the most recent active cycle if it hasn't reached its endTimestamp yet
    if (!validActiveCycle && now.getTime() < new Date(c.endTimestamp).getTime()) {
      validActiveCycle = c;
    } else {
      c.status = 'closed';
      c.closedAt = now;
      await c.save({ session: session || undefined });
      closedAny = true;
    }
  }

  if (validActiveCycle) {
    return validActiveCycle;
  }

  const bounds = getCycleBoundsForDate(now, cycleDay);
  const uniqueCycleKey = await generateUniqueCycleKey(employeeId, bounds.cycleKey, undefined, session);

  const baseMilestones: ICycleMilestoneSnapshot[] = [...config.milestones]
    .sort((a, b) => a.amountPaise - b.amountPaise)
    .map((m, idx) => ({
      order: idx + 1,
      amountPaise: m.amountPaise,
      label: m.label,
      defaultIncentivePaise: m.defaultIncentivePaise,
    }));

  const targetSetup = buildMilestonesWithCustomInitial(
    baseMilestones,
    profile?.customTargetAmountPaise || config.initialTargetPaise
  );

  const currentCycle = new TargetCycle({
    cycleKey: uniqueCycleKey,
    label: bounds.label,
    employeeId,
    employeeProfileId,
    startDateIST: bounds.startDateIST,
    endDateIST: bounds.endDateIST,
    startTimestamp: bounds.startTimestamp,
    endTimestamp: bounds.endTimestamp,
    initialTargetPaise: targetSetup.initialTargetPaise,
    currentTargetPaise: targetSetup.initialTargetPaise,
    milestonesSnapshot: targetSetup.milestonesSnapshot,
    totalSalesPaise: 0,
    totalCommissionPaise: 0,
    totalIncentivesPaise: 0,
    withdrawnPaise: 0,
    status: 'active',
    visibilityStartAt: closedAny ? now : bounds.startTimestamp,
  });

  await currentCycle.save({ session: session || undefined });

  if (closedAny) {
    await createNotification({
      recipientId: employeeId,
      recipientRole: 'employee',
      type: 'CYCLE_STARTED',
      title: 'New Target Cycle Started',
      message: `Your new target cycle (${bounds.label}) is now active. Target: ₹${(targetSetup.initialTargetPaise / 100).toLocaleString('en-IN')}.`,
      metadata: { cycleKey: uniqueCycleKey },
      session,
    });
  }

  return currentCycle;
}

export async function updateEmployeeTargetCycle(params: {
  employeeId: Types.ObjectId | string;
  targetCycleDay?: number;
  startDateIST?: string;
  endDateIST?: string;
  targetAmountPaise?: number;
  completeCurrentCycle?: boolean;
  session?: ClientSession | null;
}): Promise<ITargetCycle> {
  const now = new Date();
  const profile = await EmployeeProfile.findOne({
    userId: params.employeeId,
    isDeleted: false,
  }).session(params.session || null);

  if (!profile) {
    throw Object.assign(new Error('Employee profile not found'), { statusCode: 404 });
  }

  if (params.targetCycleDay !== undefined && Number.isFinite(params.targetCycleDay)) {
    profile.targetCycleDay = Math.max(1, Math.min(28, Math.round(params.targetCycleDay)));
  }
  if (params.targetAmountPaise !== undefined && Number.isFinite(params.targetAmountPaise) && params.targetAmountPaise > 0) {
    profile.customTargetAmountPaise = Math.round(params.targetAmountPaise);
  }
  await profile.save({ session: params.session || undefined });

  let activeCycle = await ensureActiveCycleForEmployee(
    profile.userId,
    profile._id,
    params.session,
    now
  );

  // If Admin chose to complete current cycle & immediately start a fresh cycle
  if (params.completeCurrentCycle) {
    activeCycle.status = 'closed';
    activeCycle.closedAt = now;
    await activeCycle.save({ session: params.session || undefined });

    const settings = await getOrCreateSystemSettings(params.session);
    const config = await getOrCreateTargetConfig(params.session);
    const cycleDay = profile.targetCycleDay || settings.withdrawalDayOfMonth || 20;
    const istToday = getISTParts(now).dateStr;

    const startDateIST = params.startDateIST || istToday;
    let endDateIST = params.endDateIST;
    if (!endDateIST) {
      const nextBounds = getCycleBoundsForDate(now, cycleDay);
      endDateIST =
        nextBounds.endDateIST > startDateIST
          ? nextBounds.endDateIST
          : getCycleBoundsForDate(new Date(now.getTime() + 31 * 24 * 60 * 60 * 1000), cycleDay).endDateIST;
    }

    const startTimestamp = parseISTDateStart(startDateIST);
    const endTimestamp = parseISTDateStart(endDateIST);
    if (endTimestamp.getTime() <= now.getTime()) {
      throw Object.assign(new Error('New cycle end date must be in the future.'), { statusCode: 400 });
    }

    const baseKey = `${startDateIST}_to_${endDateIST}`;
    const uniqueKey = await generateUniqueCycleKey(profile.userId, baseKey, undefined, params.session);
    const label = `${formatISTDateLabel(startDateIST)} – ${formatISTDateLabel(endDateIST)}`;

    const baseMilestones: ICycleMilestoneSnapshot[] = [...config.milestones]
      .sort((a, b) => a.amountPaise - b.amountPaise)
      .map((m, idx) => ({
        order: idx + 1,
        amountPaise: m.amountPaise,
        label: m.label,
        defaultIncentivePaise: m.defaultIncentivePaise,
      }));

    const targetSetup = buildMilestonesWithCustomInitial(
      baseMilestones,
      profile.customTargetAmountPaise || config.initialTargetPaise
    );

    const newCycle = new TargetCycle({
      cycleKey: uniqueKey,
      label,
      employeeId: profile.userId,
      employeeProfileId: profile._id,
      startDateIST,
      endDateIST,
      startTimestamp,
      endTimestamp,
      initialTargetPaise: targetSetup.initialTargetPaise,
      currentTargetPaise: targetSetup.initialTargetPaise,
      milestonesSnapshot: targetSetup.milestonesSnapshot,
      totalSalesPaise: 0,
      totalCommissionPaise: 0,
      totalIncentivesPaise: 0,
      withdrawnPaise: 0,
      status: 'active',
      visibilityStartAt: now,
    });

    await newCycle.save({ session: params.session || undefined });

    await createNotification({
      recipientId: profile.userId,
      recipientRole: 'employee',
      type: 'CYCLE_STARTED',
      title: 'New Target Cycle Started',
      message: `Your previous cycle was completed. New target cycle (${label}) is now active.`,
      metadata: { cycleKey: uniqueKey },
      session: params.session,
    });

    return newCycle;
  }

  // Otherwise update the existing active cycle dates / target
  const settings = await getOrCreateSystemSettings(params.session);
  const config = await getOrCreateTargetConfig(params.session);
  const cycleDay = profile.targetCycleDay || settings.withdrawalDayOfMonth || 20;

  let targetStart = params.startDateIST || activeCycle.startDateIST;
  let targetEnd = params.endDateIST || activeCycle.endDateIST;

  // If cycleDay was changed without explicit start/end dates, derive cycle bounds from cycleDay
  if (params.targetCycleDay !== undefined && !params.startDateIST && !params.endDateIST) {
    const derived = getCycleBoundsForDate(now, cycleDay);
    targetStart = derived.startDateIST;
    targetEnd = derived.endDateIST;
  }

  const startTimestamp = parseISTDateStart(targetStart);
  const endTimestamp = parseISTDateStart(targetEnd);
  if (endTimestamp.getTime() <= startTimestamp.getTime()) {
    throw Object.assign(new Error('Cycle end date must be after start date.'), { statusCode: 400 });
  }

  const baseKey = `${targetStart}_to_${targetEnd}`;
  const uniqueKey = await generateUniqueCycleKey(
    profile.userId,
    baseKey,
    activeCycle._id as Types.ObjectId,
    params.session
  );

  activeCycle.startDateIST = targetStart;
  activeCycle.endDateIST = targetEnd;
  activeCycle.startTimestamp = startTimestamp;
  activeCycle.endTimestamp = endTimestamp;
  activeCycle.cycleKey = uniqueKey;
  activeCycle.label = `${formatISTDateLabel(targetStart)} – ${formatISTDateLabel(targetEnd)}`;

  if (params.targetAmountPaise !== undefined && params.targetAmountPaise > 0) {
    const baseMilestones: ICycleMilestoneSnapshot[] = [...config.milestones]
      .sort((a, b) => a.amountPaise - b.amountPaise)
      .map((m, idx) => ({
        order: idx + 1,
        amountPaise: m.amountPaise,
        label: m.label,
        defaultIncentivePaise: m.defaultIncentivePaise,
      }));
    const targetSetup = buildMilestonesWithCustomInitial(baseMilestones, params.targetAmountPaise);
    activeCycle.initialTargetPaise = targetSetup.initialTargetPaise;
    activeCycle.milestonesSnapshot = targetSetup.milestonesSnapshot;
  }

  // If end date was moved into the past/now, close it and immediately roll over
  if (endTimestamp.getTime() <= now.getTime()) {
    activeCycle.status = 'closed';
    activeCycle.closedAt = now;
    await activeCycle.save({ session: params.session || undefined });
    return ensureActiveCycleForEmployee(profile.userId, profile._id, params.session, now);
  }

  // Recompute cycle sales & commissions from entries that fall within [startTimestamp, endTimestamp)
  // while never pulling entries that belong to already closed cycles if visibilityStartAt > startTimestamp
  const effectiveEntryStart =
    activeCycle.visibilityStartAt && activeCycle.visibilityStartAt.getTime() > startTimestamp.getTime()
      ? activeCycle.visibilityStartAt
      : startTimestamp;

  const matchingEntries = await SalesEntry.find({
    employeeId: profile.userId,
    isDeleted: false,
    entryTimestamp: { $gte: effectiveEntryStart, $lt: endTimestamp },
  }).session(params.session || null);

  let totalSalesPaise = 0;
  let totalCommissionPaise = 0;
  for (const entry of matchingEntries) {
    totalSalesPaise += entry.amountPaise;
    totalCommissionPaise += entry.commissionPaise;
    if (String(entry.cycleId) !== String(activeCycle._id) || entry.cycleKey !== activeCycle.cycleKey) {
      entry.cycleId = activeCycle._id as Types.ObjectId;
      entry.cycleKey = activeCycle.cycleKey;
      await entry.save({ session: params.session || undefined });
    }
  }

  activeCycle.totalSalesPaise = totalSalesPaise;
  activeCycle.totalCommissionPaise = totalCommissionPaise;
  const progress = computeTargetProgress(activeCycle, now);
  activeCycle.currentTargetPaise = progress.activeTargetPaise;
  await activeCycle.save({ session: params.session || undefined });

  return activeCycle;
}

export async function syncAllEmployeeCycles(): Promise<void> {
  const employees = await EmployeeProfile.find({ isDeleted: false, isActive: true }).lean();
  const now = new Date();
  for (const emp of employees) {
    await ensureActiveCycleForEmployee(emp.userId, emp._id, null, now);
  }
}

export interface TargetProgressSnapshot {
  cycleSalesPaise: number;
  initialTargetPaise: number;
  activeTargetPaise: number;
  activeTargetLabel: string;
  achievedInActiveTargetPaise: number;
  remainingForActiveTargetPaise: number;
  percentageCompleted: number;
  remainingDays: number;
  dailyRequiredSalesPaise: number;
  allMilestonesCompleted: boolean;
  milestones: Array<{
    order: number;
    amountPaise: number;
    label: string;
    status: 'completed' | 'current' | 'upcoming';
    percentage: number;
  }>;
  motivationalMessage: string;
}

export function computeTargetProgress(
  cycle: ITargetCycle,
  now: Date = new Date()
): TargetProgressSnapshot {
  const cycleSalesPaise = Math.max(0, cycle.totalSalesPaise || 0);
  const sorted = [...(cycle.milestonesSnapshot || [])].sort(
    (a, b) => a.amountPaise - b.amountPaise
  );

  const milestonesList =
    sorted.length > 0
      ? sorted
      : [
          {
            order: 1,
            amountPaise: cycle.initialTargetPaise || 50000000,
            label: '₹5 Lakh',
            defaultIncentivePaise: 50000,
          },
        ];

  let currentIdx = milestonesList.findIndex((m) => cycleSalesPaise < m.amountPaise);
  const allMilestonesCompleted = currentIdx === -1;
  if (allMilestonesCompleted) {
    currentIdx = milestonesList.length - 1;
  }

  const activeTarget = milestonesList[currentIdx];
  const activeTargetPaise = activeTarget.amountPaise;
  const remainingForActiveTargetPaise = Math.max(0, activeTargetPaise - cycleSalesPaise);
  const percentageCompleted =
    activeTargetPaise > 0
      ? Math.min(100, Math.round((cycleSalesPaise / activeTargetPaise) * 1000) / 10)
      : 100;

  const remainingDays = getRemainingDaysInCycle(new Date(cycle.endTimestamp), now);
  const dailyRequiredSalesPaise =
    remainingForActiveTargetPaise > 0
      ? Math.ceil(remainingForActiveTargetPaise / remainingDays)
      : 0;

  const milestones = milestonesList.map((m, idx) => {
    const isCompleted = cycleSalesPaise >= m.amountPaise;
    const isCurrent = !allMilestonesCompleted && idx === currentIdx;
    return {
      order: m.order,
      amountPaise: m.amountPaise,
      label: m.label,
      status: (isCompleted ? 'completed' : isCurrent ? 'current' : 'upcoming') as
        | 'completed'
        | 'current'
        | 'upcoming',
      percentage: Math.min(100, Math.round((cycleSalesPaise / m.amountPaise) * 100)),
    };
  });

  // Pick motivational message
  const completedMilestones = milestones.filter((m) => m.status === 'completed');
  let motivationalMessage = 'Great Start! Keep Going!';
  if (allMilestonesCompleted) {
    motivationalMessage = `Extraordinary! All targets up to ${activeTarget.label} completed!`;
  } else if (completedMilestones.length > 0) {
    const lastCompleted = completedMilestones[completedMilestones.length - 1];
    motivationalMessage = `Congratulations! ${lastCompleted.label} Target Completed! Your Next Goal is ${activeTarget.label}!`;
  } else if (percentageCompleted >= 80) {
    motivationalMessage = 'Just a Little More!';
  } else if (percentageCompleted >= 50) {
    motivationalMessage = '50% Target Completed!';
  } else if (cycleSalesPaise === 0) {
    motivationalMessage = 'Start strong today! Log your first sale to kick off this cycle.';
  }

  return {
    cycleSalesPaise,
    initialTargetPaise: cycle.initialTargetPaise,
    activeTargetPaise,
    activeTargetLabel: activeTarget.label,
    achievedInActiveTargetPaise: Math.min(cycleSalesPaise, activeTargetPaise),
    remainingForActiveTargetPaise,
    percentageCompleted,
    remainingDays,
    dailyRequiredSalesPaise,
    allMilestonesCompleted,
    milestones,
    motivationalMessage,
  };
}
