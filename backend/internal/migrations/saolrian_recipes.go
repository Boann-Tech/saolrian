// Recipes: a named collection of ingredient rows (existing foods or manual
// entries) with a whole-number serving count, so a user can log N servings
// to their diary as one combined entry.
package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
	"github.com/pocketbase/pocketbase/tools/types"
)

func init() {
	m.Register(func(app core.App) error {
		users, err := app.FindCollectionByNameOrId("users")
		if err != nil {
			return err
		}
		foods, err := app.FindCollectionByNameOrId("foods")
		if err != nil {
			return err
		}

		// ---------------------------------------------------------------
		// recipes
		// ---------------------------------------------------------------
		recipes := core.NewBaseCollection("recipes")
		recipes.ListRule = types.Pointer(ownerRule)
		recipes.ViewRule = types.Pointer(ownerRule)
		recipes.CreateRule = types.Pointer(ownerRule)
		recipes.UpdateRule = types.Pointer(ownerRule)
		recipes.DeleteRule = types.Pointer(ownerRule)

		recipes.Fields.Add(
			&core.RelationField{Name: "user", CollectionId: users.Id, Required: true, MaxSelect: 1},
			&core.TextField{Name: "name", Required: true},
			// how many servings the recipe makes; whole integer, min 1
			&core.NumberField{Name: "servings", Required: true, Min: types.Pointer(1.0)},
			// denormalized sums of recipe_ingredients rows, kept in sync by
			// the frontend on every save (mirrors name_snapshot-style
			// denormalization used throughout this schema)
			&core.NumberField{Name: "total_kcal"},
			&core.NumberField{Name: "total_protein"},
			&core.NumberField{Name: "total_carbs"},
			&core.NumberField{Name: "total_fat"},
			&core.AutodateField{Name: "created", OnCreate: true},
			&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
		)
		if err := app.Save(recipes); err != nil {
			return err
		}

		// ---------------------------------------------------------------
		// recipe_ingredients
		// ---------------------------------------------------------------
		ingredients := core.NewBaseCollection("recipe_ingredients")
		ingredients.ListRule = types.Pointer(ownerRule)
		ingredients.ViewRule = types.Pointer(ownerRule)
		ingredients.CreateRule = types.Pointer(ownerRule)
		ingredients.UpdateRule = types.Pointer(ownerRule)
		ingredients.DeleteRule = types.Pointer(ownerRule)

		ingredients.Fields.Add(
			&core.RelationField{Name: "user", CollectionId: users.Id, Required: true, MaxSelect: 1},
			&core.RelationField{Name: "recipe", CollectionId: recipes.Id, Required: true, MaxSelect: 1, CascadeDelete: true},
			// nullable: null for a quick manual entry with no backing food
			&core.RelationField{Name: "food", CollectionId: foods.Id, MaxSelect: 1},
			&core.TextField{Name: "name_snapshot", Required: true},
			&core.TextField{Name: "brand_snapshot"},
			&core.NumberField{Name: "grams"},
			// NB: not Required — a legitimate ingredient (salt, water, a
			// zero-calorie sweetener) can be 0 kcal, and PocketBase treats a
			// required number field as "must be non-zero" (same reasoning as
			// sort_order below).
			&core.NumberField{Name: "kcal"},
			&core.NumberField{Name: "protein"},
			&core.NumberField{Name: "carbs"},
			&core.NumberField{Name: "fat"},
			// NB: not Required — PocketBase treats a required number as
			// "non-zero", but sort_order 0 (first ingredient) is valid
			// (same reasoning as meal_slots.sort_order in migrations.go).
			&core.NumberField{Name: "sort_order"},
		)
		ingredients.AddIndex("idx_recipe_ingredients_recipe_sort", false, "recipe, sort_order", "")

		return app.Save(ingredients)
	}, func(app core.App) error {
		// down migration: drop in reverse dependency order
		for _, name := range []string{"recipe_ingredients", "recipes"} {
			col, err := app.FindCollectionByNameOrId(name)
			if err != nil {
				continue
			}
			if err := app.Delete(col); err != nil {
				return err
			}
		}
		return nil
	}, "saolrian_recipes.go")
}
