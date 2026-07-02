import { router } from '../trpc';
import { authRouter } from './auth';
import { householdRouter } from './household';
import { inviteRouter } from './invite';
import { productRouter } from './product';
import { restockRouter } from './restock';
import { takeRouter } from './take';

export const appRouter = router({
  auth: authRouter,
  household: householdRouter,
  invite: inviteRouter,
  product: productRouter,
  restock: restockRouter,
  take: takeRouter,
});

export type AppRouter = typeof appRouter;
