import categoryData from './categories.json';

/**
 * A category of worlds. Each one becomes a tower in the city. Categories are
 * data (categories.json), not code: adding an entry there adds a tower.
 */
export interface Category {
  id: string;
  name: string;
  tagline?: string;
  /** Accent colour for the tower's signage and light lines. */
  color: string;
  /** Words that suggest this category when a listing does not name one. */
  keywords: string[];
  /** Listings nothing else matches end up here. Exactly one category should set it. */
  default?: boolean;
}

export class CategoryRegistry {
  readonly list: readonly Category[];
  private byIdMap: Map<string, Category>;
  readonly fallback: Category;

  constructor(categories: readonly Category[]) {
    if (!categories.length) throw new Error('At least one category is required');
    this.list = categories;
    this.byIdMap = new Map(categories.map((category) => [category.id, category]));
    this.fallback = categories.find((category) => category.default) ?? categories[0];
  }

  get(id: string): Category | undefined {
    return this.byIdMap.get(id);
  }

  has(id: string): boolean {
    return this.byIdMap.has(id);
  }

  /**
   * Best-guess categories for a listing that names none, from its title and
   * description. Always returns at least the fallback category.
   */
  infer(text: string): string[] {
    const haystack = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
    const scored = this.list
      .map((category) => ({
        id: category.id,
        score: category.keywords.reduce((sum, word) => (haystack.includes(` ${word} `) || haystack.includes(` ${word}s `) ? sum + 1 : sum), 0),
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return scored.length ? [scored[0].id] : [this.fallback.id];
  }
}

export const CATEGORIES = new CategoryRegistry(categoryData.categories as Category[]);
