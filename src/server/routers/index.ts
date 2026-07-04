import { router } from '../trpc';
import { adjustmentRouter } from './adjustment';
import { adminRouter } from './admin';
import { authRouter } from './auth';
import { circleRouter } from './circle';
import { connectionRouter } from './connection';
import { householdRouter } from './household';
import { inviteRouter } from './invite';
import { itemRouter, loanRouter } from './item';
import { ledgerRouter } from './ledger';
import { orderRouter } from './order';
import { pantryRouter } from './pantry';
import { planRouter } from './plan';
import { productRouter } from './product';
import { pushRouter } from './push';
import { recipeRouter } from './recipe';
import { shoppingRouter } from './shopping';
import { restockRouter } from './restock';
import { shareRouter } from './share';
import { takeRouter } from './take';

export const appRouter = router({
  adjustment: adjustmentRouter,
  admin: adminRouter,
  auth: authRouter,
  circle: circleRouter,
  connection: connectionRouter,
  household: householdRouter,
  invite: inviteRouter,
  item: itemRouter,
  ledger: ledgerRouter,
  loan: loanRouter,
  order: orderRouter,
  pantry: pantryRouter,
  plan: planRouter,
  product: productRouter,
  push: pushRouter,
  recipe: recipeRouter,
  restock: restockRouter,
  share: shareRouter,
  shopping: shoppingRouter,
  take: takeRouter,
});

export type AppRouter = typeof appRouter;
