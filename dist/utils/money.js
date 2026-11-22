/**
 * Precision-safe integer paise financial utilities.
 * Never performs floating point arithmetic on currency balances.
 */
export function rupeesToPaise(value) {
    const str = String(value).trim().replace(/,/g, '');
    if (!/^-?\d+(\.\d{1,2})?$/.test(str)) {
        const parsed = Number(str);
        if (!Number.isFinite(parsed)) {
            throw new Error('Invalid monetary amount');
        }
        return Math.round(parsed * 100);
    }
    const negative = str.startsWith('-');
    const unsigned = negative ? str.slice(1) : str;
    const [whole, frac = ''] = unsigned.split('.');
    const paddedFrac = (frac + '00').slice(0, 2);
    const paise = parseInt(whole, 10) * 100 + parseInt(paddedFrac, 10);
    return negative ? -paise : paise;
}
export function paiseToRupees(paise) {
    return Math.round(paise) / 100;
}
export function calculateCommissionPaise(amountPaise, commissionRateBps) {
    // commissionRateBps: 100 bps = 1.00%
    return Math.round((amountPaise * commissionRateBps) / 10000);
}
export function formatINRFromPaise(paise) {
    const rupees = paiseToRupees(paise);
    const hasDecimals = Math.abs(paise % 100) !== 0;
    return new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: 'INR',
        minimumFractionDigits: hasDecimals ? 2 : 0,
        maximumFractionDigits: 2,
    }).format(rupees);
}
