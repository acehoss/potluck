import { router } from '../trpc';
import { adjustmentRouter } from './adjustment';
import { authRouter } from './auth';
import { householdRouter } from './household';
import { inviteRouter } from './invite';
import { ledgerRouter } from './ledger';
import { productRouter } from './product';
import { restockRouter } from './restock';
import { takeRouter } from './take';

export const appRouter = router({
  adjustment: adjustmentRouter,
  auth: authRouter,
  household: householdRouter,
  invite: inviteRouter,
  ledger: ledgerRouter,
  product: productRouter,
  restock: restockRouter,
  take: takeRouter,
});

export type AppRouter = typeof appRouter;
