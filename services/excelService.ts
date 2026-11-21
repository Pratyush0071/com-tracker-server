import ExcelJS from 'exceljs';
import { paiseToRupees } from '../utils/money.ts';

const INR_CURRENCY_FORMAT = '"₹"#,##,##0.00';

function styleHeaderRow(sheet: ExcelJS.Worksheet, rowNumber: number = 1) {
  const row = sheet.getRow(rowNumber);
  row.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  row.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF0F172A' },
  };
  row.alignment = { vertical: 'middle', horizontal: 'left' };
  row.height = 26;
}

function autoFitColumns(sheet: ExcelJS.Worksheet) {
  sheet.columns.forEach((column) => {
    let maxLength = 12;
    column.eachCell?.({ includeEmpty: true }, (cell) => {
      const value = cell.value;
      const len = value ? String(value).length : 0;
      if (len > maxLength) {
        maxLength = len;
      }
    });
    column.width = Math.min(maxLength + 5, 42);
  });
}

function addTotalsRow(
  sheet: ExcelJS.Worksheet,
  values: Record<string, string | number>,
  currencyKeys: string[]
) {
  const row = sheet.addRow(values);
  row.font = { bold: true, size: 11 };
  row.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFF1F5F9' },
  };
  currencyKeys.forEach((key) => {
    const cell = row.getCell(key);
    cell.numFmt = INR_CURRENCY_FORMAT;
  });
}

