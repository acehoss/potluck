import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeIngredientName, parseIngredientLine, parseRecipeText } from './recipe-parse';

test('parseIngredientLine: unicode fraction as amount', () => {
  const ing = parseIngredientLine('½ cup sugar');
  assert.equal(ing.kind, 'item');
  assert.equal(ing.amount, '½');
  assert.equal(ing.unit, 'cup');
  assert.equal(ing.text, 'sugar');
});

test('parseIngredientLine: integer glued to a unicode fraction', () => {
  const ing = parseIngredientLine('1½ cups milk');
  assert.equal(ing.amount, '1½');
  assert.equal(ing.unit, 'cups');
  assert.equal(ing.text, 'milk');
});

test('parseIngredientLine: mixed number + unit + trailing note after comma', () => {
  const ing = parseIngredientLine('1 1/2 cups flour, sifted');
  assert.equal(ing.kind, 'item');
  assert.equal(ing.amount, '1 1/2');
  assert.equal(ing.unit, 'cups');
  assert.equal(ing.text, 'flour');
  assert.equal(ing.note, 'sifted');
});

test('parseIngredientLine: a range amount', () => {
  const ing = parseIngredientLine('2-3 cloves garlic');
  assert.equal(ing.amount, '2-3');
  assert.equal(ing.unit, 'cloves');
  assert.equal(ing.text, 'garlic');
});

test('parseIngredientLine: "2 to 3" word range', () => {
  const ing = parseIngredientLine('2 to 3 tablespoons olive oil');
  assert.equal(ing.amount, '2 to 3');
  assert.equal(ing.unit, 'tablespoons');
  assert.equal(ing.text, 'olive oil');
});

test('parseIngredientLine: decimal amount, no known unit', () => {
  const ing = parseIngredientLine('1.5 large eggs');
  assert.equal(ing.amount, '1.5');
  assert.equal(ing.unit, undefined);
  assert.equal(ing.text, 'large eggs');
});

test('parseIngredientLine: parenthetical becomes the note', () => {
  const ing = parseIngredientLine('2 cans diced tomatoes (14 oz)');
  assert.equal(ing.amount, '2');
  assert.equal(ing.unit, 'cans');
  assert.equal(ing.text, 'diced tomatoes');
  assert.equal(ing.note, '14 oz');
});

test('parseIngredientLine: bare item with no amount', () => {
  const ing = parseIngredientLine('Salt and pepper to taste');
  assert.equal(ing.kind, 'item');
  assert.equal(ing.amount, undefined);
  assert.equal(ing.unit, undefined);
  assert.equal(ing.text, 'Salt and pepper to taste');
});

test('parseIngredientLine: heading by trailing colon', () => {
  const ing = parseIngredientLine('For the dough:');
  assert.equal(ing.kind, 'heading');
  assert.equal(ing.text, 'For the dough');
});

test('parseIngredientLine: heading by ALL CAPS', () => {
  const ing = parseIngredientLine('FOR THE TOPPING');
  assert.equal(ing.kind, 'heading');
  assert.equal(ing.text, 'FOR THE TOPPING');
});

test('parseRecipeText: ingredients then a prose directions block', () => {
  const text = [
    '2 cups flour',
    '1 tsp salt',
    '½ cup water',
    '',
    'Mix the flour and salt together in a large bowl. Slowly add the water',
    'and knead until a smooth dough forms, about ten minutes. Let it rest.',
  ].join('\n');
  const parsed = parseRecipeText(text);
  assert.equal(parsed.ingredients.length, 3);
  assert.equal(parsed.ingredients[0].text, 'flour');
  assert.equal(parsed.ingredients[2].amount, '½');
  assert.ok(parsed.directions?.startsWith('Mix the flour'));
});

test('parseRecipeText: a heading is kept inline with ingredients', () => {
  const text = ['Dough:', '2 cups flour', '1 tsp salt'].join('\n');
  const parsed = parseRecipeText(text);
  assert.equal(parsed.ingredients.length, 3);
  assert.equal(parsed.ingredients[0].kind, 'heading');
  assert.equal(parsed.ingredients[0].text, 'Dough');
  assert.equal(parsed.ingredients[1].kind, 'item');
});

test('parseRecipeText: garbage in never throws', () => {
  for (const junk of ['', '   ', '\n\n\n', ')(*&^%$#@!', 'asdf;lkj\n\n((( ', '½½½']) {
    assert.doesNotThrow(() => parseRecipeText(junk));
  }
  assert.deepEqual(parseRecipeText('').ingredients, []);
});

test('parseIngredientLine: never throws on odd input', () => {
  for (const junk of ['', '(', '1/', '- - -', '1..2 cups']) {
    assert.doesNotThrow(() => parseIngredientLine(junk));
  }
});

test('normalizeIngredientName: lowercases, collapses whitespace, trims', () => {
  assert.equal(normalizeIngredientName('  All-Purpose   FLOUR '), 'all-purpose flour');
  assert.equal(normalizeIngredientName('Kosher\tSalt'), 'kosher salt');
  assert.equal(normalizeIngredientName(''), '');
});
