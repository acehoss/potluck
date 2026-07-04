import { router } from '../trpc';
import { adjustmentRouter } from './adjustment';
import { adminRouter } from './admin';
import { authRouter } from './auth';
import { connectionRouter } from './connection';
import { householdRouter } from './household';
import { inviteRouter } from './invite';
import { itemRouter, loanRouter } from './item';
import { ledgerRouter } from './ledger';
import { orderRouter } from './order';
import { pantryRouter } from './pantry';
import { productRouter } from './product';
import { pushRouter } from './push';
import { restockRouter } from './restock';
import { shareRouter } from './share';
import { takeRouter } from './take';

export const appRouter = router({
  adjustment: adjustmentRouter,
  admin: adminRouter,
  auth: authRouter,
  connection: connectionRouter,
  household: householdRouter,
  invite: inviteRouter,
  item: itemRouter,
  ledger: ledgerRouter,
  loan: loanRouter,
  order: orderRouter,
  pantry: pantryRouter,
  product: productRouter,
  push: pushRouter,
  restock: restockRouter,
  share: shareRouter,
  take: takeRouter,
});

export type AppRouter = typeof appRouter;