export async function buildSalesEntriesWorkbook(params: {
  title: string;
  entries: Array<{
    entryDateIST: string;
    entryTimeIST: string;
    employeeCode?: string;
    employeeName?: string;
    orderName: string;
    productName: string;
    amountPaise: number;
    commissionPaise: number;
    status: string;
    cycleKey: string;
  }>;
  includeEmployeeColumns?: boolean;
  includeCommissionColumn?: boolean;
}): Promise<Buffer> {
  const showCommission = params.includeCommissionColumn !== false;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Commission Tracker';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet(params.title.slice(0, 31));

  const columns: Partial<ExcelJS.Column>[] = [
    { header: 'S.No', key: 'sno' },
    { header: 'Date (IST)', key: 'date' },
    { header: 'Time (IST)', key: 'time' },
  ];

  if (params.includeEmployeeColumns) {
    columns.push(
      { header: 'Employee ID', key: 'employeeCode' },
      { header: 'Employee Name', key: 'employeeName' }
    );
  }

  columns.push(
    { header: 'Order / Place Name', key: 'orderName' },
    { header: 'Product Name', key: 'productName' },
    { header: 'Amount (INR)', key: 'amount' }
  );

  if (showCommission) {
    columns.push({ header: 'Commission (INR)', key: 'commission' });
  }

  columns.push(
    { header: 'Status', key: 'status' },
    { header: 'Target Cycle', key: 'cycleKey' }
  );

  sheet.columns = columns;
  styleHeaderRow(sheet, 1);

  let totalAmountPaise = 0;
  let totalCommissionPaise = 0;

  params.entries.forEach((entry, idx) => {
    totalAmountPaise += entry.amountPaise;
    totalCommissionPaise += entry.commissionPaise;

    const rowData: Record<string, string | number> = {
      sno: idx + 1,
      date: entry.entryDateIST,
      time: entry.entryTimeIST,
      employeeCode: entry.employeeCode || '',
      employeeName: entry.employeeName || '',
      orderName: entry.orderName || '-',
      productName: entry.productName || '-',
      amount: paiseToRupees(entry.amountPaise),
      status: entry.status.toUpperCase(),
      cycleKey: entry.cycleKey,
    };

    if (showCommission) {
      rowData.commission = paiseToRupees(entry.commissionPaise);
    }

    const row = sheet.addRow(rowData);

    row.getCell('amount').numFmt = INR_CURRENCY_FORMAT;
    if (showCommission) {
      row.getCell('commission').numFmt = INR_CURRENCY_FORMAT;
    }
  });

  const totalsData: Record<string, string | number> = {
    sno: 'TOTAL',
    date: `${params.entries.length} Entries`,
    amount: paiseToRupees(totalAmountPaise),
  };
  const currencyKeys = ['amount'];
  if (showCommission) {
    totalsData.commission = paiseToRupees(totalCommissionPaise);
    currencyKeys.push('commission');
  }

  addTotalsRow(sheet, totalsData, currencyKeys);

  autoFitColumns(sheet);
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

export async function buildIndividualEmployeeWorkbook(params: {
  employee: {
    employeeCode: string;
    fullName: string;
    email: string;
    mobile: string;
    joiningDate: string;
    lifetimeSalesPaise: number;
    totalCommissionPaise: number;
    totalIncentivesPaise: number;
    totalWithdrawnPaise: number;
    availableBalancePaise: number;
  };
  entries: Array<{
    entryDateIST: string;
    entryTimeIST: string;
    orderName: string;
    productName: string;
    amountPaise: number;
    commissionPaise: number;
    status: string;
    cycleKey: string;
  }>;
  commissions: Array<{
    createdAt: Date;
    type: string;
    rateBps: number;
    baseAmountPaise: number;
    amountPaise: number;
    description: string;
  }>;
  incentives: Array<{
    createdAt: Date;
    category: string;
    amountPaise: number;
    reason: string;
    authorizedByAdminName: string;
  }>;
  withdrawals: Array<{
    requestDateIST: string;
    amountPaise: number;
    status: string;
    paymentMethod?: string;
    paymentReference?: string;
    rejectionReason?: string;
  }>;
  achievements: Array<{
    cycleKey: string;
    milestoneLabel: string;
    milestoneAmountPaise: number;
    achievedAtSalesPaise: number;
    achievedAt: Date;
    incentiveGranted: boolean;
  }>;
}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'LakshyaSales';

  // Sheet 1: Profile & Financial Overview
  const overview = workbook.addWorksheet('Employee Overview');
  overview.columns = [
    { header: 'Field', key: 'field' },
    { header: 'Value', key: 'value' },
  ];
  styleHeaderRow(overview, 1);

  const overviewRows: Array<{ field: string; value: string | number; isCurrency?: boolean }> = [
    { field: 'Employee ID', value: params.employee.employeeCode },
    { field: 'Employee Name', value: params.employee.fullName },
    { field: 'Email', value: params.employee.email },
    { field: 'Mobile', value: params.employee.mobile },
    { field: 'Joining Date', value: params.employee.joiningDate },
    { field: 'Lifetime Sales', value: paiseToRupees(params.employee.lifetimeSalesPaise), isCurrency: true },
    { field: 'Total Commission', value: paiseToRupees(params.employee.totalCommissionPaise), isCurrency: true },
    { field: 'Total Incentives', value: paiseToRupees(params.employee.totalIncentivesPaise), isCurrency: true },
    { field: 'Total Withdrawn (Paid)', value: paiseToRupees(params.employee.totalWithdrawnPaise), isCurrency: true },
    { field: 'Available Balance', value: paiseToRupees(params.employee.availableBalancePaise), isCurrency: true },
  ];

  overviewRows.forEach((item) => {
    const r = overview.addRow({ field: item.field, value: item.value });
    if (item.isCurrency) {
      r.getCell('value').numFmt = INR_CURRENCY_FORMAT;
    }
  });
  autoFitColumns(overview);

  // Sheet 2: Sales History
  const salesSheet = workbook.addWorksheet('Sales History');
  salesSheet.columns = [
    { header: 'S.No', key: 'sno' },
    { header: 'Date (IST)', key: 'date' },
    { header: 'Time (IST)', key: 'time' },
    { header: 'Order / Place', key: 'orderName' },
    { header: 'Product', key: 'productName' },
    { header: 'Amount (INR)', key: 'amount' },
    { header: 'Commission (INR)', key: 'commission' },
    { header: 'Status', key: 'status' },
    { header: 'Cycle', key: 'cycleKey' },
  ];
  styleHeaderRow(salesSheet, 1);
  let totalSales = 0;
  params.entries.forEach((e, idx) => {
    totalSales += e.amountPaise;
    const r = salesSheet.addRow({
      sno: idx + 1,
      date: e.entryDateIST,
      time: e.entryTimeIST,
      orderName: e.orderName || '-',
      productName: e.productName || '-',
      amount: paiseToRupees(e.amountPaise),
      commission: paiseToRupees(e.commissionPaise),
      status: e.status.toUpperCase(),
      cycleKey: e.cycleKey,
    });
    r.getCell('amount').numFmt = INR_CURRENCY_FORMAT;
    r.getCell('commission').numFmt = INR_CURRENCY_FORMAT;
  });
  addTotalsRow(salesSheet, { sno: 'TOTAL', amount: paiseToRupees(totalSales) }, ['amount']);
  autoFitColumns(salesSheet);

  // Sheet 3: Commission & Incentives
  const earnSheet = workbook.addWorksheet('Commission & Incentives');
  earnSheet.columns = [
    { header: 'Date', key: 'date' },
    { header: 'Type', key: 'type' },
    { header: 'Amount (INR)', key: 'amount' },
    { header: 'Details / Reason', key: 'details' },
  ];
  styleHeaderRow(earnSheet, 1);
  params.commissions.forEach((c) => {
    const r = earnSheet.addRow({
      date: new Date(c.createdAt).toISOString().slice(0, 10),
      type: `Commission (${c.type})`,
      amount: paiseToRupees(c.amountPaise),
      details: c.description,
    });
    r.getCell('amount').numFmt = INR_CURRENCY_FORMAT;
  });
  params.incentives.forEach((inc) => {
    const r = earnSheet.addRow({
      date: new Date(inc.createdAt).toISOString().slice(0, 10),
      type: `Incentive (${inc.category})`,
      amount: paiseToRupees(inc.amountPaise),
      details: `${inc.reason} (By ${inc.authorizedByAdminName})`,
    });
    r.getCell('amount').numFmt = INR_CURRENCY_FORMAT;
  });
  autoFitColumns(earnSheet);

  // Sheet 4: Withdrawals
  const wSheet = workbook.addWorksheet('Withdrawals');
  wSheet.columns = [
    { header: 'Request Date', key: 'date' },
    { header: 'Amount (INR)', key: 'amount' },
    { header: 'Status', key: 'status' },
    { header: 'Payment Method', key: 'method' },
    { header: 'Reference / Reason', key: 'ref' },
  ];
  styleHeaderRow(wSheet, 1);
  params.withdrawals.forEach((w) => {
    const r = wSheet.addRow({
      date: w.requestDateIST,
      amount: paiseToRupees(w.amountPaise),
      status: w.status.toUpperCase(),
      method: w.paymentMethod || '-',
      ref: w.paymentReference || w.rejectionReason || '-',
    });
    r.getCell('amount').numFmt = INR_CURRENCY_FORMAT;
  });
  autoFitColumns(wSheet);

  // Sheet 5: Target Achievements
  const achSheet = workbook.addWorksheet('Target Achievements');
  achSheet.columns = [
    { header: 'Cycle', key: 'cycle' },
    { header: 'Milestone', key: 'milestone' },
    { header: 'Target Amount (INR)', key: 'targetAmount' },
    { header: 'Achieved At Sales (INR)', key: 'achievedSales' },
    { header: 'Achieved Date', key: 'achievedDate' },
    { header: 'Incentive Granted', key: 'incentiveGranted' },
  ];
  styleHeaderRow(achSheet, 1);
  params.achievements.forEach((a) => {
    const r = achSheet.addRow({
      cycle: a.cycleKey,
      milestone: a.milestoneLabel,
      targetAmount: paiseToRupees(a.milestoneAmountPaise),
      achievedSales: paiseToRupees(a.achievedAtSalesPaise),
      achievedDate: new Date(a.achievedAt).toISOString().slice(0, 10),
      incentiveGranted: a.incentiveGranted ? 'Yes' : 'No',
    });
    r.getCell('targetAmount').numFmt = INR_CURRENCY_FORMAT;
    r.getCell('achievedSales').numFmt = INR_CURRENCY_FORMAT;
  });
  autoFitColumns(achSheet);

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

export interface AllEmployeesExportData {
  employeeSummaries: Array<{
    employeeCode: string;
    fullName: string;
    totalEntries: number;
    todaySalesPaise: number;
    yesterdaySalesPaise: number;
    currentMonthSalesPaise: number;
    previousMonthSalesPaise: number;
    currentCycleSalesPaise: number;
    lifetimeSalesPaise: number;
    commissionEarnedPaise: number;
    incentivesEarnedPaise: number;
    totalEarningsPaise: number;
    withdrawnAmountPaise: number;
    availableBalancePaise: number;
    currentTargetPaise: number;
    targetAchievementPercent: number;
  }>;
  salesEntries: Array<{
    entryDateIST: string;
    entryTimeIST: string;
    employeeCode: string;
    employeeName: string;
    orderName: string;
    productName: string;
    amountPaise: number;
    commissionPaise: number;
    status: string;
    cycleKey: string;
  }>;
  dailySummaries: Array<{
    date: string;
    entryCount: number;
    totalSalesPaise: number;
    totalCommissionPaise: number;
  }>;
  monthlySummaries: Array<{
    month: string;
    entryCount: number;
    totalSalesPaise: number;
    totalCommissionPaise: number;
  }>;
  commissionAndIncentives: Array<{
    employeeCode: string;
    employeeName: string;
    salesCommissionPaise: number;
    targetIncentivesPaise: number;
    otherIncentivesPaise: number;
    totalIncentivesPaise: number;
    totalEarningsPaise: number;
  }>;
  withdrawals: Array<{
    requestDateIST: string;
    employeeCode: string;
    employeeName: string;
    amountPaise: number;
    status: string;
    paymentMethod: string;
    paymentReference: string;
    rejectionReason: string;
  }>;
  achievements: Array<{
    employeeCode: string;
    employeeName: string;
    cycleKey: string;
    milestoneLabel: string;
    milestoneAmountPaise: number;
    achievedAtSalesPaise: number;
    achievedDate: string;
    incentiveGranted: boolean;
  }>;
}

export async function buildAllEmployeesCompanyWorkbook(
  data: AllEmployeesExportData
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'LakshyaSales';
  workbook.created = new Date();

  // Sheet 1: Employee Summary
  const s1 = workbook.addWorksheet('Employee Summary');
  s1.columns = [
    { header: 'Employee ID', key: 'employeeCode' },
    { header: 'Employee Name', key: 'fullName' },
    { header: 'Total Entries', key: 'totalEntries' },
    { header: "Today's Sales", key: 'todaySales' },
    { header: "Yesterday's Sales", key: 'yesterdaySales' },
    { header: 'Current Month Sales', key: 'currentMonthSales' },
    { header: 'Previous Month Sales', key: 'previousMonthSales' },
    { header: 'Current Target Cycle Sales', key: 'currentCycleSales' },
    { header: 'Lifetime Sales', key: 'lifetimeSales' },
    { header: 'Commission Earned', key: 'commissionEarned' },
    { header: 'Incentives Earned', key: 'incentivesEarned' },
    { header: 'Total Earnings', key: 'totalEarnings' },
    { header: 'Withdrawn Amount', key: 'withdrawnAmount' },
    { header: 'Available Balance', key: 'availableBalance' },
    { header: 'Current Target', key: 'currentTarget' },
    { header: 'Target Achievement %', key: 'targetPct' },
  ];
  styleHeaderRow(s1, 1);

  const s1Totals = {
    totalEntries: 0,
    todaySales: 0,
    yesterdaySales: 0,
    currentMonthSales: 0,
    previousMonthSales: 0,
    currentCycleSales: 0,
    lifetimeSales: 0,
    commissionEarned: 0,
    incentivesEarned: 0,
    totalEarnings: 0,
    withdrawnAmount: 0,
    availableBalance: 0,
  };

  data.employeeSummaries.forEach((emp) => {
    const rowObj = {
      employeeCode: emp.employeeCode,
      fullName: emp.fullName,
      totalEntries: emp.totalEntries,
      todaySales: paiseToRupees(emp.todaySalesPaise),
      yesterdaySales: paiseToRupees(emp.yesterdaySalesPaise),
      currentMonthSales: paiseToRupees(emp.currentMonthSalesPaise),
      previousMonthSales: paiseToRupees(emp.previousMonthSalesPaise),
      currentCycleSales: paiseToRupees(emp.currentCycleSalesPaise),
      lifetimeSales: paiseToRupees(emp.lifetimeSalesPaise),
      commissionEarned: paiseToRupees(emp.commissionEarnedPaise),
      incentivesEarned: paiseToRupees(emp.incentivesEarnedPaise),
      totalEarnings: paiseToRupees(emp.totalEarningsPaise),
      withdrawnAmount: paiseToRupees(emp.withdrawnAmountPaise),
      availableBalance: paiseToRupees(emp.availableBalancePaise),
      currentTarget: paiseToRupees(emp.currentTargetPaise),
      targetPct: `${emp.targetAchievementPercent}%`,
    };
    s1Totals.totalEntries += emp.totalEntries;
    s1Totals.todaySales += rowObj.todaySales;
    s1Totals.yesterdaySales += rowObj.yesterdaySales;
    s1Totals.currentMonthSales += rowObj.currentMonthSales;
    s1Totals.previousMonthSales += rowObj.previousMonthSales;
    s1Totals.currentCycleSales += rowObj.currentCycleSales;
    s1Totals.lifetimeSales += rowObj.lifetimeSales;
    s1Totals.commissionEarned += rowObj.commissionEarned;
    s1Totals.incentivesEarned += rowObj.incentivesEarned;
    s1Totals.totalEarnings += rowObj.totalEarnings;
    s1Totals.withdrawnAmount += rowObj.withdrawnAmount;
    s1Totals.availableBalance += rowObj.availableBalance;

    const r = s1.addRow(rowObj);
    [
      'todaySales',
      'yesterdaySales',
      'currentMonthSales',
      'previousMonthSales',
      'currentCycleSales',
      'lifetimeSales',
      'commissionEarned',
      'incentivesEarned',
      'totalEarnings',
      'withdrawnAmount',
      'availableBalance',
      'currentTarget',
    ].forEach((k) => {
      r.getCell(k).numFmt = INR_CURRENCY_FORMAT;
    });
  });

  addTotalsRow(
    s1,
    {
      employeeCode: 'TOTAL',
      fullName: `${data.employeeSummaries.length} Employees`,
      ...s1Totals,
    },
    [
      'todaySales',
      'yesterdaySales',
      'currentMonthSales',
      'previousMonthSales',
      'currentCycleSales',
      'lifetimeSales',
      'commissionEarned',
      'incentivesEarned',
      'totalEarnings',
      'withdrawnAmount',
      'availableBalance',
    ]
  );
  autoFitColumns(s1);

  // Sheet 2: Complete Sales Entries
  const s2 = workbook.addWorksheet('Complete Sales Entries');
  s2.columns = [
    { header: 'S.No', key: 'sno' },
    { header: 'Date (IST)', key: 'date' },
    { header: 'Time (IST)', key: 'time' },
    { header: 'Employee ID', key: 'employeeCode' },
    { header: 'Employee Name', key: 'employeeName' },
    { header: 'Order / Place Name', key: 'orderName' },
    { header: 'Product Name', key: 'productName' },
    { header: 'Amount', key: 'amount' },
    { header: 'Commission', key: 'commission' },
    { header: 'Status', key: 'status' },
    { header: 'Target Cycle', key: 'cycleKey' },
  ];
  styleHeaderRow(s2, 1);
  let s2TotalAmount = 0;
  let s2TotalComm = 0;
  data.salesEntries.forEach((e, idx) => {
    const amt = paiseToRupees(e.amountPaise);
    const comm = paiseToRupees(e.commissionPaise);
    s2TotalAmount += amt;
    s2TotalComm += comm;
    const r = s2.addRow({
      sno: idx + 1,
      date: e.entryDateIST,
      time: e.entryTimeIST,
      employeeCode: e.employeeCode,
      employeeName: e.employeeName,
      orderName: e.orderName || '-',
      productName: e.productName || '-',
      amount: amt,
      commission: comm,
      status: e.status.toUpperCase(),
      cycleKey: e.cycleKey,
    });
    r.getCell('amount').numFmt = INR_CURRENCY_FORMAT;
    r.getCell('commission').numFmt = INR_CURRENCY_FORMAT;
  });
  addTotalsRow(
    s2,
    { sno: 'TOTAL', date: `${data.salesEntries.length} Entries`, amount: s2TotalAmount, commission: s2TotalComm },
    ['amount', 'commission']
  );
  autoFitColumns(s2);

  // Sheet 3: Daily Sales Summary
  const s3 = workbook.addWorksheet('Daily Sales Summary');
  s3.columns = [
    { header: 'Date (IST)', key: 'date' },
    { header: 'Total Entries', key: 'entryCount' },
    { header: 'Total Sales', key: 'totalSales' },
    { header: 'Total Commission', key: 'totalCommission' },
  ];
  styleHeaderRow(s3, 1);
  let s3TotalSales = 0;
  let s3TotalComm = 0;
  data.dailySummaries.forEach((d) => {
    const sales = paiseToRupees(d.totalSalesPaise);
    const comm = paiseToRupees(d.totalCommissionPaise);
    s3TotalSales += sales;
    s3TotalComm += comm;
    const r = s3.addRow({
      date: d.date,
      entryCount: d.entryCount,
      totalSales: sales,
      totalCommission: comm,
    });
    r.getCell('totalSales').numFmt = INR_CURRENCY_FORMAT;
    r.getCell('totalCommission').numFmt = INR_CURRENCY_FORMAT;
  });
  addTotalsRow(s3, { date: 'TOTAL', totalSales: s3TotalSales, totalCommission: s3TotalComm }, [
    'totalSales',
    'totalCommission',
  ]);
  autoFitColumns(s3);

  // Sheet 4: Monthly Sales Summary
  const s4 = workbook.addWorksheet('Monthly Sales Summary');
  s4.columns = [
    { header: 'Month (YYYY-MM)', key: 'month' },
    { header: 'Total Entries', key: 'entryCount' },
    { header: 'Total Sales', key: 'totalSales' },
    { header: 'Total Commission', key: 'totalCommission' },
  ];
  styleHeaderRow(s4, 1);
  let s4TotalSales = 0;
  let s4TotalComm = 0;
  data.monthlySummaries.forEach((m) => {
    const sales = paiseToRupees(m.totalSalesPaise);
    const comm = paiseToRupees(m.totalCommissionPaise);
    s4TotalSales += sales;
    s4TotalComm += comm;
    const r = s4.addRow({
      month: m.month,
      entryCount: m.entryCount,
      totalSales: sales,
      totalCommission: comm,
    });
    r.getCell('totalSales').numFmt = INR_CURRENCY_FORMAT;
    r.getCell('totalCommission').numFmt = INR_CURRENCY_FORMAT;
  });
  addTotalsRow(s4, { month: 'TOTAL', totalSales: s4TotalSales, totalCommission: s4TotalComm }, [
    'totalSales',
    'totalCommission',
  ]);
  autoFitColumns(s4);

  // Sheet 5: Commission & Incentives
  const s5 = workbook.addWorksheet('Commission & Incentives');
  s5.columns = [
    { header: 'Employee ID', key: 'employeeCode' },
    { header: 'Employee Name', key: 'employeeName' },
    { header: 'Sales Commission', key: 'salesCommission' },
    { header: 'Target Completion Incentives', key: 'targetIncentives' },
    { header: 'Other Incentives', key: 'otherIncentives' },
    { header: 'Total Incentives', key: 'totalIncentives' },
    { header: 'Total Earnings', key: 'totalEarnings' },
  ];
  styleHeaderRow(s5, 1);
  let s5Comm = 0;
  let s5TargetInc = 0;
  let s5OtherInc = 0;
  let s5TotalInc = 0;
  let s5TotalEarn = 0;
  data.commissionAndIncentives.forEach((c) => {
    const rowObj = {
      employeeCode: c.employeeCode,
      employeeName: c.employeeName,
      salesCommission: paiseToRupees(c.salesCommissionPaise),
      targetIncentives: paiseToRupees(c.targetIncentivesPaise),
      otherIncentives: paiseToRupees(c.otherIncentivesPaise),
      totalIncentives: paiseToRupees(c.totalIncentivesPaise),
      totalEarnings: paiseToRupees(c.totalEarningsPaise),
    };
    s5Comm += rowObj.salesCommission;
    s5TargetInc += rowObj.targetIncentives;
    s5OtherInc += rowObj.otherIncentives;
    s5TotalInc += rowObj.totalIncentives;
    s5TotalEarn += rowObj.totalEarnings;
    const r = s5.addRow(rowObj);
    ['salesCommission', 'targetIncentives', 'otherIncentives', 'totalIncentives', 'totalEarnings'].forEach(
      (k) => {
        r.getCell(k).numFmt = INR_CURRENCY_FORMAT;
      }
    );
  });
  addTotalsRow(
    s5,
    {
      employeeCode: 'TOTAL',
      salesCommission: s5Comm,
      targetIncentives: s5TargetInc,
      otherIncentives: s5OtherInc,
      totalIncentives: s5TotalInc,
      totalEarnings: s5TotalEarn,
    },
    ['salesCommission', 'targetIncentives', 'otherIncentives', 'totalIncentives', 'totalEarnings']
  );
  autoFitColumns(s5);

  // Sheet 6: Withdrawal History
  const s6 = workbook.addWorksheet('Withdrawal History');
  s6.columns = [
    { header: 'Request Date (IST)', key: 'date' },
    { header: 'Employee ID', key: 'employeeCode' },
    { header: 'Employee Name', key: 'employeeName' },
    { header: 'Amount', key: 'amount' },
    { header: 'Status', key: 'status' },
    { header: 'Payment Method', key: 'method' },
    { header: 'Payment Reference', key: 'reference' },
    { header: 'Rejection Reason', key: 'rejectionReason' },
  ];
  styleHeaderRow(s6, 1);
  let s6Total = 0;
  data.withdrawals.forEach((w) => {
    const amt = paiseToRupees(w.amountPaise);
    s6Total += amt;
    const r = s6.addRow({
      date: w.requestDateIST,
      employeeCode: w.employeeCode,
      employeeName: w.employeeName,
      amount: amt,
      status: w.status.toUpperCase(),
      method: w.paymentMethod || '-',
      reference: w.paymentReference || '-',
      rejectionReason: w.rejectionReason || '-',
    });
    r.getCell('amount').numFmt = INR_CURRENCY_FORMAT;
  });
  addTotalsRow(s6, { date: 'TOTAL', amount: s6Total }, ['amount']);
  autoFitColumns(s6);

  // Sheet 7: Target Achievement
  const s7 = workbook.addWorksheet('Target Achievement');
  s7.columns = [
    { header: 'Employee ID', key: 'employeeCode' },
    { header: 'Employee Name', key: 'employeeName' },
    { header: 'Target Cycle', key: 'cycleKey' },
    { header: 'Milestone', key: 'milestoneLabel' },
    { header: 'Milestone Target', key: 'milestoneAmount' },
    { header: 'Achieved At Sales', key: 'achievedAtSales' },
    { header: 'Achieved Date', key: 'achievedDate' },
    { header: 'Incentive Granted', key: 'incentiveGranted' },
  ];
  styleHeaderRow(s7, 1);
  data.achievements.forEach((a) => {
    const r = s7.addRow({
      employeeCode: a.employeeCode,
      employeeName: a.employeeName,
      cycleKey: a.cycleKey,
      milestoneLabel: a.milestoneLabel,
      milestoneAmount: paiseToRupees(a.milestoneAmountPaise),
      achievedAtSales: paiseToRupees(a.achievedAtSalesPaise),
      achievedDate: a.achievedDate,
      incentiveGranted: a.incentiveGranted ? 'Yes' : 'No',
    });
    r.getCell('milestoneAmount').numFmt = INR_CURRENCY_FORMAT;
    r.getCell('achievedAtSales').numFmt = INR_CURRENCY_FORMAT;
  });
  autoFitColumns(s7);

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
