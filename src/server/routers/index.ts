import { router } from '../trpc';
import { authRouter } from './auth';
import { householdRouter } from './household';
import { inviteRouter } from './invite';
import { productRouter } from './product';
import { restockRouter } from './restock';

export const appRouter = router({
  auth: authRouter,
  household: householdRouter,
  invite: inviteRouter,
  product: productRouter,
  restock: restockRouter,
});

export type AppRouter = typeof appRouter;
