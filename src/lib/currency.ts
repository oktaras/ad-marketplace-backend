import { z } from 'zod';
import { config } from '../config/index.js';

const supportedCurrencySet = new Set(config.supportedCurrencies);
const currencyValidationMessage = `Currency must be one of: ${config.supportedCurrencies.join(', ')}`;

export function normalizeCurrencyInput(value: string): string {
  return value.trim().toUpperCase();
}

export function isSupportedCurrency(value: string): boolean {
  const normalized = normalizeCurrencyInput(value);
  return supportedCurrencySet.has(normalized);
}

export function validateCurrencyOrThrow(value: string): string {
  const normalized = normalizeCurrencyInput(value);
  if (!supportedCurrencySet.has(normalized)) {
    throw new Error(currencyValidationMessage);
  }

  return normalized;
}

export const requiredCurrencySchema = z
  .string()
  .trim()
  .min(1, { message: currencyValidationMessage })
  .transform((value) => normalizeCurrencyInput(value))
  .refine((value) => supportedCurrencySet.has(value), { message: currencyValidationMessage });

export const optionalCurrencySchema = z.preprocess(
  (value) => {
    if (value === undefined || value === null) {
      return undefined;
    }

    if (typeof value !== 'string') {
      return value;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  },
  requiredCurrencySchema.optional(),
);
