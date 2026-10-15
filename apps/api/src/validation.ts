import { AppError } from '@livechat/shared';

/** Map zod errors to our 400 wire format. */
export function parse<T>(
  schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: any } },
  body: unknown,
): T {
  const res = schema.safeParse(body);
  if (!res.success) {
    throw new AppError('validation_failed', 'Validation failed', 400, res.error?.issues);
  }
  return res.data as T;
}
