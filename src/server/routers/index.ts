import { router } from '../trpc';
import { authRouter } from './auth';
import { householdRouter } from './household';
import { inviteRouter } from './invite';

export const appRouter = router({
  auth: authRouter,
  household: householdRouter,
  invite: inviteRouter,
});

export type AppRouter = typeof appRouter;
