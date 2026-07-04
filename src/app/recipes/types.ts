/**
 * Client-side DTO mirrors for the recipe router (recipe.list / recipe.get).
 * Hand-written to match the server shapes, mirroring shares-view's FeedPost.
 */

export type IngredientLink = { productId: string; productName: string };

export type IngredientDto = {
  id: string;
  position: number;
  kind: 'item' | 'heading';
  amount: string | null;
  unit: string | null;
  text: string;
  note: string | null;
  link: IngredientLink | null;
};

export type RecipeDto = {
  id: string;
  title: string;
  description: string | null;
  directions: string | null;
  prepMinutes: number | null;
  cookMinutes: number | null;
  servings: number | null;
  yieldText: string | null;
  course: string | null;
  cuisine: string | null;
  tags: string[];
  photoPath: string | null;
  private: boolean;
  sourceUrl: string | null;
  forkedFromTitle: string | null;
  forkedFromHouseholdName: string | null;
  mine: boolean;
  householdName: string;
  ingredients: IngredientDto[];
};

/** Slim card DTO from recipe.list; householdName only present on shared rows. */
export type SlimRecipe = {
  id: string;
  title: string;
  course: string | null;
  cuisine: string | null;
  tags: string[];
  photoPath: string | null;
  servings: number | null;
  prepMinutes: number | null;
  cookMinutes: number | null;
  private: boolean;
  forkedFromTitle: string | null;
  forkedFromHouseholdName: string | null;
  householdName?: string;
};
