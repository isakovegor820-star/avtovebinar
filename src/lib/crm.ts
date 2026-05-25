export const CRM_STATUSES = [
  'new',
  'contacted',
  'consultation',
  'transferred_to_aspb',
  'contract_pending',
  'contract_signed',
  'payout_due',
  'paid',
  'lost'
] as const;

export type CrmStatus = (typeof CRM_STATUSES)[number];

export const CRM_STATUS_LABELS: Record<CrmStatus, string> = {
  new: 'Новый',
  contacted: 'Связались',
  consultation: 'Консультация',
  transferred_to_aspb: 'Передан в АСПБ',
  contract_pending: 'Договор на согласовании',
  contract_signed: 'Договор подписан',
  payout_due: 'Ожидает выплату',
  paid: 'Выплачен',
  lost: 'Потерян'
};

export function isCrmStatus(value: string): value is CrmStatus {
  return CRM_STATUSES.includes(value as CrmStatus);
}
